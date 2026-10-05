// End-to-end test for photo profile fields (About the submissive) against a
// throwaway DATA_DIR. Run: node scripts/test-profile-photo.js
// Boots the real server on a temp port, drives register→pair→photo upload→
// exposure→serving→replace/cleanup with plain fetch.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3211;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'control-photo-test-'));

let failures = 0;
const ok = (cond, label) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
};

// 1x1 PNG (transparent) — 68 bytes
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64');
fs.writeFileSync(path.join(TMP, 'tiny.png'), PNG);

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
    // cookie-session sends two cookies (sid + sig) joined by ", " — keep every pair
    const sc = res.headers.get('set-cookie');
    if (sc) {
      cookie = sc.split(/,\s*(?=[A-Za-z][\w.-]+[.][\w.-]+\s*=)/).map(c => c.split(';')[0]).join('; ');
    }
    return res;
  };
  return Object.assign(call, { cookie: () => cookie });
}

(async () => {
  const server = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env,
      DATA_DIR: TMP,
      PORT: String(PORT),
      SESSION_SECRET: 'test-secret',
      // SMTP_HOST unset → emails are logged, not sent
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

    // --- setup: dom + two subs
    const dom = client();
    const domReg = await dom('POST', '/api/auth/register', {
      email: 'dom@test.local', password: 'Passw0rd!', name: 'The Dom', role: 'dom', title: 'Sir'
    });
    if (domReg.status !== 200) console.log('DEBUG dom register:', domReg.status, await domReg.json());

    const domMe = (await (await dom('GET', '/api/auth/me')).json()).user;
    const code = domMe.invite_code;

    const sub1 = client();
    const r1 = await sub1('POST', '/api/auth/register', {
      email: 'sub1@test.local', password: 'Passw0rd!', name: 'Sub One', role: 'sub', title: 'pet', inviteCode: code
    });
    if (r1.status !== 200) console.log('DEBUG sub1 register:', r1.status, JSON.stringify(await r1.json()).slice(0, 200));
    const sub2 = client();
    const r2 = await sub2('POST', '/api/auth/register', {
      email: 'sub2@test.local', password: 'Passw0rd!', name: 'Sub Two', role: 'sub', title: 'toy', inviteCode: code
    });
    if (r2.status !== 200) console.log('DEBUG sub2 register:', r2.status, JSON.stringify(await r2.json()).slice(0, 200));
    const d = (await (await sub1('GET', '/api/auth/me')).json()).user;
    const sub1Id = d.id;
    console.log('DEBUG sub1Id:', sub1Id, 'dom_id:', d.dom_id);

    // seed check: defaults are text fields
    const p0 = await (await dom('GET', `/api/profile/sub/${sub1Id}`)).json();
    ok(p0.fields.length === 4 && p0.fields.every(f => f.kind === 'text'), 'default fields seeded as text kind');

    // --- add a photo field; it appears for both subs
    const addRes = await dom('POST', '/api/profile/fields', { label: 'Portrait', kind: 'photo' });
    ok((await addRes.json()).ok === true, 'create photo field');
    const p1 = await (await dom('GET', `/api/profile/sub/${sub1Id}`)).json();
    const photoField = p1.fields.find(f => f.kind === 'photo');
    ok(!!photoField && p1.fields.length === 5, 'photo field listed with kind=photo');
    const p1s2 = await (await dom('GET', `/api/profile/sub/${(await (await sub2('GET', '/api/auth/me')).json()).user.id}`)).json();
    ok(p1s2.fields.some(f => f.kind === 'photo'), 'photo field auto-added to other subs too');

    // --- text still works
    const nameField = p1.fields.find(f => f.label === 'Full name');
    await dom('PUT', `/api/profile/sub/${sub1Id}/value`, { field_id: nameField.id, value: 'Jane Doe' });

    // --- photo upload
    const fd = new FormData();
    fd.append('photo', new File([PNG], 'tiny.png', { type: 'image/png' }));
    fd.append('field_id', photoField.id);
    const upRes = await fetch(`${BASE}/api/profile/sub/${sub1Id}/photo`, {
      method: 'POST', body: fd, headers: { cookie: dom.cookie() }
    });
    const up = await upRes.json();
    ok(up.ok === true && /^pf-[\w.-]+$/.test(up.value), 'photo upload accepted, pf- filename stored');

    const p2 = await (await dom('GET', `/api/profile/sub/${sub1Id}`)).json();
    ok(p2.fields.find(f => f.id === photoField.id).value === up.value, 'value row now holds the filename');
    ok(p2.fields.find(f => f.id === nameField.id).value === 'Jane Doe', 'text field untouched');

    // --- serving rules
    const png = (r) => r.status === 200 && r.headers.get('content-type').includes('image/');
    ok(png(await sub1('GET', `/uploads/${up.value}`)), 'sub can view their profile photo');
    ok(png(await dom('GET', `/uploads/${up.value}`)), 'dom can view the profile photo');
    const s2img = await sub2('GET', `/uploads/${up.value}`);
    ok(s2img.status === 403 || s2img.status === 404, 'other sub cannot view the photo');
    const anon = await fetch(`${BASE}/uploads/${up.value}`);
    ok(anon.status === 401 || anon.status === 403, 'anonymous cannot view the photo');

    // --- exposure → /mine shows it
    let mine = await (await sub1('GET', '/api/profile/mine')).json();
    ok(mine.fields.length === 0, 'nothing exposed yet');
    await dom('PATCH', '/api/profile/expose', { field_id: photoField.id, sub_id: sub1Id, visible: true });
    await dom('PATCH', '/api/profile/expose', { field_id: nameField.id, sub_id: sub1Id, visible: true });
    mine = await (await sub1('GET', '/api/profile/mine')).json();
    const pf = mine.fields.find(f => f.kind === 'photo');
    ok(pf && pf.value === up.value, 'exposed photo field appears read-only for the sub');

    // --- replace photo removes old file
    const fd2 = new FormData();
    fd2.append('photo', new File([PNG], 'b.png', { type: 'image/png' }));
    fd2.append('field_id', photoField.id);
    await fetch(`${BASE}/api/profile/sub/${sub1Id}/photo`, {
      method: 'POST', body: fd2, headers: { cookie: dom.cookie() }
    });
    const p3 = await (await dom('GET', `/api/profile/sub/${sub1Id}`)).json();
    const newFile = p3.fields.find(f => f.id === photoField.id).value;
    ok(newFile !== up.value, 'replaced photo has a new filename');
    const gone = await dom('GET', `/uploads/${up.value}`);
    ok(gone.status === 404, 'old photo file was deleted on replace');

    // --- rejects video/non-image
    const bad = path.join(TMP, 'clip.mp4');
    fs.writeFileSync(bad, Buffer.from('fake-video'));
    const fd3 = new FormData();
    fd3.append('photo', new File([fs.readFileSync(bad)], 'clip.mp4', { type: 'video/mp4' }));
    fd3.append('field_id', photoField.id);
    const badRes = await fetch(`${BASE}/api/profile/sub/${sub1Id}/photo`, {
      method: 'POST', body: fd3, headers: { cookie: dom.cookie() }
    });
    ok(badRes.status === 400, 'mp4 rejected for photo fields');

    // --- text PUT rejected on photo field
    const txtRes = await dom('PUT', `/api/profile/sub/${sub1Id}/value`, { field_id: photoField.id, value: 'oops' });
    ok(txtRes.status === 400, 'text value rejected on a photo field');

    // --- delete field cleans the file up
    await dom('DELETE', `/api/profile/fields/${photoField.id}`);
    const delImg = await dom('GET', `/uploads/${newFile}`);
    ok(delImg.status === 404, 'photo file deleted with the field');

    // --- legacy multiline still reported as multiline kind
    await dom('POST', '/api/profile/fields', { label: 'Notes for me', multiline: true });
    const p4 = await (await dom('GET', `/api/profile/sub/${sub1Id}`)).json();
    ok(p4.fields.some(f => f.label === 'Notes for me' && f.kind === 'multiline'), 'multiline body param still works (kind=multiline)');

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