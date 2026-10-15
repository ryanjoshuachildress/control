let envDB;
// Headless UI check: the submissive's "Today" page renders without a JS error.
// Regression guard for the missing `useUser` import that black-screened every
// submissive after login (the dom pages never mount Today, so dom checks kept
// passing). Run: node scripts/check-today-ui.js
// (puppeteer-core driving the installed Edge; no browser download.)

const { spawn } = require('child_process');
const { createTestEnv } = require('./lib/pg-test-env');
const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer-core');

const PORT = 3227;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'control-today-ui-'));
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].find(p => { try { return fs.existsSync(p); } catch { return false; } });
if (!EDGE) { console.error('Edge not found'); process.exit(1); }

let failures = 0;
const ok = (cond, label) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
};
// (page text dump removed — assertions below are case-insensitive)

// Minimal cookie-jar client (same shape as the other UI checks).
function client() {
  let jar = [];
  const apply = (res) => {
    for (const line of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
      const pair = line.split(';')[0];
      jar = jar.filter(c => !pair.startsWith(c.split('=')[0] + '='));
      jar.push(pair);
    }
  };
  return Object.assign(async (method, p, body) => {
    const res = await fetch(BASE + p, {
      method,
      headers: {
        cookie: jar.join('; '),
        ...(typeof body === 'string' ? { 'content-type': 'application/json' } : {})
      },
      body: body || undefined,
      redirect: 'manual'
    });
    apply(res);
    return res;
  }, { snapshot: () => jar.slice() });
}

(async () => {
  envDB = await createTestEnv('todayui');
  const server = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, DATA_DIR: TMP, DATABASE_URL: envDB.databaseUrl, PORT: String(PORT), SESSION_SECRET: 'ui-check', SMTP_HOST: '' },
    stdio: 'ignore'
  });
  let browser;
  try {
    for (let i = 0; i < 200; i++) {
      try { const h = await fetch(`${BASE}/api/health`); if (h.ok) break; } catch {}
      await new Promise(r => setTimeout(r, 100));
    }

    // dom + paired sub + one assigned task so Today has content to render
    const dom = client();
    await dom('POST', '/api/auth/register', JSON.stringify({
      email: 'd@t.local', password: 'Passw0rd!', name: 'Sir', role: 'dom', title: 'Sir'
    }));
    const code = (await (await dom('GET', '/api/auth/me')).json()).user.invite_code;
    const sub = client();
    const reg = await (await sub('POST', '/api/auth/register', JSON.stringify({
      email: 's@t.local', password: 'Passw0rd!', name: 'pet', role: 'sub', title: 'pet', inviteCode: code
    }))).json();
    const task = await dom('POST', '/api/tasks', JSON.stringify({
      sub_id: reg.user.id,
      title: 'Say good morning', description: 'politely',
      frequency: 'daily', completion_mode: 'checkoff'
    }));
    if (!task.ok) throw new Error('task seed failed: ' + task.status);

    browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'] });

    const page = await browser.newPage();
    await page.setViewport({ width: 414, height: 896 }); // phone-ish, like the subs
    await page.setCookie(...sub.snapshot().map(line => {
      const i = line.indexOf('=');
      return { name: line.slice(0, i), value: line.slice(i + 1), domain: '127.0.0.1', path: '/' };
    }));
    const jsErrors = [];
    page.on('pageerror', e => jsErrors.push(e.message));

    await page.goto(`${BASE}/#/`, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 500));

    const text = await page.evaluate(() => document.getElementById('app').innerText || '');
    for (const e of jsErrors) ok(false, 'Today page JS error: ' + e);
    ok(jsErrors.length === 0, 'no page errors on the sub Today page');
    ok(/daily check-in/i.test(text), 'Today renders the check-in card');
    ok(text.includes('Say good morning'), 'Today renders the assigned task');
    ok(/tasks/i.test(text), 'Today renders the tasks card');
    await page.screenshot({ path: path.join(TMP, 'today.png'), fullPage: true });
    console.log('screenshot:', path.join(TMP, 'today.png'));

    // Logging out and back in must land on a working Today too (switch-user path).
    await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST' }));
    // A hash-only navigation doesn't reload the page, so force one to get the
    // real signed-out boot (the same screen actual users see).
    await page.goto(`${BASE}/#/login`, { waitUntil: 'networkidle0' });
    await page.reload({ waitUntil: 'networkidle0' });
    await page.type('input[name=email]', 's@t.local');
    await page.type('input[name=password]', 'Passw0rd!');
    await page.click('button.primary');
    await new Promise(r => setTimeout(r, 900));
    const text2 = await page.evaluate(() => document.getElementById('app').innerText || '');
    ok(/daily check-in/i.test(text2), 'sub re-login after logout renders Today');
    await page.screenshot({ path: path.join(TMP, 'today-rel.png'), fullPage: true });
  } catch (e) {
    console.error('CHECK CRASH:', e);
    failures++;
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
    if (envDB) await envDB.cleanup();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
    process.exit(failures ? 1 : 0);
  }
})();