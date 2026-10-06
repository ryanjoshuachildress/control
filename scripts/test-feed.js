// End-to-end test for the household feed against a throwaway DATA_DIR.
// Run: node scripts/test-feed.js
// Boots the real server on a temp port and drives register→pair→posts→
// targeting→submissions-stream→comments→deletes with plain fetch.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3212;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'control-feed-test-'));

let failures = 0;
const ok = (cond, label) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
};

function client(base = BASE) {
  let cookie = '';
  const call = async function (method, p, body, opts = {}) {
    const res = await fetch(base + p, {
      method,
      headers: Object.assign(
        cookie ? { cookie } : {},
        opts.form ? {} : body ? { 'content-type': 'application/json' } : {}),
      body: opts.form ? body : body ? JSON.stringify(body) : undefined,
      redirect: 'manual'
    });
    const sc = res.headers.get('set-cookie');
    if (sc) {
      cookie = sc.split(/,\s*(?=[A-Za-z][\w.-]+[.][\w.-]+\s*=)/).map(c => c.split(';')[0]).join('; ');
    }
    return res;
  };
  return Object.assign(call, { cookie: () => cookie });
}

const j = async (r) => { const d = await r.json().catch(() => ({})); return { status: r.status, ...d }; };
const feed = async (c) => (await j(await c('GET', '/api/feed'))).items;
const countKind = (items, kind) => items.filter(i => i.kind === kind).length;

(async () => {
  const server = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env,
      DATA_DIR: TMP,
      PORT: String(PORT),
      SESSION_SECRET: 'test-secret',
      SMTP_HOST: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });

  try {
    for (let i = 0; i < 50; i++) {
      try { const h = await fetch(`${BASE}/api/health`); if (h.ok) break; } catch {}
      await new Promise(r => setTimeout(r, 100));
    }

    // --- setup: dom + sub1 + sub2 paired at registration
    const dom = client();
    await dom('POST', '/api/auth/register', {
      email: 'dom@test.local', password: 'Passw0rd!', name: 'The Dom', role: 'dom', title: 'Sir'
    });
    const code = (await (await dom('GET', '/api/auth/me')).json()).user.invite_code;

    const sub1 = client();
    const sub2 = client();
    await sub1('POST', '/api/auth/register', {
      email: 'sub1@test.local', password: 'Passw0rd!', name: 'Sub One', role: 'sub', title: 'pet', inviteCode: code
    });
    await sub2('POST', '/api/auth/register', {
      email: 'sub2@test.local', password: 'Passw0rd!', name: 'Sub Two', role: 'sub', title: 'toy', inviteCode: code
    });
    const sub1Id = (await (await sub1('GET', '/api/auth/me')).json()).user.id;
    const sub2Id = (await (await sub2('GET', '/api/auth/me')).json()).user.id;

    // --- posts & targeting
    const p1 = await j(await dom('POST', '/api/feed', { body: 'dom broadcast one' }));
    ok(p1.ok === true, 'dom broadcast post created');
    ok(countKind(await feed(dom), 'post') === 1, 'dom sees own post');
    const f1a = await feed(sub1), f2a = await feed(sub2);
    ok(f1a.length === 1 && countKind(f1a, 'post') === 1 && f1a[0].id === p1.id, 'sub1 sees the broadcast');
    ok(f2a.length === 1 && f2a[0].id === p1.id, 'sub2 sees the broadcast');

    const p2 = await j(await dom('POST', '/api/feed', { body: 'only for sub1', target_sub_ids: [sub1Id] }));
    ok(p2.ok === true, 'targeted post created');
    let f1 = await feed(sub1);
    ok(countKind(f1, 'post') === 2, 'sub1 sees broadcast + targeted');
    ok(countKind(await feed(sub2), 'post') === 1, 'sub2 does not see the targeted post');
    let fd = await feed(dom);
    const broadcast = fd.find(i => i.id === p1.id);
    ok(countKind(fd, 'post') === 2, 'dom feed shows all household posts');
    ok(Array.isArray(broadcast.targets) && broadcast.targets.length === 2
      && broadcast.targets.every(t => [sub1Id, sub2Id].includes(t.sub_id)), 'broadcast shows 2 targets for the dom');

    // --- subs post → dom only
    const p3 = await j(await sub1('POST', '/api/feed', { body: 'from sub1' }));
    const p4 = await j(await sub2('POST', '/api/feed', { body: 'from sub2' }));
    ok(p3.ok && p4.ok, 'both subs posted');
    ok(countKind(await feed(dom), 'post') === 4, 'dom feed has all 4 posts');
    ok(countKind(await feed(sub2), 'post') === 2, 'sub2 does not see sub1 post');

    const f1b = await feed(sub1);
    const sub1Post = f1b.find(i => i.id === p3.id);
    ok(sub1Post && sub1Post.can_delete === true, 'sub sees delete on own post');
    ok(f1b.find(i => i.id === p1.id).can_delete === false, 'no delete on dom post for sub');
    const domP2 = (await feed(dom)).find(i => i.id === p2.id);
    ok(domP2.targets.length === 1 && domP2.targets[0].sub_id === sub1Id, 'targeted post shows its recipient');

    // --- late joiner does not see old broadcasts
    const sub3 = client();
    await sub3('POST', '/api/auth/register', {
      email: 'sub3@test.local', password: 'Passw0rd!', name: 'Sub Three', role: 'sub', title: 'kitten', inviteCode: code
    });
    ok((await feed(sub3)).length === 0, 'late joiner sees no old broadcasts');
    const p5 = await j(await dom('POST', '/api/feed', { body: 'dom broadcast two' }));
    ok((await feed(sub3)).length === 1, 'late joiner sees the new broadcast');

    // --- submissions flow into the stream
    const ci = await j(await sub1('POST', '/api/checkins', { mood: 7, day_rating: 8, best_part: 'x', worst_part: 'y', sexual_notes: 'z' }));
    ok(ci.ok === true, 'sub1 check-in saved');
    const task = await j(await dom('POST', '/api/tasks', { sub_id: sub1Id, title: 'Kneel daily', description: '', frequency: 'daily', completion_mode: 'checkoff' }));
    const comp = await j(await sub1('POST', `/api/tasks/${task.id}/complete`, { method: 'checkoff', note: 'done as instructed' }));
    ok(task.ok === true && comp.ok === true, 'task assigned and completed');
    const pun = await j(await dom('POST', '/api/punishments', { sub_id: sub1Id, title: 'Corner time', description: '', completion_mode: 'checkoff' }));
    const pcomp = await j(await sub1('POST', `/api/punishments/${pun.id}/complete`, { method: 'checkoff' }));
    ok(pun.ok === true && pcomp.ok === true, 'punishment assigned and completed');
    const e1 = await j(await sub1('POST', '/api/entries', { body: 'my journal thought' }));
    ok(e1.ok === true, 'sub1 wrote a journal entry');
    const e2 = await j(await dom('POST', '/api/entries', { body: 'dom private thought', share_sub_id: sub1Id }));
    ok(e2.ok === true, 'dom entry shared with sub1');

    fd = await feed(dom);
    ok(fd.length === 9, `dom feed = 5 posts + 4 submissions (got ${fd.length})`);
    const kinds = { post: 5, checkin: 1, task: 1, punishment: 1, entry: 1 };
    ok(Object.entries(kinds).every(([k, n]) => countKind(fd, k) === n), 'dom feed kinds: 5 posts, checkin, task, punishment, 1 sub entry');
    ok(fd.find(i => i.kind === 'task').task_title === 'Kneel daily', 'completion item carries the task title');
    ok(!fd.some(i => i.kind === 'entry' && i.author_id === fd.find(z => z.author_role === 'dom').author_id && i.text === 'dom private thought'), 'dom own unshared entry not in dom feed');

    const f2 = await feed(sub2);
    ok(countKind(f2, 'post') === 3 && f2.length === 3, 'sub2 feed: 3 posts, no submissions from others');
    const f1c = await feed(sub1);
    ok(f1c.length === 9, `sub1 feed = 4 posts + own submissions + shared dom entry (got ${f1c.length})`);
    ok(countKind(f1c, 'checkin') === 1 && countKind(f1c, 'task') === 1
      && countKind(f1c, 'punishment') === 1, 'sub1 sees own submissions');
    ok(countKind(f1c, 'entry') === 2, 'sub1 feed: own entry + shared dom entry');
    ok(f1c.some(i => i.kind === 'entry' && i.author_role === 'dom' && i.text === 'dom private thought'), 'shared dom entry visible to sub1');

    // --- comments. P1 is a broadcast (audience = both subs); P2 targets sub1 only.
    ok((await j(await sub2('GET', `/api/comments/post/${p2.id}`))).status === 403, 'sub2 cannot read the sub1-only thread');
    ok((await j(await sub2('POST', `/api/comments/post/${p2.id}`, { body: 'sneak' }))).status === 403, 'sub2 cannot comment there');
    thread: {
      const g = await j(await sub1('GET', `/api/comments/post/${p1.id}`));
      ok(g.status === 200 && g.comments.length === 0, 'sub1 in the thread audience');
      const c1 = await j(await sub1('POST', `/api/comments/post/${p1.id}`, { body: 'yes Sir' }));
      const c2 = await j(await dom('POST', `/api/comments/post/${p1.id}`, { body: 'good pet' }));
      const c3 = await j(await sub3('POST', `/api/comments/post/${p1.id}`, { body: 'interjecting' }));
      ok(c1.ok && c2.ok, 'audience members comment');
      ok(c3.status === 403, 'late joiner (not targeted) cannot comment');
      const after = await j(await sub1('GET', `/api/comments/post/${p1.id}`));
      ok(after.comments.length === 2, 'thread holds both comments');
      ok(after.comments.every(c => c.author_name !== 'Sub Three'), 'no interloper visible');
      ok(after.comments.every(c => c.can_delete === false), 'subs see no comment-delete flag');
      ok((await j(await sub1('DELETE', `/api/comments/id/${after.comments[0].id}`))).status === 403
        && (await j(await sub1('DELETE', `/api/comments/id/${after.comments[1].id}`))).status === 403, 'subs cannot delete comments (even their own)');
      const domDel = await j(await dom('DELETE', `/api/comments/id/${after.comments[0].id}`));
      ok(domDel.ok === true, 'dom deletes a comment in their thread');
      const after2 = await j(await sub1('GET', `/api/comments/post/${p1.id}`));
      ok(after2.comments.length === 1, 'thread shrank after dom delete');
      const bc = (await feed(dom)).find(i => i.id === p1.id);
      ok(bc.comment_count === 1, 'post comment_count reflects the dom-moderated thread');
      // comment on a check-in via the existing subject machinery
      const c4 = await j(await dom('POST', `/api/comments/checkin/${ci.checkin_id}`, { body: 'well done' }));
      ok(c4.ok === true, 'dom comments on the check-in');
      const ciItem = (await feed(sub1)).find(i => i.kind === 'checkin');
      ok(ciItem.comment_count === 1, 'checkin feed item shows the comment count');
      // and on a task completion thread (keyed by task)
      const c5 = await j(await dom('POST', `/api/comments/task/${task.id}`, { body: 'noted' }));
      ok(c5.ok === true, 'dom comments on the task thread');
      ok((await feed(dom)).find(i => i.kind === 'task').comment_count === 1, 'task item comment_count');
    }

    // --- deletes
    await sub1('DELETE', `/api/feed/${p3.id}`);
    ok(countKind(await feed(dom), 'post') === 4, 'sub deleted own post');
    ok((await j(await sub1('DELETE', `/api/feed/${p4.id}`))).status === 403, 'sub cannot delete another post');
    ok((await j(await dom('DELETE', `/api/feed/${p4.id}`))).status === 200, 'dom moderates a sub post');
    // sub4: unpaired sub post stays private (dom never sees it)
    const sub4 = client();
    await sub4('POST', '/api/auth/register', {
      email: 'sub4@test.local', password: 'Passw0rd!', name: 'Sub Four', role: 'sub', title: 'pet'
    });
    const p6 = await j(await sub4('POST', '/api/feed', { body: 'unpaired musing' }));
    ok(p6.ok === true, 'unpaired sub can post');
    const f4 = await feed(sub4);
    ok(f4.length === 1 && f4[0].id === p6.id, 'unpaired sub sees own post only');
    const fdPosts = (await feed(dom)).filter(i => i.kind === 'post');
    ok(fdPosts.length === 3 && !fdPosts.some(i => i.id === p6.id), 'unpaired sub post not in dom feed');

    // deleting a post removes its thread
    await dom('DELETE', `/api/feed/${p1.id}`);
    ok((await j(await sub1('GET', `/api/comments/post/${p1.id}`))).status === 404, 'thread gone with the post');
    const finalDom = await feed(dom);
    ok(!finalDom.some(i => i.id === p1.id), 'deleted post out of the dom feed');
    ok(finalDom.find(i => i.id === p2.id).comment_count === 0, 'other threads untouched (P2 count 0)');
    ok(countKind(finalDom, 'post') === 2, 'dom feed now has 2 posts (P2, P5)');

    console.log('--- feed email notifications (SMTP off → logged) ---');
    const mailTo = (em) => log.split('\n').filter(l => l.includes('[mail]') && l.includes(`to=${em}`)).length;
    const dom2 = await j(await dom('POST', '/api/feed', { body: 'notify broadcast' }));
    ok(dom2.ok === true, 'broadcast post for notify test');
    ok(mailTo('sub1@test.local') >= 1 && mailTo('sub2@test.local') >= 1,
      'both subs emailed on dom broadcast post');
    const b1 = mailTo('sub1@test.local'), b2 = mailTo('sub2@test.local');
    await j(await dom('POST', '/api/feed', { body: 'only sub1 (notify)', target_sub_ids: [sub1Id] }));
    ok(mailTo('sub1@test.local') === b1 + 1, 'targeted post emails the addressed sub');
    ok(mailTo('sub2@test.local') === b2, 'targeted post does not email anyone else');

    // opt-out: sub2 turns email_notifications off
    const me2 = (await (await sub2('GET', '/api/auth/me')).json()).user;
    await sub2('PATCH', '/api/auth/me', {
      name: me2.name, title: me2.title, timezone: me2.timezone, email_notifications: false
    });
    const b2b = mailTo('sub2@test.local'), b1b = mailTo('sub1@test.local');
    await j(await dom('POST', '/api/feed', { body: 'broadcast after opt-out' }));
    ok(mailTo('sub2@test.local') === b2b, 'opted-out sub gets no post email');
    ok(mailTo('sub1@test.local') === b1b + 1, 'subscribed sub still gets it');

    // sub posts → the dom hears
    const bDom = mailTo('dom@test.local');
    await j(await sub1('POST', '/api/feed', { body: 'sir, a note for you' }));
    ok(mailTo('dom@test.local') === bDom + 1, 'dom emailed on sub post');

    // comments on a feed post already notify the rest of the audience
    await j(await sub1('POST', `/api/comments/post/${dom2.id}`, { body: 'replying, Sir' }));
    ok(mailTo('dom@test.local') === bDom + 2, 'dom emailed on sub comment (comment machinery)');

    const c9 = await j(await dom('POST', `/api/comments/post/${p2.id}`, { body: 'see this pet' }));
    const c9n = mailTo('sub1@test.local');
    ok(c9.ok === true && c9n > 0, 'targeted sub emailed on dom comment');

    console.log('--- media attachments ---');
    // 1x1 transparent PNG + a stub mp4 (only the extension matters server-side)
    const PNG = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64');
    const MP4 = Buffer.alloc(64, 1);

    const fd1 = new FormData();
    fd1.append('body', 'look, media!');
    fd1.append('media', new Blob([PNG], { type: 'image/png' }), 'shot.png');
    fd1.append('media', new Blob([MP4], { type: 'video/mp4' }), 'clip.mp4');
    const pm = await j(await dom('POST', '/api/feed', fd1, { form: true }));
    ok(pm.ok === true, 'post with image + video created');
    const pmItem = (await feed(dom)).find(i => i.id === pm.id);
    ok(pmItem && pmItem.attachments && pmItem.attachments.length === 2, 'feed item carries 2 attachments');
    ok(pmItem.attachments.some(a => a.media === 'image') && pmItem.attachments.some(a => a.media === 'video'),
      'media kinds detected (image + video)');
    ok(pmItem.attachments.every(a => a.path.startsWith('fp-')), 'attachment files use the fp- prefix');
    ok(pmItem.attachments.every(a => fs.existsSync(path.join(TMP, 'uploads', a.path))),
      'attachment files exist on disk');

    // targeted-only post: recipient can view the file, other subs cannot
    const fd2 = new FormData();
    fd2.append('body', 'for sub1 only');
    fd2.append('media', new Blob([PNG], { type: 'image/png' }), 'secret.png');
    fd2.append('target_sub_ids', sub1Id);
    const pt = await j(await dom('POST', '/api/feed', fd2, { form: true }));
    const ptItem = (await feed(dom)).find(i => i.id === pt.id);
    ok(pt.ok === true && ptItem.attachments.length === 1, 'targeted post with attachment created');
    ok((await (await sub1('GET', `/uploads/${ptItem.attachments[0].path}`)).status) === 200,
      'targeted sub can view the attachment');
    ok((await (await sub2('GET', `/uploads/${ptItem.attachments[0].path}`)).status) === 403,
      'untargeted sub cannot view the attachment');
    ok((await (await dom('GET', `/uploads/${ptItem.attachments[0].path}`)).status) === 200,
      'the household dom can view the attachment');

    const fd3 = new FormData();
    fd3.append('media', new Blob([PNG], { type: 'image/png' }), 'just.png');
    const pp = await j(await sub1('POST', '/api/feed', fd3, { form: true }));
    ok(pp.ok === true, 'photo-only post (no text) works');

    const fd4 = new FormData();
    fd4.append('body', 'sneaky');
    fd4.append('media', new Blob([Buffer.alloc(16)], { type: 'text/plain' }), 'note.txt');
    ok((await j(await dom('POST', '/api/feed', fd4, { form: true }))).status === 400,
      'disallowed extension rejected with 400');

    const fd5 = new FormData();
    fd5.append('body', 'too many');
    for (let k = 0; k < 11; k++) fd5.append('media', new Blob([PNG], { type: 'image/png' }), `k${k}.png`);
    ok((await j(await dom('POST', '/api/feed', fd5, { form: true }))).status === 400,
      'more than 10 attachments rejected with 400');

    await dom('DELETE', `/api/feed/${pm.id}`);
    ok(pmItem.attachments.every(a => !fs.existsSync(path.join(TMP, 'uploads', a.path))),
      'deleting the post unlinks its media files');

    console.log('--- per-file cap (MAX_UPLOAD_MB=1 server) ---');
    const PORT2 = 3213;
    const BASE2 = `http://127.0.0.1:${PORT2}`;
    const TMP2 = fs.mkdtempSync(path.join(os.tmpdir(), 'control-cap-test-'));
    const second = spawn(process.execPath, ['src/server.js'], {
      env: { ...process.env, DATA_DIR: TMP2, PORT: String(PORT2), SESSION_SECRET: 'cap-test', SMTP_HOST: '', MAX_UPLOAD_MB: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    try {
      for (let i = 0; i < 50; i++) {
        try { const h = await fetch(`${BASE2}/api/health`); if (h.ok) break; } catch {}
        await new Promise(r => setTimeout(r, 100));
      }
      const capc = client(BASE2);
      await capc('POST', '/api/auth/register', { email: 'a@test.local', password: 'Passw0rd!', name: 'A', role: 'dom' });
      const big = new FormData();
      big.append('body', 'big pic');
      big.append('media', new Blob([Buffer.alloc(2 * 1024 * 1024)], { type: 'image/png' }), 'big.png');
      const r = await j(await capc('POST', '/api/feed', big, { form: true }));
      ok(r.status === 400 && /too large/i.test(r.error || ''),
        `over-cap upload rejected with a clear error (got ${r.status} ${r.error || ''})`);
    } finally {
      second.kill();
      try { fs.rmSync(TMP2, { recursive: true, force: true }); } catch {}
    }

    console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
  } catch (e) {
    console.error('TEST CRASH:', e);
    failures++;
  } finally {
    server.kill();
    if (log && failures) console.log('--- server log ---\n' + log.slice(-2000));
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
    process.exit(failures ? 1 : 0);
  }
})();