const express = require('express');
const path = require('path');
const cookieSession = require('cookie-session');
const db = require('./db');
const { DATA_DIR } = require('./db');
const mail = require('./lib/mail');
const { requireAuth, attachUser } = require('./lib/auth');
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

// Evidence files — only the submitting sub or their Dom may view them.
// Profile photos (prefix pf-) follow the same rule, and feed attachments
// (prefix fp-) are visible to exactly who can see the post itself: the
// household's Dom, the post's author, or a targeted submissive.
app.get('/uploads/:file', requireAuth, (req, res) => {
  if (!/^[\w.-]+$/.test(req.params.file)) return res.status(400).json({ error: 'Invalid path' });
  const row =
    db.prepare(
      `SELECT t.sub_id, s.dom_id FROM completions c
       JOIN tasks t ON t.id = c.task_id
       JOIN users s ON s.id = t.sub_id
       WHERE c.evidence_path = ?`).get(req.params.file) ||
    db.prepare('SELECT sub_id, dom_id FROM punishments WHERE evidence_path = ?').get(req.params.file) ||
    db.prepare(
      `SELECT pv.sub_id, u.dom_id FROM profile_values pv
       JOIN profile_fields f ON f.id = pv.field_id AND f.kind = 'photo'
       JOIN users u ON u.id = pv.sub_id
       WHERE pv.value = ?`).get(req.params.file) ||
    db.prepare(
      `SELECT p.id AS post_id, p.author_id, p.dom_id
       FROM feed_attachments a JOIN feed_posts p ON p.id = a.post_id
       WHERE a.path = ?`).get(req.params.file);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const allowed = row.post_id
    ? req.user.id === row.author_id
      || (req.user.role === 'dom' && req.user.id === row.dom_id)
      || (req.user.role === 'sub' && !!db.prepare(
        'SELECT 1 AS ok FROM feed_post_targets WHERE post_id = ? AND sub_id = ?')
          .get(row.post_id, req.user.id))
    : req.user.role === 'sub'
      ? req.user.id === row.sub_id
      : req.user.role === 'dom' && req.user.id === row.dom_id;
  if (!allowed) return res.status(403).json({ error: 'Not allowed' });
  res.sendFile(path.join(DATA_DIR, 'uploads', req.params.file));
});

// Frontend assets: browsers must revalidate on every load (ETag → cheap 304
// when unchanged), so a redeploy is picked up by a plain refresh and nobody
// keeps running a stale app.js. Without this, heuristic caching left users on
// the old script until a manual hard-refresh (caught 2026-10-06).
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache')
}));

// JSON 404 + error handling for the API
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, _next) => {
  console.error('[server]', err);
  if (res.headersSent) return;
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

const PORT = Number(process.env.PORT || 3000);
mail.init();
startScheduler();

app.listen(PORT, () => {
  console.log(`Control listening on port ${PORT} (data: ${DATA_DIR}, secure cookies: ${isSecure})`);
});