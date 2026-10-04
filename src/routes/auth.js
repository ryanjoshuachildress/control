const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const mail = require('../lib/mail');
const { attachUser, startSession, requireAuth } = require('../lib/auth');

const router = express.Router();

// Attach the signed-in user (from session) to every request first.
router.use(attachUser);

// --- password reset via email ---
const resetUrl = () => `${process.env.BASE_URL || 'http://localhost:3000'}/#/reset/`;

router.post('/forgot', (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  res.json({ ok: true, message: 'If that email is registered, a reset link is on its way.' });
  if (!email) return;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) return;

  db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(user.id);
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(tokenHash, user.id, expiresAt);

  mail.send(user.email, 'Reset your password',
    `<p>A password reset was requested for your account. This link is valid for one hour and can be used once:</p>
     <p><a style="background:${'#c58a9a'};color:#21131a;padding:10px 18px;border-radius:10px;text-decoration:none;font-weight:600" href="${resetUrl()}${token}">Reset password</a></p>
     <p style="font-size:12px;color:#7d7890">If you didn't request this, you can ignore this email — your password is unchanged.</p>`);
  if (!mail.smtpEnabled()) {
    // Without SMTP, surface the one-time link in the container log so reset still works.
    console.log(`[auth] SMTP off — reset link for ${email}: ${resetUrl()}${token}`);
  }
  console.log(`[auth] password reset requested for ${email}`);
});

router.post('/reset', (req, res) => {
  const { token, password } = req.body || {};
  if (!password || String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (!token) return res.status(400).json({ error: 'This reset link is invalid or has expired' });
  const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
  const row = db.prepare('SELECT * FROM password_resets WHERE token_hash = ?').get(tokenHash);
  if (!row || row.expires_at < new Date().toISOString()) {
    // Expired or missing tokens are cleaned up so they can't linger.
    if (row) db.prepare('DELETE FROM password_resets WHERE token_hash = ?').run(tokenHash);
    return res.status(400).json({ error: 'This reset link is invalid or has expired' });
  }
  db.prepare("UPDATE users SET password_hash = ?, pw_version = pw_version + 1 WHERE id = ?")
    .run(bcrypt.hashSync(String(password), 10), row.user_id);
  db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(row.user_id);
  res.json({ ok: true });
});

const publicUser = (u) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  title: u.title,
  timezone: u.timezone,
  dom_id: u.dom_id,
  email_notifications: !!u.email_notifications,
  invite_code: u.invite_code
});

function validateTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

router.post('/register', (req, res) => {
  const { email, password, name, role, title, timezone, inviteCode } = req.body || {};
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'A valid email is required' });
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (!name || name.length > 80) return res.status(400).json({ error: 'Name is required' });
  if (role !== 'dom' && role !== 'sub') return res.status(400).json({ error: 'Choose a role (Dominant or submissive)' });
  if (req.session && req.session.userId) return res.status(400).json({ error: 'Already signed in' });

  const cleanTitle = String(title || '').trim().slice(0, 60);

  // A Dom registering with another Dom's invite code is allowed (they just stay unlinked).
  // An unpaired sub simply pairs later from Settings.
  let domId = null;
  let inviteCodeForDom = null;
  if (role === 'dom') {
    const code = 'CTRL-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    while (db.prepare('SELECT 1 FROM users WHERE invite_code = ?').get(code)) {
      inviteCodeForDom = 'CTRL-' + crypto.randomBytes(4).toString('hex').toUpperCase();
      break;
    }
    inviteCodeForDom = inviteCodeForDom || code;
  } else if (inviteCode) {
    const dom = db.prepare("SELECT id FROM users WHERE invite_code = ? AND role = 'dom'").get(String(inviteCode).trim().toUpperCase());
    if (!dom) return res.status(400).json({ error: 'Invite code not recognized — leave it empty to pair later' });
    domId = dom.id;
  }

  const id = crypto.randomUUID();
  try {
    db.prepare(`INSERT INTO users (id, email, password_hash, name, role, title, timezone, invite_code, dom_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, email.trim().toLowerCase(), bcrypt.hashSync(password, 10), name.trim(),
           role, cleanTitle, validateTimezone(timezone || 'UTC'), inviteCodeForDom, domId);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'That email is already registered' });
    throw err;
  }

  startSession(req, id, 0);
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)) });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim().toLowerCase());
  if (!user || !bcrypt.compareSync(String(password || ''), user.password_hash)) {
    return res.status(401).json({ error: 'Incorrect email or password' });
  }
  startSession(req, user.id, user.pw_version);
  res.json({ user: publicUser(user) });
});

router.post('/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

router.patch('/me', requireAuth, (req, res) => {
  const { name, title, timezone, email_notifications } = req.body || {};
  const updates = {};
  if (name !== undefined) {
    if (!name || String(name).trim().length === 0 || String(name).length > 80) return res.status(400).json({ error: 'Name is required' });
    updates.name = String(name).trim();
  }
  if (title !== undefined) updates.title = String(title || '').trim().slice(0, 60);
  if (timezone !== undefined) updates.timezone = validateTimezone(String(timezone));
  if (email_notifications !== undefined) updates.email_notifications = email_notifications ? 1 : 0;
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nothing to update' });

  const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE users SET ${sets} WHERE id = ?`).run(...Object.values(updates), req.user.id);
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
});

module.exports = router;