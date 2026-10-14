-- Initial PostgreSQL schema for Control.
--
-- Translated from the original SQLite schema (src/db.js) to its FINAL shape:
-- every ad-hoc "addColumn" evolution is inlined and the three copy-rebuild
-- migrations of comments.subject yield the widened CHECK directly. No
-- historical backfills are needed here — existing databases are imported by
-- scripts/migrate-sqlite-to-pg.js from the already-migrated SQLite file.
--
-- Conventions kept for compatibility with the application code:
--   * IDs are TEXT UUIDs (crypto.randomUUID()), so there is nothing to
--     reset after ID-preserving imports.
--   * Timestamps stay TEXT in SQLite's datetime('now') format
--     'YYYY-MM-DD HH:MM:SS' (UTC) — parseSqliteTimestamp and the whole read
--     path expect exactly these strings.
--   * Boolean-ish columns stay SMALLINT 0/1 — insert sites write plain 1/0.
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('dom','sub')),
  title TEXT NOT NULL DEFAULT '',
  timezone TEXT NOT NULL DEFAULT 'UTC',
  invite_code TEXT UNIQUE,
  dom_id TEXT REFERENCES users(id),
  email_notifications SMALLINT NOT NULL DEFAULT 1,
  -- Household-wide master switch (lives on the Dom's row, default off).
  -- Off (the default): every submissive is sandboxed from every other.
  -- On: submissives in the same dynamic may read each other's household-wide
  -- feed posts and Moment versions.
  allow_sub_interaction SMALLINT NOT NULL DEFAULT 0,
  -- Per-user Immich API key (secret — never returned to browsers). Whoever
  -- records a moment uses their own key to resolve the Immich assets they
  -- link; the household falls back to the Dom's key / IMMICH_KEY env.
  immich_key TEXT NOT NULL DEFAULT '',
  pw_version INTEGER NOT NULL DEFAULT 0,
  weekly_punish_title TEXT NOT NULL DEFAULT '',
  weekly_punish_pct INTEGER,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  dom_id TEXT NOT NULL REFERENCES users(id),
  sub_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  frequency TEXT NOT NULL CHECK (frequency IN ('daily','weekly','monthly')),
  completion_mode TEXT NOT NULL DEFAULT 'checkoff' CHECK (completion_mode IN ('checkoff','evidence')),
  active SMALLINT NOT NULL DEFAULT 1,
  auto_punish_title TEXT NOT NULL DEFAULT '',
  due_date TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX idx_tasks_sub_active ON tasks(sub_id, active);

-- One completion row per task per period (daily date / weekly Sunday / monthly YYYY-MM)
CREATE TABLE completions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  period_key TEXT NOT NULL,
  method TEXT NOT NULL,
  evidence_path TEXT,
  note TEXT DEFAULT '',
  completed_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  immich_asset_id TEXT,
  immich_media TEXT NOT NULL DEFAULT '',
  UNIQUE (task_id, period_key)
);

-- Prevents duplicate "missed deadline" emails for the same task/period
CREATE TABLE missed_alerts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  period_key TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (task_id, period_key)
);

CREATE TABLE checkins (
  id TEXT PRIMARY KEY,
  sub_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  mood INTEGER NOT NULL,
  day_rating INTEGER NOT NULL,
  best_part TEXT DEFAULT '',
  worst_part TEXT DEFAULT '',
  sexual_notes TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  updated_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (sub_id, date)
);
CREATE INDEX idx_checkins_sub ON checkins(sub_id, date DESC);

CREATE TABLE prompts (
  id TEXT PRIMARY KEY,
  dom_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sub_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('daily','weekly')),
  text TEXT NOT NULL,
  active SMALLINT NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX idx_prompts_sub ON prompts(sub_id, active);

CREATE TABLE entries (
  id TEXT PRIMARY KEY,
  prompt_id TEXT REFERENCES prompts(id) ON DELETE SET NULL,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  -- Vestigial broadcast flag, retired by entry_shares; kept so the journals
  -- route code ported from SQLite never writes an unknown column.
  shared_with_sub SMALLINT NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  updated_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX idx_entries_owner ON entries(owner_id, created_at DESC);

CREATE TABLE punishments (
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
  lapse_notified SMALLINT NOT NULL DEFAULT 0,
  immich_asset_id TEXT,
  immich_media TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  completed_at TEXT
);

-- Per-submissive sharing of Dom journal entries (replaces the shared_with_sub
-- broadcast flag, which showed a shared entry to every paired submissive).
CREATE TABLE entry_shares (
  entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  sub_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shared_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (entry_id, sub_id)
);

CREATE TABLE password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

-- One weekly-compliance evaluation per sub per week (prevents repeat punishes)
CREATE TABLE performance_alerts (
  id TEXT PRIMARY KEY,
  sub_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_key TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (sub_id, period_key)
);

-- "About the submissive" profile. The Dom owns the field catalog: adding a
-- field adds it to every paired submissive's profile. Values are
-- per-submissive and only the Dom can write them; a submissive sees a field
-- only if the Dom has exposed it to them specifically (profile_exposure).
CREATE TABLE profile_fields (
  id TEXT PRIMARY KEY,
  dom_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text','multiline','photo')),
  multiline SMALLINT NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE profile_values (
  id TEXT PRIMARY KEY,
  field_id TEXT NOT NULL REFERENCES profile_fields(id) ON DELETE CASCADE,
  sub_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  value TEXT NOT NULL DEFAULT '',
  immich_asset_id TEXT,
  immich_media TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (field_id, sub_id)
);

CREATE TABLE profile_exposure (
  field_id TEXT NOT NULL REFERENCES profile_fields(id) ON DELETE CASCADE,
  sub_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shown_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (field_id, sub_id)
);

-- Two-way comment threads on journal entries, tasks, punishments, check-ins,
-- feed posts and moment cards, between a Dom and the submissive(s) who can
-- already see the item.
CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL CHECK (subject IN ('entry','task','punishment','checkin','post','moment')),
  subject_id TEXT NOT NULL,
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX idx_comments_subject ON comments(subject, subject_id, created_at);

-- Household feed. dom_id = the household's Dominant user id (the author
-- themself for dom posts, the author's dom_id for sub posts, NULL for an
-- unpaired sub) so the Dom feed is one indexed filter over the whole dynamic.
-- Sub posts are visible to their Dom only. Dom posts are visible only to the
-- submissives listed in feed_post_targets, written at creation time — a sub
-- paired later does not see older "everyone" posts.
CREATE TABLE feed_posts (
  id TEXT PRIMARY KEY,
  dom_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  -- Sub-authored posts: 'dom' = only their Dominant (default, sandboxed);
  -- 'household' = every submissive in the dynamic may read it too (only
  -- accepted when the Dom has allow_sub_interaction on).
  audience TEXT NOT NULL DEFAULT 'dom',
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX idx_feed_posts_dom ON feed_posts(dom_id, created_at DESC);
CREATE INDEX idx_feed_posts_author ON feed_posts(author_id, created_at DESC);

CREATE TABLE feed_post_targets (
  post_id TEXT NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
  sub_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (post_id, sub_id)
);
CREATE INDEX idx_feed_targets_sub ON feed_post_targets(sub_id);

-- Photos/videos on feed posts. Files live in uploads/ named fp-*; path is the
-- uploads filename, media picks the <img> vs <video> rendering branch.
CREATE TABLE feed_attachments (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
  path TEXT NOT NULL UNIQUE,
  media TEXT NOT NULL CHECK (media IN ('image','video')),
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX idx_feed_att_post ON feed_attachments(post_id);

-- Immich assets linked onto feed posts (like moment_immich, files stay in
-- the poster's Immich library and stream through /api/immich).
CREATE TABLE feed_immich (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL,
  media TEXT NOT NULL CHECK (media IN ('image','video')),
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (post_id, asset_id)
);

-- Moments — remembered shared experiences. A moment group holds what happened
-- (when, who, planned vs spontaneous); each participant records their own
-- VERSION of it (their account, 1–5 star ratings, attachments). A submissive
-- in the group must record their own version before the Dominant's version
-- unlocks for them. Version readability between submissives is gated by the
-- household's allow_sub_interaction switch (see users).
CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  -- Household master tag list. New names created by a Dom are approved at
  -- once; names a submissive types become 'pending' until the Dom approves.
  dom_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name CITEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('approved','pending')),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (dom_id, name)
);
CREATE INDEX idx_tags_dom ON tags(dom_id);

CREATE TABLE moment_groups (
  id TEXT PRIMARY KEY,
  dom_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  mdate TEXT NOT NULL,
  mtime TEXT NOT NULL DEFAULT '',
  planned_kind TEXT NOT NULL DEFAULT 'planned'
    CHECK (planned_kind IN ('planned','spontaneous','other','both')),
  planned_other TEXT NOT NULL DEFAULT '',
  people_dom SMALLINT NOT NULL DEFAULT 0,
  people_other TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX idx_moment_groups_dom ON moment_groups(dom_id, created_at DESC);

CREATE TABLE moment_group_subs (
  group_id TEXT NOT NULL REFERENCES moment_groups(id) ON DELETE CASCADE,
  sub_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE (group_id, sub_id)
);

CREATE TABLE moment_versions (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES moment_groups(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  summary TEXT NOT NULL DEFAULT '',
  best_part TEXT NOT NULL DEFAULT '',
  worst_part TEXT NOT NULL DEFAULT '',
  again TEXT NOT NULL DEFAULT 'yes' CHECK (again IN ('yes','no')),
  review TEXT NOT NULL DEFAULT '',
  r_originality INTEGER CHECK (r_originality IS NULL OR (r_originality BETWEEN 1 AND 5)),
  r_hotness      INTEGER CHECK (r_hotness      IS NULL OR (r_hotness      BETWEEN 1 AND 5)),
  r_surprise     INTEGER CHECK (r_surprise     IS NULL OR (r_surprise     BETWEEN 1 AND 5)),
  r_connection   INTEGER CHECK (r_connection   IS NULL OR (r_connection   BETWEEN 1 AND 5)),
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE UNIQUE INDEX idx_moment_versions_author ON moment_versions(group_id, author_id);

CREATE TABLE moment_attachments (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES moment_versions(id) ON DELETE CASCADE,
  path TEXT NOT NULL UNIQUE,
  media TEXT NOT NULL CHECK (media IN ('image','video')),
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX idx_moment_att_version ON moment_attachments(version_id);

CREATE TABLE moment_tags (
  group_id TEXT NOT NULL REFERENCES moment_groups(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  UNIQUE (group_id, tag_id)
);

-- Immich assets linked into a moment version instead of uploaded copies.
-- Files stay in the user's Immich library; Control proxies thumbnails and
-- originals through /api/immich so the Immich API keys never reach browsers.
CREATE TABLE moment_immich (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES moment_versions(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL,
  media TEXT NOT NULL CHECK (media IN ('image','video')),
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (version_id, asset_id)
);
CREATE INDEX idx_moment_immich_version ON moment_immich(version_id);