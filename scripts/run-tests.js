// Runs every end-to-end script sequentially against the throwaway PostgreSQL
// (TEST_PG_URL), aborting on the first failure. The puppeteer UI checks run
// last and are skipped when puppeteer-core (or Edge) isn't available.
const { spawn } = require('child_process');
const path = require('path');
// test scripts spawn 'src/server.js' relative to the repo root
const ROOT = path.join(__dirname, '..');

const TESTS = [
  'test-fresh-install.js',
  'test-feed.js',
  'test-moments.js',
  'test-profile-photo.js'
];
const UI_CHECKS = ['check-feed-media-ui.js', 'check-moments-ui.js', 'check-today-ui.js'];

async function run(script) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, script)], {
      cwd: ROOT,
      stdio: ['ignore', 'inherit', 'inherit']
    });
    child.on('exit', (code) => resolve(code === 0));
  });
}

(async () => {
  let failed = false;
  for (const t of TESTS) {
    console.log(`\n=== ${t} ===`);
    if (!(await run(t))) {
      console.error(`FAILED: ${t}`);
      failed = true;
      break;
    }
  }
  if (!failed) {
    for (const t of UI_CHECKS) {
      try {
        require.resolve('puppeteer-core');
      } catch {
        console.log(`\n(skip ${t} — puppeteer-core not installed)`);
        continue;
      }
      console.log(`\n=== ${t} ===`);
      if (!(await run(t))) {
        console.error(`FAILED: ${t}`);
        failed = true;
        break;
      }
    }
  }
  console.log(failed ? '\nTESTS FAILED' : '\nTESTS ALL PASS');
  process.exit(failed ? 1 : 0);
})();