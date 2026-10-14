// Shared throwaway-PostgreSQL test environment for the end-to-end scripts.
//
// Needs a PostgreSQL instance the runner can CREATE DATABASE on — point
// TEST_PG_URL at it (default postgres://control:control@127.0.0.1:5434/postgres):
//
//   docker run --rm -d --name control-test-pg -p 5434:5432 \
//     -e POSTGRES_USER=control -e POSTGRES_PASSWORD=control postgres:17-alpine
//
// createTestEnv('feed') builds a unique database, runs the schema migrations
// against it (exercising the same boot path production uses) and returns
// { databaseUrl, cleanup } — cleanup drops the database even if the test
// server crashed and left connections open.
const { Pool } = require('pg');

const TEST_PG_URL = process.env.TEST_PG_URL || 'postgres://control:control@127.0.0.1:5434/postgres';

async function createTestEnv(label) {
  const u = new URL(TEST_PG_URL);
  const admin = new Pool({ connectionString: TEST_PG_URL });
  const name = `control_test_${label}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  try {
    await admin.query(`CREATE DATABASE "${name}" OWNER "${u.username || 'control'}"`);
  } finally {
    await admin.end();
  }
  const auth = u.username
    ? `${encodeURIComponent(u.username)}:${encodeURIComponent(u.password || '')}@`
    : '';
  const databaseUrl = `${u.protocol}//${auth}${u.hostname}:${u.port || 5432}/${name}${u.search || ''}`;

  let pool = null;
  return {
    databaseUrl,
    async cleanup() {
      // The spawned server keeps pooled connections open, so terminate them.
      if (pool) { try { await pool.end(); } catch { /* already closed */ } pool = null; }
      const admin2 = new Pool({ connectionString: TEST_PG_URL, database: 'postgres' });
      try {
        await admin2.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } catch (err) {
        console.warn(`[pg-test-env] could not drop ${name}:`, err.message);
      } finally {
        await admin2.end();
      }
    }
  };
}

module.exports = { createTestEnv, TEST_PG_URL };