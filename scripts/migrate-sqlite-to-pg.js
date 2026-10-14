// One-shot import of the legacy SQLite database into PostgreSQL.
//
// Usage (expects better-sqlite3 to be installed — run inside the migrator
// container image or a dev checkout):
//
//   SQLITE_PATH=/data/control.db DATABASE_URL=postgres://control:pw@db:5432/control \
//     node scripts/migrate-sqlite-to-pg.js
//
// The SQLite file is opened READONLY — uploads and the original database are
// never touched, so rollback is just restarting the old image. Refuses to run
// when PostgreSQL already holds users (clean rerun story: wipe the database
// and run again); FORCE=1 truncates everything first instead.
//
// Verification is authoritative: per-table row counts must match exactly,
// users sample rows must round-trip, comments must match per subject, check-in
// ratings must match in min/max/sum, and no orphan foreign keys may exist.
// The whole import commits atomically; a verification failure rolls back.
const path = require('path');
const Database = require('better-sqlite3');
const { Pool } = require('pg');
const dbmod = require('../src/db');

// Import order respecting foreign keys: users first (dom_id backfilled in a
// second pass once every user row exists), then dependencies before dependents.
const TABLES = [
  'users',
  'tasks',
  'completions', 'missed_alerts', 'checkins', 'prompts', 'password_resets',
  'performance_alerts', 'profile_fields',
  'entries', 'profile_values', 'profile_exposure', 'punishments',
  'entry_shares', 'comments',
  'feed_posts', 'feed_post_targets', 'feed_attachments', 'feed_immich',
  'tags', 'moment_groups', 'moment_group_subs', 'moment_versions',
  'moment_attachments', 'moment_tags', 'moment_immich'
];

async function main() {
  // legacy db sits next to the repo in dev, or on the /data volume in Docker
  const defaultDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  const sqlitePath = path.resolve(process.env.SQLITE_PATH || path.join(defaultDir, 'control.db'));
  let sqlite;
  try {
    sqlite = new Database(sqlitePath, { readonly: true, fileMustExist: true });
  } catch (err) {
    console.error(`[migrate] cannot open ${sqlitePath}:`, err.message);
    process.exit(1);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    await dbmod.migrate(); // ensure the schema exists (idempotent)

    const existing = await pool.query('SELECT COUNT(*) AS n FROM users');
    if (existing.rows[0].n > 0) {
      if (process.env.FORCE === '1') {
        console.log('[migrate] FORCE set — truncating all tables first');
        const client = await pool.connect();
        try {
          await client.query(`TRUNCATE TABLE ${[...TABLES].reverse().join(', ')} CASCADE`);
        } finally { client.release(); }
      } else {
        console.error(`[migrate] PostgreSQL already has ${existing.rows[0].n} users — refusing to import over it. Wipe the database and rerun, or set FORCE=1.`);
        process.exit(1);
      }
    }

    // What exists where (columns may drift; import the intersection, warn on skips).
    const sqliteColumns = {};
    for (const t of TABLES) {
      sqliteColumns[t] = sqlite.prepare(`PRAGMA table_info('${t}')`).all().map((c) => c.name);
    }
    const pgColsRes = await pool.query(`SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1)`, [TABLES]);
    const pgColumns = {};
    for (const r of pgColsRes.rows) (pgColumns[r.table_name] ||= []).push(r.column_name);

    const counts = {};
    const domLinks = [];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      for (const t of TABLES) {
        // Older snapshots predate some tables (e.g. feed_immich) — those import as empty.
        const sqliteHasTable = sqlite.prepare(
          "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(t) !== undefined;
        const allCols = sqliteHasTable
          ? sqliteColumns[t].filter((c) => pgColumns[t]?.includes(c))
          : [];
        const missingInPg = sqliteHasTable
          ? sqliteColumns[t].filter((c) => !pgColumns[t]?.includes(c))
          : [];
        if (missingInPg.length) {
          console.warn(`[migrate] ${t}: SQLite columns not in PostgreSQL (skipped): ${missingInPg.join(', ')}`);
        }
        // users: hold dom_id back until every user row is in (self-referencing FK)
        const cols = t === 'users' ? allCols.filter((c) => c !== 'dom_id') : allCols;
        const keepDom = !!sqliteColumns[t].includes('dom_id') && t === 'users';

        const rows = sqliteHasTable ? sqlite.prepare(`SELECT * FROM ${t}`).all() : [];
        counts[t] = rows.length;
        for (const r of rows) {
          if (keepDom) {
            if (r.dom_id) domLinks.push([r.dom_id, r.id]);
            delete r.dom_id;
          }
          const params = cols.map((c) => (r[c] === undefined ? null : r[c]));
          const ph = cols.map(() => '?');
          const sql = `INSERT INTO ${t} (${cols.join(', ')}) VALUES (${ph.join(', ')})`;
          const pgSql = sql.split('?').map((seg, i) => i < cols.length ? seg + `$${i + 1}` : seg).join('');
          const res = await client.query(pgSql, params);
          if (res.rowCount !== 1) throw new Error(`insert into ${t} affected ${res.rowCount}`);
        }
        console.log(`[migrate] ${t}: ${rows.length} rows`);
      }

      // users phase 2: restore dom_id links now that every user exists
      for (const [domId, id] of domLinks) {
        await client.query('UPDATE users SET dom_id = $1 WHERE id = $2', [domId, id]);
      }
      console.log(`[migrate] users dom_id backfill: ${domLinks.length} links`);

      // ---- verification (inside the same open transaction) ----
      let failed = false;
      for (const t of TABLES) {
        const pg = await client.query(`SELECT COUNT(*) AS n FROM ${t}`);
        if (Number(pg.rows[0].n) !== counts[t]) {
          console.error(`[migrate] COUNT MISMATCH ${t}: sqlite=${counts[t]} pg=${pg.rows[0].n}`);
          failed = true;
        }
      }
      {
        const su = sqlite.prepare('SELECT id, email, name, role, pw_version FROM users ORDER BY id').all();
        for (const u of su.slice(0, 50).concat(su.slice(-50))) {
          const p = (await client.query('SELECT id, email, name, role, pw_version FROM users WHERE id = $1', [u.id])).rows[0];
          if (!p || p.email !== u.email || p.name !== u.name || p.role !== u.role
            || Number(p.pw_version) !== Number(u.pw_version)) {
            console.error(`[migrate] USER PARITY FAIL: ${u.id}`);
            failed = true;
          }
        }
      }
      {
        for (const r of sqlite.prepare(`SELECT subject, COUNT(*) AS n FROM comments GROUP BY subject`).all()) {
          const p = (await client.query('SELECT COUNT(*) AS n FROM comments WHERE subject = $1', [r.subject])).rows[0];
          if (Number(p.n) !== Number(r.n)) {
            console.error(`[migrate] COMMENT SUBJECT MISMATCH ${r.subject}: sqlite=${r.n} pg=${p.n}`);
            failed = true;
          }
        }
      }
      {
        const s = sqlite.prepare(`SELECT MIN(mood) a, MAX(mood) b, SUM(mood) c, MIN(day_rating) d, MAX(day_rating) e, SUM(day_rating) f FROM checkins`).get();
        const p = (await client.query(`SELECT MIN(mood) a, MAX(mood) b, SUM(mood) c, MIN(day_rating) d, MAX(day_rating) e, SUM(day_rating) f FROM checkins`)).rows[0];
        for (const [k, sv, pv] of [['mood-min', s.a, p.a], ['mood-max', s.b, p.b], ['mood-sum', s.c, p.c], ['day-min', s.d, p.d], ['day-max', s.e, p.e], ['day-sum', s.f, p.f]]) {
          if (Number(sv || 0) !== Number(pv || 0)) {
            console.error(`[migrate] CHECKIN PARITY FAIL ${k}: sqlite=${sv} pg=${pv}`);
            failed = true;
          }
        }
      }
      for (const [tbl, col] of [['tasks', 'dom_id'], ['checkins', 'sub_id'], ['entries', 'owner_id'], ['comments', 'author_id'], ['feed_posts', 'author_id'], ['moment_versions', 'author_id']]) {
        if (!counts[tbl]) continue;
        const orphans = await client.query(`SELECT COUNT(*) AS n FROM ${tbl} t LEFT JOIN users u ON u.id = t.${col} WHERE u.id IS NULL`);
        if (Number(orphans.rows[0].n) !== 0) {
          console.error(`[migrate] ORPHAN FAIL: ${tbl}.${col} has ${orphans.rows[0].n} dangling rows`);
          failed = true;
        }
      }
      if (failed) {
        await client.query('ROLLBACK');
        console.error('[migrate] verification FAILED — rolled back, PostgreSQL left empty');
        process.exit(1);
      }
      await client.query('COMMIT');
      console.log('[migrate] verification passed — imported:',
        TABLES.map((t) => `${t}=${counts[t]}`).join(', '));
    } finally {
      client.release();
    }
  } finally {
    sqlite.close();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[migrate] failed:', err);
  process.exit(1);
});