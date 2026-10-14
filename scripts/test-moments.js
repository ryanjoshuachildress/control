// End-to-end test for Moments + the household cross-submissive switch
// against a throwaway DATA_DIR. Run: node scripts/test-moments.js
// Boots the real server on a temp port and drives register→pair→create→
// record-your-version→lock/unlock→tags→feed audiences with plain fetch.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// --- mock Immich: two assets with per-key access, mimicking per-user libraries
const IMIMG = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';   // IMAGE — keyA (household env key)
const IMVID = 'ffffffff-0000-4000-8000-123456789abc';   // VIDEO — only 'subkey'
const PNGB = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const MP4B = Buffer.alloc(256, 7);
const visibleTo = (id, key) => [
  { asset: IMIMG, key: 'keyA' }, { asset: IMVID, key: 'subkey' }
].some(r => r.asset === id && r.key === key);
const mockImmich = http.createServer((req, res) => {
  const key = req.headers['x-api-key'];
  if (req.method === 'GET' && req.url.startsWith('/api/users/me')) {
    if (!key) { res.writeHead(401); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ id: 'mu' }));
  }
  const idm = req.url.match(/\/api\/assets\/([0-9a-fA-F-]+)(\/(\w+))?/);
  if (req.method === 'GET' && idm) {
    const [, id] = idm;
    if (!visibleTo(id, key)) { res.writeHead(404); return res.end(); }
    if ((idm[3] || 'meta') === 'meta') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id, type: id === IMVID ? 'VIDEO' : 'IMAGE' }));
    }
    const isOrig = idm[3] === 'original';
    res.writeHead(200, { 'content-type': id === IMVID ? 'video/mp4' : 'image/png' });
    return res.end(isOrig ? MP4B : PNGB);
  }
  if (req.method === 'POST' && req.url.startsWith('/api/search/metadata')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    const items = [];
    if (visibleTo(IMIMG, key)) items.push({ id: IMIMG, type: 'IMAGE' });
    if (visibleTo(IMVID, key)) items.push({ id: IMVID, type: 'VIDEO' });
    return res.end(JSON.stringify({ assets: { items } }));
  }
  res.writeHead(404); res.end();
});

const PORT = 3216;
const IMPORT = 3271;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'control-moments-test-'));

let failures = 0;
const ok = (cond, label) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
};

function client() {
  let cookie = '';
  const call = async function (method, p, body, opts = {}) {
    const res = await fetch(BASE + p, {
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
  return Object.assign(call, {});
}

const j = async (r) => { const d = await r.json().catch(() => ({})); return { status: r.status, ...d }; };
const groups = async (c, qs = '') => (await j(await c('GET', '/api/moments' + qs))).groups;
const words = (n, w = 'w') => new Array(n).fill(w).join(' ');
const V = (over = {}) => Object.assign({
  summary: 'It was intense and good.', best_part: 'the moment right after',
  worst_part: 'getting a cramp', again: 'yes',
  r_originality: 4, r_hotness: 5, r_surprise: 3, r_connection: 5
}, over);

(async () => {
  await new Promise(r => mockImmich.listen(IMPORT, () => r()));
  await new Promise(r => setTimeout(r, 200));
  const server = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env,
      DATA_DIR: TMP, PORT: String(PORT), SESSION_SECRET: 'test-secret', SMTP_HOST: '',
      IMMICH_URL: `http://127.0.0.1:${IMPORT}`, IMMICH_KEY: 'keyA'
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

    // --- setup: dom + sub1 + sub2 + sub3 (sub3 stays unpaired until later)
    const dom = client();
    await dom('POST', '/api/auth/register', {
      email: 'dom@test.local', password: 'Passw0rd!', name: 'The Dom', role: 'dom', title: 'Sir'
    });
    const code = (await (await dom('GET', '/api/auth/me')).json()).user.invite_code;
    const sub1 = client();
    const sub2 = client();
    const sub3 = client();
    await sub1('POST', '/api/auth/register', { email: 's1@test.local', password: 'Passw0rd!', name: 'Sub One', role: 'sub', title: 'pet', inviteCode: code });
    await sub2('POST', '/api/auth/register', { email: 's2@test.local', password: 'Passw0rd!', name: 'Sub Two', role: 'sub', title: 'toy', inviteCode: code });
    await sub3('POST', '/api/auth/register', { email: 's3@test.local', password: 'Passw0rd!', name: 'Sub Three', role: 'sub', title: 'kitten', inviteCode: code });
    const sub1Id = (await (await sub1('GET', '/api/auth/me')).json()).user.id;
    const sub2Id = (await (await sub2('GET', '/api/auth/me')).json()).user.id;
    const sub3Id = (await (await sub3('GET', '/api/auth/me')).json()).user.id;

    // --- validations
    ok((await j(await dom('POST', '/api/moments', { ...V(), title: '' }))).status === 400, 'empty title rejected');
    ok((await j(await dom('POST', '/api/moments', { ...V(), title: 'x'.repeat(51), date: '2026-10-08' }))).status === 400, 'title > 50 rejected');
    ok((await j(await dom('POST', '/api/moments', { ...V(), title: 'ok', date: 'not-a-date' }))).status === 400, 'bad date rejected');
    ok((await j(await dom('POST', '/api/moments', { ...V(), title: 'ok', date: '2026-10-08', time: '25:99' }))).status === 400, 'bad time rejected');
    ok((await j(await dom('POST', '/api/moments', { ...V(), title: 'ok', date: '2026-10-08', description: 'x'.repeat(161) }))).status === 400, 'description > 160 rejected');
    ok((await j(await dom('POST', '/api/moments', { ...V(), title: 'ok', date: '2026-10-08', summary: words(2001) }))).status === 400, 'summary > 2000 words rejected');
    ok((await j(await dom('POST', '/api/moments', { ...V(), title: 'ok', date: '2026-10-08', best_part: words(101) }))).status === 400, 'best > 100 words rejected');
    ok((await j(await dom('POST', '/api/moments', { ...V(), title: 'ok', date: '2026-10-08', worst_part: words(101) }))).status === 400, 'not-so-good > 100 words rejected');
    ok((await j(await dom('POST', '/api/moments', { ...V(), title: 'ok', date: '2026-10-08', review: 'x'.repeat(181) }))).status === 400, 'review > 180 chars rejected');
    ok((await j(await dom('POST', '/api/moments', { ...V({ again: 'maybe' }), title: 'ok', date: '2026-10-08' }))).status === 400, 'again must be yes/no');
    ok((await j(await dom('POST', '/api/moments', { ...V({ r_hotness: 6 }), title: 'ok', date: '2026-10-08' }))).status === 400, 'rating > 5 rejected');
    ok((await j(await dom('POST', '/api/moments', { ...V({ r_connection: null }), title: 'ok', date: '2026-10-08' }))).status === 400, 'missing rating rejected');
    ok((await j(await dom('POST', '/api/moments', { ...V(), title: 'ok', date: '2026-10-08', planned_kind: 'other' }))).status === 400, '"other" without text rejected');

    // --- dom creates a shared moment involving sub1 + sub2
    const m1 = await j(await dom('POST', '/api/moments', {
      ...V({ summary: 'Rope session, deep headspace.', again: 'yes' }),
      title: 'Rope session', description: 'Two hours, very quiet', date: '2026-10-07', time: '21:30',
      planned_kind: 'spontaneous', people_dom: '1', sub_ids: [sub1Id, sub2Id],
      tags: 'rope, wax'
    }));
    ok(m1.ok === true, 'dom created a shared moment');
    const m1id = m1.id;

    let gd = (await groups(dom))[0];
    ok(gd && gd.title === 'Rope session', 'dom lists the moment');
    ok(gd.pending.length === 2 && gd.pending.some(p => p.name === 'Sub One') && gd.pending.some(p => p.name === 'Sub Two'), 'dom sees both subs waiting to record');
    ok(gd.people.subs.length === 2 && gd.people.dom_involved === true, 'people list carries both subs + dom');
    ok(gd.tags.length === 2 && gd.tags.every(t => t.status === 'approved'), 'dom-typed tags are approved');
    ok(gd.versions.length === 1 && gd.versions[0].ratings.hotness === 5, "dom's version present with ratings");
    ok(gd.versions[0].name === 'The Dom' && gd.versions[0].title === 'Sir', 'versions carry author label fields');
    ok(gd.planned.kind === 'spontaneous', 'planned kind stored');

    // --- both subs prompted: locked until they record
    let g1 = (await groups(sub1))[0];
    ok(!!g1 && g1.needs_record === true && g1.can_record === true, 'sub1 prompted to record');
    ok(g1.versions.length === 1 && g1.versions[0].locked === true && !g1.versions[0].summary, 'dom version locked (no content leak) for sub1');
    const g2 = (await groups(sub2))[0];
    ok(g2.needs_record === true, 'sub2 prompted to record');
    ok((await groups(sub3)).length === 0, 'sandboxed: sub not involved sees nothing');

    // sub1 previews detail — still locked
    const d1 = await j(await sub1('GET', `/api/moments/${m1id}`));
    ok(d1.group.versions[0].locked === true, 'detail view keeps the lock');

    // --- sub1 records; wrong ratings first
    ok((await j(await sub1('POST', `/api/moments/${m1id}/version`, V({ r_originality: 0 })))).status === 400, 'sub version rating 0 rejected');
    const v1 = await j(await sub1('POST', `/api/moments/${m1id}/version`, V({ summary: 'From my side: overwhelming, in a good way.', again: 'yes' })));
    ok(v1.ok === true, 'sub1 recorded their version');
    ok((await j(await sub1('POST', `/api/moments/${m1id}/version`, V()))).status === 409, 'second version rejected (409)');

    g1 = (await groups(sub1))[0];
    ok(g1.pending.length === 0, 'pending list is not exposed to submissives');
    ok((await groups(dom))[0].pending.length === 1 && (await groups(dom))[0].pending[0].name === 'Sub Two', 'dom sees sub2 still pending');
    const domVer = g1.versions.find(v => v.author_role === 'dom');
    ok(domVer && domVer.locked === undefined && domVer.summary === 'Rope session, deep headspace.', 'recording unlocked the dom version');
    // still sandboxed from sub2's version
    ok(g1.versions.every(v => v.author_id !== sub2Id), 'sub1 cannot see sub2 version yet (interaction off)');
    // sub2 still locked (their own version missing)
    ok((await groups(sub2))[0].needs_record === true, 'sub2 still prompted');

    // sub2 records → sees own + dom's, but NOT sub1's (sandboxing)
    const v2 = await j(await sub2('POST', `/api/moments/${m1id}/version`, V({ summary: 'Mine: floaty and safe.', again: 'yes' })));
    ok(v2.ok === true, 'sub2 recorded their version');
    const g2b = (await groups(sub2))[0];
    const sub1Stub = g2b.versions.find(v => v.author_id === sub1Id);
    ok(g2b.versions.length === 3 && g2b.versions.find(v => v.author_id === sub1Id).locked === true,
      'sub2 sees sub1 exists but their content stays sealed (interaction off)');
    ok((await groups(dom))[0].pending.length === 0, 'pending clears once everyone recorded');

    // --- dom flips the household switch → subs read each other
    const turnOn = await j(await dom('PATCH', '/api/auth/me', {
      name: 'The Dom', title: 'Sir', timezone: 'UTC', email_notifications: true, allow_sub_interaction: true
    }));
    ok(turnOn.user && turnOn.user.allow_sub_interaction === true, 'dom turned interaction on');
    const g1on = (await groups(sub1))[0];
    ok(g1on.versions.length === 3, 'now sub1 sees dom + sub1 + sub2 versions');
    const g3 = (await groups(sub3));
    ok(g3.length === 0, 'sub3 still sees nothing (not in the group even with interaction on)');

    const subVer = g1on.versions.find(v => v.author_id === sub2Id);
    ok(subVer.summary === 'Mine: floaty and safe.', 'unlocked sub version carries content');

    // --- sub-created moment: dom reads it, sub3 doesn't
    const m2 = await j(await sub1('POST', '/api/moments', {
      ...V({ summary: 'A note about our quiet evening.' }),
      title: 'Quiet evening', description: 'Movie + dessert', date: '2026-10-08',
      planned_kind: 'planned', people_dom: '1', tags: 'date night'
    }));
    ok(m2.ok === true, 'sub1 created own moment (dom only involved)');
    ok((await groups(sub2)).every(g => g.id !== m2.id), 'other subs cannot see sub-created moment');
    ok((await groups(dom)).some(g => g.id === m2.id), 'dom sees sub-created moments');
    ok((await j(await sub1('GET', `/api/moments/${m2.id}`))).group.needs_record === false, 'sub creator not prompted (their version exists)');

    // --- media attachments on a moment (multipart)
    const PNG = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64');
    const MP4 = Buffer.alloc(64, 1);
    const fd1 = new FormData();
    fd1.append('title', 'Water photoshoot');
    fd1.append('date', '2026-10-09');
    fd1.append('planned_kind', 'planned');
    fd1.append('summary', 'Wet, gorgeous, cold.');
    fd1.append('best_part', 'her laugh'); fd1.append('worst_part', 'the cold');
    fd1.append('again', 'yes');
    for (const k of ['r_originality', 'r_hotness', 'r_surprise', 'r_connection']) fd1.append(k, '4');
    fd1.append('media', new Blob([PNG], { type: 'image/png' }), 'a.png');
    fd1.append('media', new Blob([MP4], { type: 'video/mp4' }), 'b.mp4');
    fd1.append('sub_ids', sub1Id);
    fd1.append('sub_ids', sub2Id);
    fd1.append('people_dom', '1');
    const m3 = await j(await dom('POST', '/api/moments', fd1, { form: true }));
    ok(m3.ok === true, 'multipart moment with media created');
    const m3g = (await groups(dom)).find(g => g.id === m3.id);
    ok(m3g.versions[0].attachments.length === 2, 'two attachments on the version');
    ok(m3g.versions[0].attachments.every(a => a.path.startsWith('mt-')), 'moment files use the mt- prefix');
    ok(m3g.versions[0].attachments.some(a => a.media === 'video') && m3g.versions[0].attachments.some(a => a.media === 'image'), 'media kinds detected');
    const attPath = m3g.versions[0].attachments[0].path;
    ok((await (await sub1('GET', `/uploads/${attPath}`)).status) === 403, 'locked: sub without own version blocked from mt- file');
    const sv1 = await j(await sub1('POST', `/api/moments/${m3.id}/version`, { summary: 'my side of the water', best_part: 'a', worst_part: 'b', again: 'yes', r_originality: 3, r_hotness: 3, r_surprise: 3, r_connection: 3 }));
    ok(sv1.ok === true, 'sub1 recorded version on the media moment');
    const m3sub = (await groups(sub1)).find(g => g.id === m3.id);
    const domV = m3sub.versions.find(v => v.author_role === 'dom');
    ok(domV && domV.attachments[0], 'after recording, sub reads dom attachments');
    ok((await (await sub1('GET', `/uploads/${attPath}`)).status) === 200, 'unlocked: sub can fetch dom version media');
    ok((await (await sub2('GET', `/uploads/${attPath}`)).status) === 403, 'sub2 blocked (own version not recorded)');
    ok((await (await sub3('GET', `/uploads/${attPath}`)).status) === 403, 'sub3 blocked (not in group)');
    ok((await (await dom('GET', `/uploads/${attPath}`)).status) === 200, 'dom can fetch moment media');
    const sv2 = await j(await sub2('POST', `/api/moments/${m3.id}/version`, { summary: 'water was cold', best_part: 'a', worst_part: 'b', again: 'yes', r_originality: 3, r_hotness: 3, r_surprise: 3, r_connection: 3 }));
    ok(sv2.ok === true, 'sub2 recorded version on the media moment');
    ok((await (await sub2('GET', `/uploads/${attPath}`)).status) === 200, 'after sub2 records, media opens');

    ok((await j(await sub1('DELETE', `/api/moments/${m3.id}`))).status === 403, 'sub cannot delete a dom moment');
    await dom('DELETE', `/api/moments/${m3.id}`);
    ok((await groups(dom)).every(g => g.id !== m3.id), 'dom deleted the moment');
    ok((await groups(sub1)).every(g => g.id !== m3.id), 'gone for sub1 too');
    const leftover = fs.readdirSync(path.join(TMP, 'uploads')).map(f => f.startsWith('mt-')).length;
    ok(leftover === 0, 'deleting a moment unlinks its media files');

    // --- tags: pending for subs, dom approves/renames/deletes
    const t1 = await j(await sub2('POST', '/api/moments/tags', { name: 'tease' }));
    ok(t1.ok === true && t1.tag.status === 'pending', 'sub-typed tag goes pending');
    ok((await j(await sub2('POST', '/api/moments/tags', { name: 'wax' }))).status === 409, 'duplicate tag rejected (409)');
    ok((await j(await sub2('PATCH', '/api/moments/tags/' + t1.tag.id, { name: 'nope' }))).status === 403, 'sub cannot rename');
    ok((await j(await sub2('POST', '/api/moments/tags/' + t1.tag.id + '/approve'))).status === 403, 'sub cannot approve');
    const m2tag = await j(await sub1('POST', `/api/moments/${m2.id}/tags`, { tags: 'tease, extra' }));
    ok(m2tag.ok === true && m2tag.added.length === 2, 'attaching tags after the fact works');
    const tg = (await j(await dom('GET', `/api/moments/${m2.id}`))).group.tags.map(t => t.name);
    ok(tg.length === 3 && tg.includes('tease') && tg.includes('extra') && tg.includes('date night'), 'moment carries the added tags (plus its original)');
    const rid = (await (await dom('GET', '/api/moments/' + m2.id)).json());
    const extraId = rid.group.tags.find(t => t.name === 'extra').id;
    ok((await j(await sub1('DELETE', `/api/moments/${m2.id}/tags/${extraId}`))).ok === true, 'tag detached from a moment');
    // approve 'tease' — dom route
    const app = await j(await dom('POST', '/api/moments/tags/' + t1.tag.id + '/approve'));
    ok(app.ok === true, 'dom approved pending tag');
    const after = (await (await dom('GET', '/api/auth/me')).json());
    ok(after.user.allow_sub_interaction === true, 'dom switch persisted');
    let lst = (await j(await dom('GET', '/api/moments'))).tags;
    ok(lst.tags.some(t => t.name === 'tease'), 'approved tag joined the master list');
    ok(lst.pending.some(t => t.name === 'extra') && lst.pending.some(t => t.name === 'date night')
      && lst.pending.length === 2, 'sub-typed tags wait pending (extra + date night)');
    await dom('DELETE', `/api/moments/tags/${lst.pending.find(t => t.name === 'extra').id}`); // clean up 'extra'
    const ropeTag = lst.tags.find(t => t.name === 'rope');
    await dom('PATCH', `/api/moments/tags/${ropeTag.id}`, { name: 'shibari' });
    const gAfterRename = (await j(await dom('GET', `/api/moments/${m1id}`))).group;
    ok(gAfterRename.tags.some(t => t.name === 'shibari'), 'renaming a tag updates moments that use it');
    await dom('PATCH', `/api/moments/tags/${ropeTag.id}`, { name: 'rope' }); // rename back
    // pending tag merging into an existing approved name
    const pend2 = await j(await sub1('POST', '/api/moments/tags', { name: 'ROPE' }));
    ok(pend2.status === 409, 'case-insensitive duplicate pending rejected (409)');
    const p2 = await j(await sub1('POST', '/api/moments/tags', { name: 'wax' }));
    ok(p2.status === 409, 'duplicate under different case rejected');

    // --- delete own moment
    ok((await j(await sub2('DELETE', `/api/moments/${m1id}`))).status === 403, 'member sub cannot delete the group');
    ok((await j(await sub1('DELETE', `/api/moments/${m2.id}`))).ok === true, 'creator sub deletes own moment');
    ok((await groups(dom)).every(g => g.id !== m2.id), 'deleted for dom too');

    // --- search + tag filter
    await dom('POST', '/api/moments', {
      ...V({ summary: 'silk scarves this time' }), title: 'Scarf hour', date: '2026-10-05', time: '22:00',
      planned_kind: 'planned', people_dom: '1', tags: 'silk'
    });
    ok((await groups(dom, '?q=silk')).length === 1, 'search finds by summary text');
    ok((await groups(dom, '?q=scarf')).length === 1, 'search finds by title');
    const silkTag = (await j(await dom('GET', '/api/moments'))).tags.tags.find(t => t.name === 'silk');
    ok((await groups(dom, `?tag_id=${silkTag.id}`)).length === 1, 'tag filter narrows to tagged moments');
    ok((await groups(dom, '?q=zzzznotfound')).length === 0, 'no results for garbage query');

    console.log('--- moment notifications (SMTP off → logged) ---');
    const mailTo = (em) => log.split('\n').filter(l => l.includes('[mail]') && l.includes(`to=${em}`)).length;
    const pre1 = mailTo('s1@test.local'), pre2 = mailTo('s2@test.local'), preD = mailTo('dom@test.local');
    await dom('POST', '/api/moments', {
      ...V(), title: 'Notify test', date: '2026-10-09', planned_kind: 'planned',
      people_dom: '1', sub_ids: [sub1Id, sub2Id]
    });
    ok(mailTo('s1@test.local') === pre1 + 1, 'involved sub emailed on new shared moment');
    ok(mailTo('s2@test.local') === pre2 + 1, 'other involved sub emailed too');
    await sub3('POST', '/api/moments', {
      ...V(), title: 'Sub-made moment', date: '2026-10-09', planned_kind: 'planned', people_dom: '1'
    });
    ok(mailTo('dom@test.local') === preD + 1, 'dom emailed on sub-created moment');

    console.log('--- feed household-wide posts (interaction switch) ---');
    // switch stays ON from earlier
    const h1 = await j(await sub1('POST', '/api/feed', { body: 'hello everyone', audience: 'household' }));
    ok(h1.ok === true, 'household-wide sub post accepted (switch on)');
    let f2 = await j(await sub2('GET', '/api/feed'));
    ok(f2.items.some(i => i.kind === 'post' && i.text === 'hello everyone'), 'sub2 sees sub1 household post');
    ok((await j(await sub2('POST', `/api/comments/post/${h1.id}`, { body: 'hi!' }))).ok === true, 'sub2 can join the thread');
    const priv = await j(await sub1('POST', '/api/feed', { body: 'private to sir' }));
    ok(priv.ok === true, 'dom-only sub post accepted');
    ok(!(await j(await sub2('GET', '/api/feed'))).items.some(i => i.text === 'private to sir'), 'dom-only post stays sandboxed');
    const hh2 = await j(await sub2('POST', '/api/feed', { body: 'household from sub2', audience: 'household' }));
    ok(hh2.ok === true && (await j(await sub1('GET', '/api/feed'))).items.some(i => i.text === 'household from sub2'), 'symmetric visibility');
    // dom turns interaction OFF → household-wide posts fold back to dom-only reads
    await dom('PATCH', '/api/auth/me', { name: 'The Dom', title: 'Sir', timezone: 'UTC', email_notifications: true, allow_sub_interaction: false });
    const f2off = await j(await sub2('GET', '/api/feed'));
    ok(!f2off.items.some(i => i.text === 'hello everyone'), 'sub2 loses household posts when dom turns interaction off');
    ok((await j(await sub2('GET', `/api/comments/post/${h1.id}`))).status === 403, 'thread seals when interaction is off');
    // sub cannot opt their own post into household-wide with switch off
    ok((await j(await sub1('POST', '/api/feed', { body: 'sneaky', audience: 'household' }))).ok === true
      && !(await j(await sub2('GET', '/api/feed'))).items.some(i => i.text === 'sneaky'),
      'household audience ignored while switch off (post stays dom-only)');

    console.log('--- comments on moments ---');
    const cPreDom = mailTo('dom@test.local');
    const cm1 = await j(await sub1('POST', `/api/comments/moment/${m1id}`, { body: 'that night was warm' }));
    ok(cm1.ok === true, 'sub comments on the shared moment');
    const cm1read = await j(await sub2('GET', `/api/comments/moment/${m1id}`));
    ok(cm1read.status === 200 && cm1read.comments.length === 1, 'group member reads the moment thread');
    ok((await j(await sub3('GET', `/api/comments/moment/${m1id}`))).status === 403, 'sub outside the group blocked from the moment thread');
    ok(mailTo('dom@test.local') === cPreDom + 1, 'dom emailed on a moment comment');

    console.log('--- editing your version ---');
    const ed1 = await j(await sub1('PUT', `/api/moments/${m1id}/version`, {
      summary: 'From my side — edited: overwhelming.', best_part: 'x', worst_part: 'y', again: 'yes',
      r_originality: 4, r_hotness: 5, r_surprise: 3, r_connection: 5
    }));
    ok(ed1.ok === true, 'author edits their version');
    let g1e = (await groups(sub1))[0];
    ok(g1e.versions.find(v => v.author_id === sub1Id).summary.includes('edited'), 'the edit shows in the list');
    ok((await j(await sub1('PUT', `/api/moments/${m1id}/version`, V({ r_connection: null })))).status === 400, 'edit re-validates ratings');
    await sub2('PUT', `/api/moments/${m1id}/version`, {
      summary: 'sub2 edited their own', best_part: 'x', worst_part: 'y', again: 'yes',
      r_originality: 4, r_hotness: 4, r_surprise: 4, r_connection: 4
    });
    let g2e = (await groups(sub2))[0];
    ok(g2e.versions.find(v => v.mine).summary === 'sub2 edited their own', 'each author edits only their own version');

    console.log('--- attachment management on a version ---');
    const fd4 = new FormData();
    fd4.append('title', 'Photo moment'); fd4.append('date', '2026-10-09'); fd4.append('planned_kind', 'planned');
    fd4.append('summary', 'with pic'); fd4.append('best_part', 'a'); fd4.append('worst_part', 'b');
    fd4.append('again', 'yes');
    for (const k of ['r_originality', 'r_hotness', 'r_surprise', 'r_connection']) fd4.append(k, '4');
    fd4.append('media', new Blob([PNG], { type: 'image/png' }), 'p1.png');
    fd4.append('sub_ids', sub1Id);
    const m4 = await j(await dom('POST', '/api/moments', fd4, { form: true }));
    const m4g = (await groups(dom)).find(g => g.id === m4.id);
    const domId2 = (await (await dom('GET', '/api/auth/me')).json()).user.id;
    const att = m4g.versions.find(v => v.author_id === domId2).attachments[0];
    ok(att && att.path.startsWith('mt-'), 'dom version carries the mt- file');
    ok((await (await sub1('DELETE', `/api/moments/${m4.id}/attachments/${att.id}`))).status === 403, 'non-author cannot remove the file');
    ok((await (await dom('DELETE', `/api/moments/${m4.id}/attachments/${att.id}`))).ok === true, 'author removes their file');
    ok(!fs.existsSync(path.join(TMP, 'uploads', att.path)), 'removed file unlinked from disk');
    await sub1('POST', `/api/moments/${m4.id}/version`, { summary: 'my take', best_part: 'a', worst_part: 'b', again: 'yes', r_originality: 3, r_hotness: 3, r_surprise: 3, r_connection: 3 });
    const fd5 = new FormData();
    fd5.append('summary', 'edited with a new photo'); fd5.append('best_part', 'a'); fd5.append('worst_part', 'b');
    fd5.append('again', 'yes');
    for (const k of ['r_originality', 'r_hotness', 'r_surprise', 'r_connection']) fd5.append(k, '4');
    fd5.append('media', new Blob([PNG], { type: 'image/png' }), 'p2.png');
    const ed5 = await j(await sub1('PUT', `/api/moments/${m4.id}/version`, fd5, { form: true }));
    ok(ed5.ok === true, 'multipart edit accepted');
    const m4s = (await groups(sub1)).find(g => g.id === m4.id);
    ok(m4s.versions.find(v => v.mine).attachments.length === 1, 'editing appended the new photo');

    console.log('--- recap: yearly + monthly ---');
    await dom('POST', '/api/moments', {
      ...V(), title: 'November memory', date: '2025-11-01', planned_kind: 'planned'
    });
    const rcap = await j(await dom('GET', '/api/moments/recap?year=2026'));
    // dom-visible 2026 moments: m1, Sub-made, Notify test, Photo moment, Scarf hour
    ok(rcap.status === 200 && rcap.total === 5, `yearly recap totals 5 (got ${rcap.total})`);
    ok(rcap.buckets.map(b => b.n).reduce((a, b) => a + b, 0) === 5, 'month buckets sum to the total');
    ok(rcap.avg.hotness > 0 && rcap.avg.originality > 0, 'average ratings computed');
    ok(rcap.again_pct === 100, 'again percentage 100 (every version said yes)');
    ok(rcap.tags.some(t => t.name === 'silk') && rcap.tags.some(t => t.name === 'rope'), 'top tags listed');
    ok(rcap.top.length >= 1 && rcap.top[0].avg >= rcap.top[rcap.top.length - 1].avg, 'top-rated list ordered');
    const rcapM = await j(await dom('GET', '/api/moments/recap?year=2025&mode=month&month=11'));
    ok(rcapM.mode === 'month' && rcapM.total === 1 && rcapM.buckets.length === 1 && rcapM.buckets[0].bucket === 1,
      'monthly recap scopes to November 2025 with a day bucket');
    ok(rcap.years.includes('2025') && rcap.years.includes('2026'), 'recap year list covers both years');
    const rcapSub2 = await j(await sub2('GET', '/api/moments/recap?year=2026'));
    ok(rcapSub2.total === 2, 'sub recap counts only moments they are in (m1 + Notify test)');
    const rcapSub3 = await j(await sub3('GET', '/api/moments/recap?year=2026'));
    ok(rcapSub3.total === 1, 'sub3 recap counts their own only');

    console.log('--- Immich linking ---');
    // dom creates a moment linking a library asset (env key resolves it)
    const im1 = await j(await dom('POST', '/api/moments', {
      ...V({ summary: 'linked from Immich' }), title: 'Immich moment', date: '2026-10-09',
      planned_kind: 'planned', people_dom: '1', sub_ids: [sub1Id], immich: IMIMG
    }));
    ok(im1.ok === true, 'moment created with an Immich link');
    ok((await j(await dom('POST', '/api/moments', {
      ...V(), title: 'bad', date: '2026-10-09', planned_kind: 'planned', immich: 'cafe0000-0000-4000-8000-deadbeefcafe'
    }))).status === 400, 'inaccessible Immich asset rejected with 400');
    ok((await j(await dom('POST', '/api/moments', {
      ...V(), title: 'bad url', date: '2026-10-09', planned_kind: 'planned', immich: `https://immich.frogstown.com/photos/${IMIMG}`
    }))).ok === true, 'pasted Immich URL parsed for its asset id');
    const im1g = (await groups(dom)).find(g => g.id === im1.id);
    const domId3 = (await (await dom('GET', '/api/auth/me')).json()).user.id;
    const imAtt = ((im1g.versions.find(v => v.author_id === domId3) || {}).attachments || []).find(a => a.immich);
    ok(imAtt && imAtt.asset_id === IMIMG && imAtt.media === 'image', 'list carries the immich attachment with kind');
    ok((await (await dom('GET', `/api/immich/asset/${IMIMG}/thumb`)).status) === 200, 'thumbnail proxy serves through Control');
    ok((await (await sub1('GET', `/api/immich/asset/${IMIMG}/thumb`))).status === 403, 'locked sub blocked from linked asset');
    await sub1('POST', `/api/moments/${im1.id}/version`, V());
    ok((await (await sub1('GET', `/api/immich/asset/${IMIMG}/thumb`))).status === 200, 'after recording, linked asset opens for the sub');
    // per-user key: kitten links from HER library (only her key can see it)
    const setKey = await j(await sub1('PATCH', '/api/auth/me', { immich_key: 'subkey' }));
    ok(setKey.user && setKey.user.immich_linked === true && !JSON.stringify(setKey).includes('subkey'), 'key accepted, linked flag set, key never echoed');
    const im2 = await j(await sub1('POST', '/api/moments', {
      ...V({ summary: 'her library video' }), title: 'Her video', date: '2026-10-09', planned_kind: 'planned',
      people_dom: '1', immich: IMVID + ',' + IMVID
    }));
    ok(im2.ok === true, 'sub links an asset only their key can see (dup id deduped)');
    const im2g = (await groups(sub1)).find(g => g.id === im2.id);
    const im2v = im2g.versions.find(v => v.author_id === sub1Id);
    ok((im2v.attachments.filter(a => a.immich).length === 1 && im2v.attachments.find(a => a.immich).media === 'video'), 'video kind detected for the linked asset');
    const srch = await j(await sub1('GET', '/api/immich/search?start=2026-10-09T00:00:00.000Z&end=2026-10-11T00:00:00.000Z'));
    ok(srch.status === 200 && srch.items.some(i => i.id === IMVID), 'picker search uses the viewer key');
    // replace-on-edit: clear then set
    const edC = await j(await sub1('PUT', `/api/moments/${im2.id}/version`, V({ immich: '' })));
    ok(edC.ok === true && !(await groups(sub1)).find(g => g.id === im2.id).versions.find(v => v.mine).attachments.some(a => a.immich), 'empty immich list clears the links');
    const edS = await j(await sub1('PUT', `/api/moments/${im2.id}/version`, V({ immich: IMVID })));
    ok(edS.ok === true && (await groups(sub1)).find(g => g.id === im2.id).versions.find(v => v.mine).attachments.some(a => a.immich), 'edit re-links assets');
    const clr = await j(await sub1('PATCH', '/api/auth/me', { immich_key: '' }));
    ok(clr.user && clr.user.immich_linked === false, 'key cleared');
    // give it back for the app-wide section (her own library assets)
    await sub1('PATCH', '/api/auth/me', { immich_key: 'subkey' });

    console.log('--- Immich everywhere: feed + evidence + punishments + profile photos ---');
    const domId4 = (await (await dom('GET', '/api/auth/me')).json()).user.id;
    // feed post with a linked asset (dom broadcast)
    const fp = await j(await dom('POST', '/api/feed', { body: 'look at the library', immich: IMIMG }));
    ok(fp.ok === true, 'feed post with Immich link created');
    const fpItem = (await j(await dom('GET', '/api/feed'))).items.find(i => i.kind === 'post' && i.id === fp.id);
    ok(fpItem && (fpItem.attachments || []).some(a => a.immich && a.asset_id === IMIMG), 'feed item carries the linked asset');
    ok((await (await sub2('GET', `/api/immich/asset/${IMIMG}/thumb`))).status === 200, 'broadcast-linked asset serves to a household sub');
    const sub4b = client();
    await sub4b('POST', '/api/auth/register', { email: 's4b@test.local', password: 'Passw0rd!', name: 'Sub Four B', role: 'sub', title: 'toy', inviteCode: code });
    ok((await (await sub4b('GET', `/api/immich/asset/${IMIMG}/thumb`))).status === 403, 'unpaired/untargeted sub blocked from the linked feed asset');
    // task evidence via Immich
    const t2 = await j(await dom('POST', '/api/tasks', { sub_id: sub2Id, title: 'Show yourself', description: '', frequency: 'daily', completion_mode: 'evidence' }));
    const ev1 = await j(await sub2('POST', `/api/tasks/${t2.id}/complete`, { method: 'evidence', immich: IMVID }));
    ok(ev1.ok === true, 'task completed with a linked Immich asset (no upload)');
    const domComps = (await j(await dom('GET', `/api/tasks/dom/sub/${sub2Id}`))).completions;
    ok(domComps.some(c => c.immich_asset_id === IMVID), 'dom sees Immich-linked evidence on the completion');
    ok((await (await dom('GET', `/api/immich/asset/${IMVID}/original`))).status === 200, 'dom streams the linked evidence original');
    ok((await (await sub3('GET', `/api/immich/asset/${IMVID}/original`))).status === 403, 'a different sub cannot view the evidence');
    // punishment evidence via Immich
    const p9 = await j(await dom('POST', '/api/punishments', { sub_id: sub2Id, title: 'Write lines', description: '', completion_mode: 'evidence' }));
    ok((await j(await sub2('POST', `/api/punishments/${p9.id}/complete`, { method: 'evidence', immich: IMIMG }))).ok === true, 'punishment completed with a linked asset');
    ok((await j(await dom('GET', `/api/punishments/dom/sub/${sub2Id}`))).history.some(pp => pp.id === p9.id && pp.immich_asset_id === IMIMG), 'punishment history carries the linked asset');
    // profile photo via Immich
    const pfPhoto = await j(await dom('POST', '/api/profile/fields', { label: 'Linked photo', kind: 'photo' }));
    const pfFid = pfPhoto.id || (await j(await dom('GET', '/api/profile/sub/' + sub1Id))).fields.find(f => f.label === 'Linked photo').id;
    const pfd = new FormData();
    pfd.append('field_id', pfFid);
    pfd.append('asset_id', IMIMG);
    ok((await j(await dom('POST', `/api/profile/sub/${sub1Id}/photo`, pfd, { form: true }))).ok === true, 'profile photo set from an Immich asset');
    const pfl = (await j(await dom('GET', '/api/profile/sub/' + sub1Id))).fields.find(f => f.id === pfFid);
    ok(pfl && !pfl.value && pfl.im_asset_id === IMIMG, 'profile value stored as an Immich link, not a file');
    ok((await (await sub1('GET', `/api/immich/asset/${IMIMG}/thumb`))).status === 200, 'that sub can see their own profile photo asset');
    ok((await (await sub2('GET', `/api/immich/asset/${IMIMG}/thumb`))).status === 200, 'asset still visible via the broadcast moment link (any readable source grants access)');

    console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
  } catch (e) {
    console.error('TEST CRASH:', e);
    failures++;
  } finally {
    server.kill();
    mockImmich.close(() => {});
    if (log && failures) console.log('--- server log ---\n' + log.slice(-2000));
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
    process.exit(failures ? 1 : 0);
  }
})();