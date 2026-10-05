const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'control.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('dom','sub')),
  title TEXT NOT NULL DEFAULT '',
  timezone TEXT NOT NULL DEFAULT 'UTC',
  invite_code TEXT UNIQUE,
  dom_id TEXT REFERENCES users(id),
  email_notifications INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  dom_id TEXT NOT NULL REFERENCES users(id),
  sub_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  frequency TEXT NOT NULL CHECK (frequency IN ('daily','weekly','monthly')),
  completion_mode TEXT NOT NULL DEFAULT 'checkoff' CHECK (completion_mode IN ('checkoff','evidence')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One completion row per task per period (daily date / weekly Sunday / monthly YYYY-MM)
CREATE TABLE IF NOT EXISTS completions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  period_key TEXT NOT NULL,
  method TEXT NOT NULL,
  evidence_path TEXT,
  note TEXT DEFAULT '',
  completed_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (task_id, period_key)
);

-- Prevents duplicate "missed deadline" emails for the same task/period
CREATE TABLE IF NOT EXISTS missed_alerts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  period_key TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (task_id, period_key)
);

CREATE TABLE IF NOT EXISTS checkins (
  id TEXT PRIMARY KEY,
  sub_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  mood INTEGER NOT NULL,
  day_rating INTEGER NOT NULL,
  best_part TEXT DEFAULT '',
  worst_part TEXT DEFAULT '',
  sexual_notes TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (sub_id, date)
);

CREATE TABLE IF NOT EXISTS prompts (
  id TEXT PRIMARY KEY,
  dom_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sub_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('daily','weekly')),
  text TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  prompt_id TEXT REFERENCES prompts(id) ON DELETE SET NULL,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  shared_with_sub INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_sub_active ON tasks(sub_id, active);
CREATE INDEX IF NOT EXISTS idx_checkins_sub ON checkins(sub_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_entries_owner ON entries(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_prompts_sub ON prompts(sub_id, active);

CREATE TABLE IF NOT EXISTS punishments (
  id TEXT PRIMARY KEY,
  dom_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sub_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  completion_mode TEXT NOT NULL DEFAULT 'checkoff' CHECK (completion_mode IN ('checkoff','evidence')),
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','auto')),
  auto_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed','cancelled')),
  evidence_path TEXT,
  note TEXT DEFAULT '',
  lapse_notified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

-- Per-submissive sharing of Dom journal entries (replaces the shared_with_sub
-- broadcast flag, which showed a shared entry to every paired submissive).
CREATE TABLE IF NOT EXISTS entry_shares (
  entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  sub_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shared_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (entry_id, sub_id)
);

CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One weekly-compliance evaluation per sub per week (prevents repeat punishes)
CREATE TABLE IF NOT EXISTS performance_alerts (
  id TEXT PRIMARY KEY,
  sub_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_key TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (sub_id, period_key)
);

-- "About the submissive" profile. The Dom owns the field catalog: adding a
-- field adds it to every paired submissive's profile. Values are
-- per-submissive and only the Dom can write them; a submissive sees a field
-- only if the Dom has exposed it to them specifically (profile_exposure).
CREATE TABLE IF NOT EXISTS profile_fields (
  id TEXT PRIMARY KEY,
  dom_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  multiline INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS profile_values (
  id TEXT PRIMARY KEY,
  field_id TEXT NOT NULL REFERENCES profile_fields(id) ON DELETE CASCADE,
  sub_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  value TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (field_id, sub_id)
);

CREATE TABLE IF NOT EXISTS profile_exposure (
  field_id TEXT NOT NULL REFERENCES profile_fields(id) ON DELETE CASCADE,
  sub_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shown_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (field_id, sub_id)
);

-- Two-way comment threads on journal entries, tasks, punishments and
-- check-ins, between a Dom and the submissive(s) who can already see the item.
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL CHECK (subject IN ('entry','task','punishment','checkin')),
  subject_id TEXT NOT NULL,
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_comments_subject ON comments(subject, subject_id, created_at);
`);

// Migration: comments threads first shipped with entry+task subjects only.
// SQLite can't alter a CHECK, so copy the rows into a widened table.
try {
  const t = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'comments'").get();
  if (t && t.sql && !t.sql.includes("'punishment'")) {
    db.exec(`
      CREATE TABLE comments_new (
        id TEXT PRIMARY KEY,
        subject TEXT NOT NULL CHECK (subject IN ('entry','task','punishment','checkin')),
        subject_id TEXT NOT NULL,
        author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO comments_new (id, subject, subject_id, author_id, body, created_at)
        SELECT id, subject, subject_id, author_id, body, created_at FROM comments;
      DROP TABLE comments;
      ALTER TABLE comments_new RENAME TO comments;
      CREATE INDEX IF NOT EXISTS idx_comments_subject ON comments(subject, subject_id, created_at);
    `);
  }
} catch (err) { console.error('[db] comments subject migration failed:', err); }

// The starter catalog every Dominant gets (basic physical + demographic info).
const DEFAULT_FIELD_LABELS = ['Full name', 'Date of birth', 'Hair color', 'Eye color'];

// Gives a Dom the starter fields if their catalog is empty. Called when a new
// Dom registers, and during the one-time migration for Doms who predate these
// tables so an empty catalog never leaves the page blank.
function seedDefaultFields(domId) {
  try {
    if (db.prepare('SELECT COUNT(*) AS n FROM profile_fields WHERE dom_id = ?').get(domId).n > 0) return;
    const ins = db.prepare('INSERT INTO profile_fields (id, dom_id, label, position) VALUES (?, ?, ?, ?)');
    db.transaction(() => {
      DEFAULT_FIELD_LABELS.forEach((label, i) => ins.run(crypto.randomUUID(), domId, label, i));
    })();
  } catch (err) { console.error('[db] profile field seed failed:', err); }
}

// One-time migration: Doms who registered before these tables existed.
try {
  const doms = db.prepare("SELECT id FROM users WHERE role = 'dom'").all();
  if (doms.length && db.prepare('SELECT COUNT(*) AS n FROM profile_fields').get().n === 0) {
    db.transaction(() => { for (const d of doms) seedDefaultFields(d.id); })();
  }
} catch (err) { console.error('[db] profile field migration failed:', err); }

// Migrations for databases created before punishments / password reset / auto-punish.
function addColumn(table, column, def) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`); } catch { /* column exists */ }
}
addColumn('tasks', 'auto_punish_title', "TEXT NOT NULL DEFAULT ''");
addColumn('tasks', 'due_date', 'TEXT');
addColumn('users', 'pw_version', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'weekly_punish_title', "TEXT NOT NULL DEFAULT ''");
addColumn('users', 'weekly_punish_pct', 'INTEGER');

// Migration: carry every already-shared entry's visibility over, per submissive,
// then retire the broadcast flag. Only existing rows are touched; the flag stays 0.
try {
  if (db.prepare('SELECT COUNT(*) AS n FROM entries WHERE shared_with_sub = 1').get().n > 0) {
    const shared = db.prepare('SELECT id, owner_id FROM entries WHERE shared_with_sub = 1').all();
    const subsOf = db.prepare("SELECT id FROM users WHERE dom_id = ? AND role = 'sub'");
    const addShare = db.prepare('INSERT OR IGNORE INTO entry_shares (entry_id, sub_id) VALUES (?, ?)');
    db.transaction(() => {
      for (const e of shared) for (const s of subsOf.all(e.owner_id)) addShare.run(e.id, s.id);
      db.prepare('UPDATE entries SET shared_with_sub = 0 WHERE shared_with_sub = 1').run();
    })();
  }
} catch (err) { console.error('[db] entry_shares migration failed:', err); }

module.exports = db;
module.exports.DATA_DIR = DATA_DIR;
module.exports.UPLOAD_DIR = UPLOAD_DIR;
module.exports.seedDefaultFields = seedDefaultFields;