const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { Pool } = require('pg');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set — Control stores its data in PostgreSQL '
    + '(e.g. postgres://control:<password>@db:5432/control)');
}

// Pool of PostgreSQL clients shared by every request. Call sites elsewhere use
// the same statement API shape the SQLite code had (get/all/run/transaction),
// just awaited now.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
pool.on('error', (err) => console.error('[db] idle client error:', err));

// A transaction body runs inside AsyncLocalStorage scope of its own client, so
// the get/all/run calls made anywhere in the callback — including nested
// helpers — automatically land on that client instead of the pool. This keeps
// two concurrent requests from ever interleaving into each other's transaction.
const txContext = new AsyncLocalStorage();
const client = () => txContext.getStore() || pool;

// SQLite placeholders were `?`, PostgreSQL wants `$1..$n`. Call sites keep
// writing `?` so the ported SQL reads unchanged; this rewrites at runtime.
// Apostrophes inside comments or an unbalanced string literal would silently
// corrupt the numbering, so the scanner skips `--`/`/* */` comments and both
// of those conditions throw instead of guessing.
function toPg(sql) {
  if (!sql.includes('?')) return sql;
  let out = '';
  let n = 0;
  let inStr = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (inLine) {
      out += ch;
      if (ch === '\n') inLine = false;
      continue;
    }
    if (inBlock) {
      out += ch;
      if (ch === '*' && next === '/') { out += next; i++; inBlock = false; }
      continue;
    }
    if (inStr) {
      out += ch;
      if (ch === "'") {
        if (next === "'") { out += next; i++; } // escaped ''
        else inStr = false;
      }
      continue;
    }
    if (ch === '-' && next === '-') { inLine = true; out += ch; continue; }
    if (ch === '/' && next === '*') { inBlock = true; out += ch; continue; }
    if (ch === "'") { inStr = true; out += ch; continue; }
    if (ch === '?') out += '$' + (++n);
    else out += ch;
  }
  if (inStr) throw new Error('Unterminated string literal in SQL: ' + sql.slice(0, 80));
  return out;
}

async function get(sql, ...params) {
  const res = await client().query(toPg(sql), params);
  return res.rows[0];
}

async function all(sql, ...params) {
  const res = await client().query(toPg(sql), params);
  return res.rows;
}

// Returns { changes: n } to mirror better-sqlite3's run() result.
async function run(sql, ...params) {
  const res = await client().query(toPg(sql), params);
  return { changes: res.rowCount };
}

async function transaction(fn) {
  if (txContext.getStore()) throw new Error('Nested transactions are not supported');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const result = await txContext.run(c, fn);
    await c.query('COMMIT');
    return result;
  } catch (err) {
    try { await c.query('ROLLBACK'); } catch { /* connection may be dead already */ }
    throw err;
  } finally {
    c.release();
  }
}

// Versioned migrations: numbered .sql files in migrations/, applied once each
// inside a transaction at startup. Fresh installs get the current schema in
// one file; the SQLite → PostgreSQL data import (scripts/migrate-sqlite-to-pg.js)
// runs the same runner first so both paths share one initial DDL.
const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

async function migrate() {
  await run(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
  )`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const seen = await get('SELECT 1 AS ok FROM schema_migrations WHERE name = ?', f);
    if (seen) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    await transaction(async () => {
      await run(sql);
      await run('INSERT INTO schema_migrations (name) VALUES (?)', f);
    });
    console.log(`[db] applied migration ${f}`);
  }
}

// The starter catalog every Dominant gets (basic physical + demographic info).
const DEFAULT_FIELD_LABELS = ['Full name', 'Date of birth', 'Hair color', 'Eye color'];

// Gives a Dom the starter fields if their catalog is empty. Called when a new
// Dom registers.
async function seedDefaultFields(domId) {
  try {
    const row = await get('SELECT COUNT(*)::int AS n FROM profile_fields WHERE dom_id = ?', domId);
    if (row.n > 0) return;
    await transaction(async () => {
      for (let i = 0; i < DEFAULT_FIELD_LABELS.length; i++) {
        await run('INSERT INTO profile_fields (id, dom_id, label, position) VALUES (?, ?, ?, ?)',
          crypto.randomUUID(), domId, DEFAULT_FIELD_LABELS[i], i);
      }
    });
  } catch (err) { console.error('[db] profile field seed failed:', err); }
}

module.exports = { get, all, run, transaction, migrate, seedDefaultFields, DATA_DIR, UPLOAD_DIR };