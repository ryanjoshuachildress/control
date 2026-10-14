// Headless visual check for the Moments tab: the sub is prompted to record
// their version of a Dom-created moment, clicks real stars, submits, and the
// Dom's version unlocks. Run: node scripts/check-moments-ui.js
// (puppeteer-core driving the installed Edge; no browser download.)

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer-core');

const PORT = 3226;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'control-moments-ui-'));
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
    const isBody = body !== undefined && !(body instanceof FormData);
    const res = await fetch(BASE + p, {
      method,
      headers: { cookie: jar.join('; '), ...(isBody ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : (typeof body === 'string' || body instanceof FormData ? body : JSON.stringify(body)),
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

    // dom + sub paired; dom records a moment (no media — speed) involving the sub
    const dom = client();
    await dom('POST', '/api/auth/register', {
      email: 'd@test.local', password: 'Passw0rd!', name: 'The Dom', role: 'dom', title: 'Sir'
    });
    const code = (await (await dom('GET', '/api/auth/me')).json()).user.invite_code;
    const sub = client();
    await sub('POST', '/api/auth/register', {
      email: 's@test.local', password: 'Passw0rd!', name: 'pet', role: 'sub', title: 'pet', inviteCode: code
    });
    const sid = (await (await sub('GET', '/api/auth/me')).json()).user.id;
    const seedRes = await dom('POST', '/api/moments', JSON.stringify({
      title: 'The rope afternoon', description: 'quiet house', date: '2026-10-09', time: '21:00',
      planned_kind: 'spontaneous', people_dom: '1', sub_ids: [sid],
      summary: 'Three hours of rope and stillness.',
      best_part: 'the breath', worst_part: 'pins', again: 'yes',
      r_originality: 4, r_hotness: 5, r_surprise: 3, r_connection: 5,
      tags: 'rope'
    }));
    const seed = { ok: seedRes.ok, ...(await seedRes.json().catch(() => ({}))) };
    if (!seed.ok) throw new Error('seed moment failed: ' + seedRes.status + ' ' + JSON.stringify(seed));
    const subTag = await sub('POST', '/api/moments/tags', JSON.stringify({ name: 'tease' }));
    if (!subTag.ok) throw new Error('sub seed tag failed: ' + subTag.status);
    await sub('POST', `/api/moments/${seed.id}/tags`, JSON.stringify({ tags: 'tease' }));

    browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'], protocolTimeout: 120000 });
    const page = await browser.newPage();
    page.on('pageerror', err => { ok(false, `page JS error: ${err.message}`); });
    await page.setCookie(...sub.snapshot().map(line => {
      const i = line.indexOf('=');
      return { name: line.slice(0, i), value: line.slice(i + 1), domain: '127.0.0.1', path: '/' };
    }));
    await page.setViewport({ width: 1280, height: 1000 });

    await page.goto(`${BASE}/#/moments`, { waitUntil: 'networkidle0' });
    ok(!!await page.$('nav.tabs a[href="#/moments"].on'), 'Moments tab exists and is active for the sub');
    ok((await page.evaluate(() => document.body.innerText)).includes('Sir The Dom has recorded their version'), 'locked teaser names its author');
    ok(!(await page.content()).includes('Three hours of rope'), "dom version content NOT leaked before recording");
    ok(await page.$('form[data-form="moment-create"]'), 'composer form is present');
    ok(await page.$('datalist#tagListMoments'), 'tag datalist is present');

    // open the record-your-version form — it auto-opens for a prompted sub
    ok(await page.$('details.mv-form[open]'), 'record form is auto-opened for the prompted sub');
    await page.type('form[data-form="moment-version"] textarea[name="summary"]', 'From my side: floaty and safe.');
    await page.type('form[data-form="moment-version"] textarea[name="best_part"]', 'the breath');
    for (const [k, v] of [['r_originality', 4], ['r_hotness', 5], ['r_surprise', 3], ['r_connection', 5]]) {
      await page.click(`form[data-form="moment-version"] .stars[data-stars="${k}"] .star[data-v="${v}"]`);
    }
    const hotness = await page.$eval('form[data-form="moment-version"] .stars[data-stars="r_hotness"]', w => w.dataset.value);
    ok(hotness === '5', 'star widget registered the click (value 5)');
    const starFill = await page.$eval('form[data-form="moment-version"] .stars[data-stars="r_hotness"] .star[data-v="4"]', s => s.classList.contains('on'));
    ok(starFill, 'stars below the clicked one fill in');
    await page.click('form[data-form="moment-version"] button[type="submit"]');
    await page.waitForFunction(() => document.body.innerText.includes('Three hours of rope'), { timeout: 5000 });
    ok(true, 'dom version content unlocked after the sub recorded');
    ok((await page.content()).includes('floaty and safe'), 'sub version renders');
    ok((await page.$$('.stars-ro')).length >= 8, 'star ratings display (both versions)');

    // tag filter chip navigates to the filtered list
    const chipOk = await page.evaluate(() => {
      const chip = document.querySelector('.tagchip[data-action="filter-tag"]');
      if (!chip) return false;
      chip.click();
      return location.hash.startsWith('#/moments?tag=');
    });
    ok(chipOk, 'tag chip filters the list via URL');

    // comment thread on the moment card (subject 'moment')
    await page.goto(`${BASE}/#/moments`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.comments[data-comment-subject="moment"] [data-action="toggle-comments"]', { timeout: 5000 });
    await page.evaluate(() => document.querySelector('.comments[data-comment-subject="moment"] [data-action="toggle-comments"]').click());
    await page.waitForSelector('.comments[data-comment-subject="moment"] form[data-form="comment"]:not([hidden])', { timeout: 5000 });
    await page.type('.comments[data-comment-subject="moment"] form[data-form="comment"] textarea[name="body"]', 'still thinking about it, Sir');
    await page.evaluate(() => document.querySelector('.comments[data-comment-subject="moment"] form[data-form="comment"] button[type="submit"]').click());
    await page.waitForFunction(() => document.body.innerText.includes('still thinking about it'), { timeout: 5000 });
    ok(true, 'comment posted on the moment thread renders');
    await page.screenshot({ path: path.join(TMP, 'sub.png') }).catch(() => {});

    // dom view: tag manager + add-your-version details
    const page2 = await browser.newPage();
    page2.on('pageerror', err => { ok(false, `dom page JS error: ${err.message}`); });
    await page2.setCookie(...dom.snapshot().map(line => {
      const i = line.indexOf('=');
      return { name: line.slice(0, i), value: line.slice(i + 1), domain: '127.0.0.1', path: '/' };
    }));
    await page2.setViewport({ width: 1280, height: 1000 });
    await page2.goto(`${BASE}/#/moments`, { waitUntil: 'networkidle0' });
    ok((await page2.content()).includes('Tag master list'), 'dom sees the tag master list card');
    ok((await page2.content()).includes('pending'), 'dom sees the pending tag');
    ok((await page2.content()).includes('Three hours of rope'), 'dom reads both versions straight away');
    ok((await page2.content()).includes('Edit your version'), 'dom card offers to edit their version');
    ok(await page2.$('form[data-form="moment-edit"]'), 'prefilled edit form present');

    // recap page
    await page2.goto(`${BASE}/#/recap`, { waitUntil: 'networkidle0' });
    await page2.waitForSelector('.tiles', { timeout: 5000 });
    ok((await page2.evaluate(() => document.body.innerText.toLowerCase())).includes('moments recap'), 'recap page renders');
    ok((await page2.content()).includes('Top rated'), 'recap lists top rated moments');
    ok((await page2.evaluate(() => document.body.innerText.toLowerCase())).includes('avg hotness'), 'recap tiles present');
    await page2.select('#recapMode', 'month');
    await page2.waitForFunction(() => document.body.innerText.toLowerCase().includes('spread over the month'), { timeout: 5000 });
    ok(true, 'recap switches to month view');
    await page2.screenshot({ path: path.join(TMP, 'recap.png') }).catch(() => {});
    const settings = await browser.newPage();
    await settings.setCookie(...dom.snapshot().map(line => {
      const i = line.indexOf('=');
      return { name: line.slice(0, i), value: line.slice(i + 1), domain: '127.0.0.1', path: '/' };
    }));
    await settings.goto(`${BASE}/#/settings`, { waitUntil: 'networkidle0' });
    ok(!!await settings.$('input[name="allow_sub_interaction"]'), 'household interaction switch on dom settings');

    await page2.screenshot({ path: path.join(TMP, 'dom.png') }).catch(() => {});
    await page.screenshot({ path: path.join(TMP, 'sub-after.png') }).catch(() => {});
    console.log('screenshots:', path.join(TMP, 'sub.png'), path.join(TMP, 'dom.png'), path.join(TMP, 'sub-after.png'));
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