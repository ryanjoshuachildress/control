// Headless visual check: a feed post with photo + video attachments renders on
// the dom and sub views. Run: node scripts/check-feed-media-ui.js
// (puppeteer-core driving the installed Edge; no browser download.)

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer-core');

const PORT = 3225;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'control-feed-ui-'));
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].find(p => { try { return fs.existsSync(p); } catch { return false; } });
if (!EDGE) { console.error('Edge not found'); process.exit(1); }

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64');
const MP4 = Buffer.alloc(1024, 1); // stub; only the extension matters server-side

let failures = 0;
const ok = (cond, label) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
};

// Minimal cookie-jar client: keeps every control.sid cookie set-cookie returns
// and replays them on the next call.
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
  const server = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, DATA_DIR: TMP, PORT: String(PORT), SESSION_SECRET: 'ui-check', SMTP_HOST: '' },
    stdio: 'ignore'
  });
  let browser;
  try {
    for (let i = 0; i < 50; i++) {
      try { const h = await fetch(`${BASE}/api/health`); if (h.ok) break; } catch {}
      await new Promise(r => setTimeout(r, 100));
    }

    // dom + sub pair; dom posts an image + video broadcast
    const dom = client();
    await dom('POST', '/api/auth/register', JSON.stringify({
      email: 'd@t.local', password: 'Passw0rd!', name: 'Sir', role: 'dom', title: 'Sir'
    }));
    const code = (await (await dom('GET', '/api/auth/me')).json()).user.invite_code;
    const sub = client();
    await sub('POST', '/api/auth/register', JSON.stringify({
      email: 's@t.local', password: 'Passw0rd!', name: 'pet', role: 'sub', title: 'pet', inviteCode: code
    }));

    const fd = new FormData();
    fd.append('body', 'Photo + video check');
    fd.append('media', new Blob([PNG], { type: 'image/png' }), 'pic.png');
    fd.append('media', new Blob([MP4], { type: 'video/mp4' }), 'clip.mp4');
    const postRes = await dom('POST', '/api/feed', fd);
    if (!postRes.ok) throw new Error('seed post failed: ' + postRes.status);

    browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'] });

    const check = async (who, jarCookies, shot) => {
      const page = await browser.newPage();
      await page.setCookie(...jarCookies.map(line => {
        const i = line.indexOf('=');
        return { name: line.slice(0, i), value: line.slice(i + 1), domain: '127.0.0.1', path: '/' };
      }));
      page.on('pageerror', err => { ok(false, `${who} page JS error: ${err.message}`); });
      await page.goto(`${BASE}/#/feed`, { waitUntil: 'networkidle0' });
      const img = await page.$('.feed-media .pf-thumb');
      const vid = await page.$('.feed-media .pf-video');
      const imgLoaded = img ? await page.evaluate(el => el.naturalWidth > 0, img) : false;
      const vidPresent = vid ? await page.evaluate(el => el.readyState >= 0, vid) : false;
      ok(!!img && imgLoaded, `${who} feed renders the photo attachment (image decoded)`);
      ok(!!vid && vidPresent, `${who} feed renders the video attachment (<video> element)`);
      // the image actually served through the guarded /uploads route
      const src = img ? await page.evaluate(el => el.getAttribute('src'), img) : null;
      if (src) {
        const r = await page.evaluate(async (u) => (await fetch(u)).status, src);
        ok(r === 200, `${who} can fetch the attachment through /uploads (${src})`);
      }
      // the video file head request
      const vsrc = vid ? await page.evaluate(el => el.getAttribute('src'), vid) : null;
      if (vsrc) {
        const r = await page.evaluate(async (u) => (await fetch(u, { method: 'GET', headers: { range: 'bytes=0-10' } })).status, vsrc);
        ok(r === 200 || r === 206, `${who} can fetch the video through /uploads`);
      }
      await page.screenshot({ path: shot, fullPage: true });
      await page.close();
      return shot;
    };

    const shotA = await check('dom', dom.snapshot(), path.join(TMP, 'dom.png'));
    const shotB = await check('sub', sub.snapshot(), path.join(TMP, 'sub.png'));
    console.log('screenshots:', shotA, shotB);
  } catch (e) {
    console.error('CHECK CRASH:', e);
    failures++;
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
    process.exit(failures ? 1 : 0);
  }
})();