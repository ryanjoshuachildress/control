const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const mail = require('../lib/mail');
const { seedDefaultFields } = require('../db');
const { attachUser, startSession, requireAuth } = require('../lib/auth');

const router = require("../lib/router")();

// Attach the signed-in user (from session) to every request first.
router.use(attachUser);

// --- password reset via email ---
const resetUrl = () => `${process.env.BASE_URL || 'http://localhost:3000'}/#/reset/`;

router.post('/forgot', async (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  res.json({ ok: true, message: 'If that email is registered, a reset link is on its way.' });
  if (!email) return;
  const user = await db.get('SELECT * FROM users WHERE email = ?', email);
  if (!user) return;

  await db.run('DELETE FROM password_resets WHERE user_id = ?', user.id);
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await db.run('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)',
    tokenHash, user.id, expiresAt);

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

router.post('/reset', async (req, res) => {
  const { token, password } = req.body || {};
  if (!password || String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (!token) return res.status(400).json({ error: 'This reset link is invalid or has expired' });
  const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
  const row = await db.get('SELECT * FROM password_resets WHERE token_hash = ?', tokenHash);
  if (!row || row.expires_at < new Date().toISOString()) {
    // Expired or missing tokens are cleaned up so they can't linger.
    if (row) await db.run('DELETE FROM password_resets WHERE token_hash = ?', tokenHash);
    return res.status(400).json({ error: 'This reset link is invalid or has expired' });
  }
  await db.run("UPDATE users SET password_hash = ?, pw_version = pw_version + 1 WHERE id = ?",
    bcrypt.hashSync(String(password), 10), row.user_id);
  await db.run('DELETE FROM password_resets WHERE user_id = ?', row.user_id);
  res.json({ ok: true });
});

const publicUser = async (u) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  title: u.title,
  timezone: u.timezone,
  dom_id: u.dom_id,
  email_notifications: !!u.email_notifications,
  sms_notifications: !!u.sms_notifications,
  phone: u.phone || '',
  allow_sub_interaction: !!u.allow_sub_interaction,
  // Whether an Immich API key is on file for this user (the key itself never
  // leaves the server).
  immich_linked: !!u.immich_key,
  // Dominant-only household switches: the SMTP master switch they manage from
  // Settings, and whether the OpenSMS gateway is configured (URL + token are
  // on file — neither is ever echoed back).
  smtp_master: u.role === 'dom' ? !!u.smtp_notifications : undefined,
  sms_linked: u.role === 'dom' ? !!u.sms_gateway_url : undefined,
  // For submissives: whether THEIR household allows cross-submissive
  // interaction (drives the "write to everyone" audience choice).
  household_interaction: u.role === 'sub' && u.dom_id
    ? !!(await db.get('SELECT allow_sub_interaction AS v FROM users WHERE id = ?', u.dom_id))?.v
    : false,
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

router.post('/register', async (req, res) => {
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
    if (await db.get('SELECT 1 FROM users WHERE invite_code = ?', code)) {
      inviteCodeForDom = 'CTRL-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    }
    inviteCodeForDom = inviteCodeForDom || code;
  } else if (inviteCode) {
    const dom = await db.get("SELECT id FROM users WHERE invite_code = ? AND role = 'dom'", String(inviteCode).trim().toUpperCase());
    if (!dom) return res.status(400).json({ error: 'Invite code not recognized — leave it empty to pair later' });
    domId = dom.id;
  }

  const id = crypto.randomUUID();
  try {
    await db.run(`INSERT INTO users (id, email, password_hash, name, role, title, timezone, invite_code, dom_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, email.trim().toLowerCase(), bcrypt.hashSync(password, 10), name.trim(),
      role, cleanTitle, validateTimezone(timezone || 'UTC'), inviteCodeForDom, domId);
  } catch (err) {
    // PostgreSQL reports duplicate keys via SQLSTATE 23505
    if (String(err.message).includes('duplicate key')) return res.status(409).json({ error: 'That email is already registered' });
    throw err;
  }

  startSession(req, id, 0);
  if (role === 'dom') await seedDefaultFields(id); // starter profile fields
  res.json({ user: await publicUser(await db.get('SELECT * FROM users WHERE id = ?', id)) });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  const user = await db.get('SELECT * FROM users WHERE email = ?', String(email || '').trim().toLowerCase());
  if (!user || !bcrypt.compareSync(String(password || ''), user.password_hash)) {
    return res.status(401).json({ error: 'Incorrect email or password' });
  }
  startSession(req, user.id, user.pw_version);
  res.json({ user: await publicUser(user) });
});

router.post('/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

router.get('/me', requireAuth, async (req, res) => {
  // immich_origin lets the frontend offer "Browse library" pickers everywhere
  // media is used (null when no Immich integration is configured).
  const origin = (process.env.IMMICH_URL || '').replace(/\/+$/, '') || null;
  res.json({ user: await publicUser(req.user), immich_origin: origin });
});

router.patch('/me', requireAuth, async (req, res) => {
  const { name, title, timezone, email_notifications, sms_notifications, phone,
          allow_sub_interaction, smtp_notifications, sms_gateway_url, sms_gateway_token, immich_key } = req.body || {};
  const updates = {};
  if (name !== undefined) {
    if (!name || String(name).trim().length === 0 || String(name).length > 80) return res.status(400).json({ error: 'Name is required' });
    updates.name = String(name).trim();
  }
  if (title !== undefined) updates.title = String(title || '').trim().slice(0, 60);
  if (timezone !== undefined) updates.timezone = validateTimezone(String(timezone));
  if (email_notifications !== undefined) updates.email_notifications = email_notifications ? 1 : 0;
  if (sms_notifications !== undefined) updates.sms_notifications = sms_notifications ? 1 : 0;
  // Phone number for SMS delivery — digits with a country code (+1…), so the
  // gateway can route it. Spaces/dashes are stripped before the check.
  if (phone !== undefined) {
    const num = String(phone || '').replace(/[\s().-]/g, '');
    if (num && !/^\+\d{6,15}$/.test(num)) return res.status(400).json({ error: 'Phone must start with the country code, e.g. +16195551234' });
    updates.phone = num.slice(0, 20);
  }
  // Household master switch — only the Dominant can flip it.
  if (allow_sub_interaction !== undefined && req.user.role === 'dom') {
    updates.allow_sub_interaction = allow_sub_interaction ? 1 : 0;
  }
  if (smtp_notifications !== undefined && req.user.role === 'dom') {
    updates.smtp_notifications = smtp_notifications ? 1 : 0;
  }
  // OpenSMS gateway, household-wide — URL and token are set together (both
  // blank clears it). Like immich_key, the token is never echoed back.
  if (sms_gateway_url !== undefined || sms_gateway_token !== undefined) {
    if (req.user.role !== 'dom') return res.status(403).json({ error: 'Only the Dominant configures the household gateway' });
    if (sms_gateway_url === undefined || sms_gateway_token === undefined) {
      return res.status(400).json({ error: 'Gateway URL and token are set together' });
    }
    const gwUrl = String(sms_gateway_url || '').trim();
    const gwToken = String(sms_gateway_token || '').trim();
    if (gwUrl && !/^(https?):\/\/\S+$/.test(gwUrl)) {
      return res.status(400).json({ error: 'Gateway URL must be a full http(s) address, e.g. http://192.168.9.130:9292/sms/' });
    }
    if (gwToken && !gwUrl) {
      return res.status(400).json({ error: 'Gateway token needs the URL too' });
    }
    updates.sms_gateway_url = gwUrl.slice(0, 300);
    updates.sms_gateway_token = gwToken.slice(0, 255);
  }
  // Immich API key — set to a trimmed value, or '' to clear. Validated against
  // Immich when it's reachable; never echoed back afterwards.
  if (immich_key !== undefined) {
    const key = String(immich_key || '').trim().slice(0, 100);
    if (key) {
      const base = (process.env.IMMICH_URL || '').replace(/\/+$/, '');
      if (base) {
        try {
          const probe = await fetch(`${base}/api/users/me`, { headers: { 'x-api-key': key }, signal: AbortSignal.timeout(8000) });
          if (probe.status !== 200) return res.status(400).json({ error: 'Immich rejected that API key' });
        } catch {
          return res.status(400).json({ error: 'Could not reach Immich to verify the key — try again later' });
        }
      }
      updates.immich_key = key;
    } else {
      updates.immich_key = '';
    }
  }
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nothing to update' });

  const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  await db.run(`UPDATE users SET ${sets} WHERE id = ?`, ...Object.values(updates), req.user.id);
  res.json({ user: await publicUser(await db.get('SELECT * FROM users WHERE id = ?', req.user.id)) });
});

module.exports = router;