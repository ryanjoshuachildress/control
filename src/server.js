const express = require('express');
const path = require('path');
const fs = require('fs');
const cookieSession = require('cookie-session');
const db = require('./db');
const { DATA_DIR } = require('./db');
const mail = require('./lib/mail');
const { requireAuth, attachUser, interactionOn } = require('./lib/auth');
const { startScheduler } = require('./lib/scheduler');

const authRoutes = require('./routes/auth');
const pairRoutes = require('./routes/pair');
const taskRoutes = require('./routes/tasks');
const checkinRoutes = require('./routes/checkins');
const journalRoutes = require('./routes/journals');
const punishmentRoutes = require('./routes/punishments');
const statsRoutes = require('./routes/stats');
const profileRoutes = require('./routes/profiles');
const commentRoutes = require('./routes/comments');
const feedRoutes = require('./routes/feed');
const momentRoutes = require('./routes/moments');
const immichRoutes = require('./routes/immich');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

const isSecure = process.env.COOKIE_SECURE === '1';
app.use(cookieSession({
  name: 'control.sid',
  keys: [process.env.SESSION_SECRET || 'change-me-in-production'],
  maxAge: 30 * 24 * 3600 * 1000,
  sameSite: 'lax',
  secure: isSecure,
  httpOnly: true
}));

app.use(express.json({ limit: '512kb' }));

// session → req.user for routes that don't load it themselves
app.use(attachUser);

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api/auth', authRoutes);
app.use('/api/pair', pairRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/checkins', checkinRoutes);
app.use('/api', journalRoutes);
app.use('/api/punishments', punishmentRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/comments', commentRoutes);
app.use('/api/feed', feedRoutes);
app.use('/api/moments', momentRoutes);
app.use('/api/immich', immichRoutes);

// Evidence files — only the submitting sub or their Dom may view them.
// Profile photos (prefix pf-) follow the same rule, and feed attachments
// (prefix fp-) are visible to exactly who can see the post itself: the
// household's Dom, the post's author, or a targeted submissive (plus any
// household submissive for posts marked household-wide while the interaction
// switch is on). Moment media (prefix mt-) belongs to one person's version:
// the household Dom and the author always see it; a submissive in that
// moment sees it once their own version is recorded — and a fellow
// submissive's media only when the interaction switch is on.
app.get('/uploads/:file', requireAuth, async (req, res) => {
  if (!/^[\w.-]+$/.test(req.params.file)) return res.status(400).json({ error: 'Invalid path' });
  const row =
    (await db.get(
      `SELECT t.sub_id, s.dom_id FROM completions c
       JOIN tasks t ON t.id = c.task_id
       JOIN users s ON s.id = t.sub_id
       WHERE c.evidence_path = ?`, req.params.file)) ||
    (await db.get('SELECT sub_id, dom_id FROM punishments WHERE evidence_path = ?', req.params.file)) ||
    (await db.get(
      `SELECT pv.sub_id, u.dom_id FROM profile_values pv
       JOIN profile_fields f ON f.id = pv.field_id AND f.kind = 'photo'
       JOIN users u ON u.id = pv.sub_id
       WHERE pv.value = ?`, req.params.file)) ||
    (await db.get(
      `SELECT p.id AS post_id, p.author_id, p.dom_id, p.audience
       FROM feed_attachments a JOIN feed_posts p ON p.id = a.post_id
       WHERE a.path = ?`, req.params.file)) ||
    (await db.get(
      `SELECT v.author_id, g.id AS group_id, g.dom_id,
              (SELECT 1 FROM moment_versions mv WHERE mv.group_id = g.id AND mv.author_id = ?) AS mine
       FROM moment_attachments a
       JOIN moment_versions v ON v.id = a.version_id
       JOIN moment_groups g ON g.id = v.group_id
       WHERE a.path = ?`, req.user.id, req.params.file));
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.group_id) {
    let allowed = req.user.id === row.author_id
      || (req.user.role === 'dom' && req.user.id === row.dom_id);
    if (!allowed && req.user.role === 'sub' && row.mine && req.user.dom_id === row.dom_id) {
      allowed = row.author_id === row.dom_id || await interactionOn(row.dom_id);
    }
    if (!allowed) return res.status(403).json({ error: 'Not allowed' });
    return res.sendFile(path.join(DATA_DIR, 'uploads', req.params.file));
  }
  const allowed = row.post_id
    ? req.user.id === row.author_id
      || (req.user.role === 'dom' && req.user.id === row.dom_id)
      || (req.user.role === 'sub' && !!(await db.get(
        'SELECT 1 AS ok FROM feed_post_targets WHERE post_id = ? AND sub_id = ?',
        row.post_id, req.user.id)))
      || (req.user.role === 'sub' && req.user.dom_id && row.dom_id === req.user.dom_id
        && row.audience === 'household' && await interactionOn(req.user.dom_id))
    : req.user.role === 'sub'
      ? req.user.id === row.sub_id
      : req.user.role === 'dom' && req.user.id === row.dom_id;
  if (!allowed) return res.status(403).json({ error: 'Not allowed' });
  res.sendFile(path.join(DATA_DIR, 'uploads', req.params.file));
});

// Frontend serving. The React build lives in web/dist (content-hashed assets);
// the legacy static SPA in public/ is kept until the new frontend is fully
// ported. Browsers must revalidate index.html on every load (ETag → cheap 304
// when unchanged) so a redeploy is picked up by a plain refresh — without that
// heuristic caching left users on the old script until a manual hard-refresh
// (caught 2026-10-06). Only hashed bundles get long-lived caching.
const staticRoots = ['web/dist', 'public']
  .map((rel) => path.join(__dirname, '..', rel))
  .filter((dir) => fs.existsSync(dir));
if (staticRoots.length) {
  app.use(express.static(staticRoots[0], {
    setHeaders: (res, filePath) => {
      res.setHeader('Cache-Control',
        filePath.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
    }
  }));
}

// JSON 404 + error handling for the API
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, _next) => {
  console.error('[server]', err);
  if (res.headersSent) return;
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

async function main() {
  const PORT = Number(process.env.PORT || 3000);
  await db.migrate(); // versioned migrations keep the schema current on boot
  mail.init();
  startScheduler();

  app.listen(PORT, () => {
    console.log(`Control listening on port ${PORT} (db: ${process.env.DATABASE_URL ? 'postgres' : 'none'}, data: ${DATA_DIR}, secure cookies: ${isSecure})`);
  });
}

main().catch((err) => {
  console.error('[server] failed to start:', err);
  process.exit(1);
});