const path = require('path');
const fs = require('fs');
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

CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Migrations for databases created before punishments / password reset / auto-punish.
function addColumn(table, column, def) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`); } catch { /* column exists */ }
}
addColumn('tasks', 'auto_punish_title', "TEXT NOT NULL DEFAULT ''");
addColumn('users', 'pw_version', 'INTEGER NOT NULL DEFAULT 0');

module.exports = db;
module.exports.DATA_DIR = DATA_DIR;
module.exports.UPLOAD_DIR = UPLOAD_DIR;