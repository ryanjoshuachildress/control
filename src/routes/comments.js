const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const mail = require('../lib/mail');
const { requireAuth, attachUser } = require('../lib/auth');
const esc = s => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const router = express.Router();

router.use(attachUser);

// Who can read and write in a thread on a journal entry:
//   sub-owned entry  → that sub + their Dom
//   Dom-owned entry  → the Dom + the submissive(s) it is shared with
// Tasks and punishments: that item's Dom and its submissive only.
// Check-ins: the submissive who wrote it and their Dom.
function entryAudience(entry) {
  const owner = db.prepare('SELECT id, role, dom_id FROM users WHERE id = ?').get(entry.owner_id);
  if (!owner) return [];
  if (owner.role === 'sub') {
    const ids = [owner.id];
    if (owner.dom_id) ids.push(owner.dom_id);
    return ids;
  }
  return [owner.id,
    ...db.prepare('SELECT sub_id FROM entry_shares WHERE entry_id = ?').all(entry.id).map(r => r.sub_id)];
}

function checkinAudience(row) {
  const sub = db.prepare('SELECT dom_id FROM users WHERE id = ?').get(row.sub_id);
  const ids = [row.sub_id];
  if (sub && sub.dom_id) ids.push(sub.dom_id);
  return ids;
}

// Resolves the commented item (or 404s) and the audience allowed into its
// thread. Throws when the user is not part of the audience.
function loadThread(req) {
  const subject = req.params.subject;
  const id = req.params.subjectId;
  const finders = {
    entry: () => db.prepare('SELECT * FROM entries WHERE id = ?').get(id),
    task: () => db.prepare('SELECT * FROM tasks WHERE id = ?').get(id),
    punishment: () => db.prepare('SELECT * FROM punishments WHERE id = ?').get(id),
    checkin: () => db.prepare('SELECT * FROM checkins WHERE id = ?').get(id)
  };
  const find = finders[subject];
  if (!find) {
    const err = new Error('Unknown subject'); err.status = 404; throw err;
  }
  const row = find();
  if (!row) {
    const err = new Error('Item not found'); err.status = 404; throw err;
  }
  const audience = subject === 'entry' ? entryAudience(row)
    : subject === 'checkin' ? checkinAudience(row)
    : [row.dom_id, row.sub_id];
  if (!audience.includes(req.user.id)) {
    const err = new Error('This conversation is not yours'); err.status = 403; throw err;
  }
  return { subject, row, audience };
}

// The subject description to reference in notifications (kept short).
function subjectLabel(subject, row) {
  if (subject === 'task') return `the task <strong>${esc(row.title)}</strong>`;
  if (subject === 'punishment') return `the punishment <strong>${esc(row.title)}</strong>`;
  if (subject === 'checkin') return `their <strong>${esc(row.date)}</strong> check-in`;
  const p = db.prepare('SELECT text FROM prompts WHERE id = ?').get(row.prompt_id);
  return `a journal entry${p ? ` (“${esc(p.text.slice(0, 100))}”)` : ''}`;
}

router.get('/:subject/:subjectId', requireAuth, (req, res) => {
  const { row } = loadThread(req);
  const canDelete = c => c.author_id === req.user.id || req.user.role === 'dom';
  const comments = db.prepare(
    `SELECT c.id, c.author_id, c.body, c.created_at, u.name AS author_name, u.title AS author_title
     FROM comments c JOIN users u ON u.id = c.author_id
     WHERE c.subject = ? AND c.subject_id = ?
     ORDER BY c.created_at ASC LIMIT 200`).all(req.params.subject, req.params.subjectId)
    .map(c => ({ ...c, can_delete: canDelete(c) }));
  res.json({ comments });
});

router.post('/:subject/:subjectId', requireAuth, (req, res) => {
  const { subject, row, audience } = loadThread(req);
  const body = String((req.body || {}).body || '').trim();
  if (!body) return res.status(400).json({ error: 'Comment text is required' });

  const id = crypto.randomUUID();
  db.prepare('INSERT INTO comments (id, subject, subject_id, author_id, body) VALUES (?, ?, ?, ?, ?)')
    .run(id, subject, row.id, req.user.id, body.slice(0, 2000));

  // Notify everyone else in the thread (never the author), honoring mail prefs.
  const authorName = req.user.title ? `${req.user.title} ${req.user.name}` : req.user.name;
  const label = subjectLabel(subject, row);
  for (const uid of audience) {
    if (uid === req.user.id) continue;
    const u = db.prepare('SELECT email, email_notifications FROM users WHERE id = ?').get(uid);
    if (!u || !u.email_notifications) continue;
    mail.send(u.email, `New comment from ${authorName}`,
      `<p><strong>${esc(authorName)}</strong> commented on ${label}:</p>
       <p>“${esc(body.slice(0, 300))}${body.length > 300 ? '…' : ''}”</p>
       <p>Reply in Control to keep the conversation going.</p>`);
  }
  res.json({ ok: true, id });
});

// Author or the thread's Dom may remove a comment.
router.delete('/id/:commentId', requireAuth, (req, res) => {
  const c = db.prepare('SELECT * FROM comments WHERE id = ?').get(req.params.commentId);
  if (!c) return res.status(404).json({ error: 'Comment not found' });
  let allowed = c.author_id === req.user.id;
  if (!allowed && req.user.role === 'dom') {
    const finders = {
      entry: () => db.prepare('SELECT * FROM entries WHERE id = ?').get(c.subject_id),
      task: () => db.prepare('SELECT * FROM tasks WHERE id = ?').get(c.subject_id),
      punishment: () => db.prepare('SELECT * FROM punishments WHERE id = ?').get(c.subject_id),
      checkin: () => db.prepare('SELECT * FROM checkins WHERE id = ?').get(c.subject_id)
    };
    const row = finders[c.subject] && finders[c.subject]();
    allowed = !!row && (c.subject === 'entry'
      ? entryAudience(row).includes(req.user.id)
      : (c.subject === 'checkin' ? checkinAudience(row) : [row.dom_id, row.sub_id]).includes(req.user.id));
  }
  if (!allowed) return res.status(403).json({ error: 'Not allowed' });
  db.prepare('DELETE FROM comments WHERE id = ?').run(c.id);
  res.json({ ok: true });
});

module.exports = router;