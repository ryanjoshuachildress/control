// Guards the fresh-install path: migrations build the whole schema on a virgin
// database, then register/login/pair work. Run: node scripts/test-fresh-install.js
const { spawn } = require('child_process');
const { createTestEnv } = require('./lib/pg-test-env');

const PORT = 3231;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
const ok = (cond, label) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
};

let envDB;
let cookie = '';
// opts.anon skips the stored cookie (registering a second user while a first
// session cookie is held); opts.saveCookie captures the session anyway.
const call = async (method, p, body, opts = {}) => {
  const res = await fetch(BASE + p, {
    method,
    headers: Object.assign(
      opts.anon ? {} : { cookie },
      body && !body.getHeaders ? { 'content-type': 'application/json' } : {}),
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined
  });
  const sc = res.headers.get('set-cookie');
  if (sc && (opts.saveCookie || !opts.anon)) {
    cookie = sc.split(/,\s*(?=[A-Za-z][\w.-]+[.][\w.-]+\s*=)/).map(c => c.split(';')[0]).join('; ');
  }
  return res;
};
const j = async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) });

(async () => {
  envDB = await createTestEnv('fresh');
  const server = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, DATABASE_URL: envDB.databaseUrl, PORT: String(PORT), SESSION_SECRET: 'fresh-test', SMTP_HOST: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  try {
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {}
      await new Promise(r => setTimeout(r, 100));
    }

    const dom = await j(await call('POST', '/api/auth/register',
      { email: 'fresh@test.local', password: 'Passw0rd!', name: 'Fresh Dom', role: 'dom' }, { anon: true, saveCookie: true }));
    ok(dom.status === 200 && dom.user?.invite_code, 'dom registers on a virgin database');
    const me = await j(await call('GET', '/api/auth/me'));
    ok(me.status === 200 && me.user.email === 'fresh@test.local', 'session works after fresh register');

    const fields = await j(await call('GET', '/api/profile/mine'));
    ok(fields.status === 403, 'profile routes load without a seeding error (dom hits sub-only route)');

    const sub = await j(await call('POST', '/api/auth/register',
      { email: 'freshsub@test.local', password: 'Passw0rd!', name: 'Fresh Sub', role: 'sub', inviteCode: dom.user.invite_code },
      { anon: true, saveCookie: true }));
    ok(sub.status === 200 && sub.user.dom_id === dom.user.id, 'sub pairs via invite code');

    // back to a dom session for task creation
    await call('POST', '/api/auth/login', { email: 'fresh@test.local', password: 'Passw0rd!' }, { anon: true, saveCookie: true });
    const task = await j(await call('POST', '/api/tasks',
      { sub_id: sub.user.id, title: 'Morning report', frequency: 'daily', completion_mode: 'checkoff' }));
    ok(task.status === 200, 'task created');

    // sub session for the today view
    await call('POST', '/api/auth/login', { email: 'freshsub@test.local', password: 'Passw0rd!' }, { anon: true, saveCookie: true });
    const today = await j(await call('GET', '/api/tasks/today'));
    ok(today.status === 200 && today.tasks.length === 1 && today.tasks[0].done === false, 'today view lists the task');

    console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
  } catch (e) {
    console.error('TEST CRASH:', e);
    failures++;
  } finally {
    server.kill();
    if (envDB) await envDB.cleanup();
    if (log && failures) console.log('--- server log ---\n' + log.slice(-2000));
    process.exit(failures ? 1 : 0);
  }
})();