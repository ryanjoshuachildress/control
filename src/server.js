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

// Evidence files — only the submitting sub or their Dom may view them.
// Profile photos (prefix pf-, stored as profile_values) follow the same rule.
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
       WHERE pv.value = ?`).get(req.params.file);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const allowed = req.user.role === 'sub'
    ? req.user.id === row.sub_id
    : req.user.role === 'dom' && req.user.id === row.dom_id;
  if (!allowed) return res.status(403).json({ error: 'Not allowed' });
  res.sendFile(path.join(DATA_DIR, 'uploads', req.params.file));
});

app.use(express.static(path.join(__dirname, '..', 'public')));

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