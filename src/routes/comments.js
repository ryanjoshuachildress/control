const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const mail = require('../lib/mail');
const { notifyUser } = require('../lib/notify');
const { requireAuth, attachUser, interactionOn } = require('../lib/auth');
const esc = s => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const router = require("../lib/router")();

router.use(attachUser);

// Who can read and write in a thread on a journal entry:
//   sub-owned entry  → that sub + their Dom
//   Dom-owned entry  → the Dom + the submissive(s) it is shared with
// Tasks and punishments: that item's Dom and its submissive only.
// Check-ins: the submissive who wrote it and their Dom.
// Moments: everyone who can see the moment at all — the household Dom, its
// creator, and every submissive listed in it (recording a version is not
// required to chat about the moment itself).
async function momentAudience(row) {
  const ids = new Set([row.dom_id, row.created_by]);
  for (const r of await db.all('SELECT sub_id FROM moment_group_subs WHERE group_id = ?', row.id)) {
    ids.add(r.sub_id);
  }
  return [...ids];
}

async function entryAudience(entry) {
  const owner = await db.get('SELECT id, role, dom_id FROM users WHERE id = ?', entry.owner_id);
  if (!owner) return [];
  if (owner.role === 'sub') {
    const ids = [owner.id];
    if (owner.dom_id) ids.push(owner.dom_id);
    return ids;
  }
  return [owner.id,
    ...(await db.all('SELECT sub_id FROM entry_shares WHERE entry_id = ?', entry.id)).map(r => r.sub_id)];
}

// Feed post threads: sub-authored → the sub and their Dom only (unless the
// post is household-wide — written while the Dom's interaction switch was on
// — then every household submissive is in the thread too); dom-authored
// → the Dom plus exactly the submissives it was targeted to at creation.
async function postAudience(post) {
  if (post.author_role !== 'dom') {
    const ids = [post.author_id];
    if (post.author_dom_id) ids.push(post.author_dom_id);
    if (post.audience === 'household' && post.dom_id && await interactionOn(post.dom_id)) {
      for (const r of await db.all("SELECT id FROM users WHERE dom_id = ? AND role = 'sub'", post.dom_id)) {
        if (r.id !== post.author_id) ids.push(r.id);
      }
    }
    return ids;
  }
  return [post.author_id,
    ...(await db.all('SELECT sub_id FROM feed_post_targets WHERE post_id = ?', post.id)).map(r => r.sub_id)];
}

async function checkinAudience(row) {
  const sub = await db.get('SELECT dom_id FROM users WHERE id = ?', row.sub_id);
  const ids = [row.sub_id];
  if (sub && sub.dom_id) ids.push(sub.dom_id);
  return ids;
}

// Deep link where each recipient lands on the referenced thread. Dom recipients
// view items through their submissive's pages; subs through their own.
async function threadPath(subject, row, role) {
  const focus = `focus=${subject}:${row.id}`;
  if (subject === 'task') return role === 'dom' ? `sub/${row.sub_id}/tasks?${focus}` : `today?${focus}`;
  if (subject === 'punishment') return role === 'dom' ? `sub/${row.sub_id}/punishments?${focus}` : `today?${focus}`;
  if (subject === 'checkin') return role === 'dom' ? `sub/${row.sub_id}/checkins?${focus}` : `today?${focus}`;
  if (subject === 'post') return `feed?${focus}`;
  // Journal entry: a Dom reads a sub-owned entry in that sub's journal view.
  if (subject === 'entry') {
    const owner = await db.get('SELECT role FROM users WHERE id = ?', row.owner_id);
    if (role === 'dom' && owner && owner.role === 'sub') return `sub/${row.owner_id}/journal?${focus}`;
  }
  if (subject === 'moment') return `moments?${focus}`;
  return `journal?${focus}`;
}

const ITEM_FINDERS = {
  entry: (id) => db.get('SELECT * FROM entries WHERE id = ?', id),
  task: (id) => db.get('SELECT * FROM tasks WHERE id = ?', id),
  punishment: (id) => db.get('SELECT * FROM punishments WHERE id = ?', id),
  checkin: (id) => db.get('SELECT * FROM checkins WHERE id = ?', id),
  moment: (id) => db.get('SELECT * FROM moment_groups WHERE id = ?', id),
  post: (id) => db.get(
    `SELECT p.*, u.role AS author_role, u.dom_id AS author_dom_id
     FROM feed_posts p JOIN users u ON u.id = p.author_id WHERE p.id = ?`, id)
};

// Resolves the commented item (or 404s) and the audience allowed into its
// thread. Throws when the user is not part of the audience.
async function loadThread(req) {
  const subject = req.params.subject;
  const id = req.params.subjectId;
  const find = ITEM_FINDERS[subject];
  if (!find) {
    const err = new Error('Unknown subject'); err.status = 404; throw err;
  }
  const row = await find(id);
  if (!row) {
    const err = new Error('Item not found'); err.status = 404; throw err;
  }
  const audience = subject === 'entry' ? await entryAudience(row)
    : subject === 'post' ? await postAudience(row)
    : subject === 'moment' ? await momentAudience(row)
    : subject === 'checkin' ? await checkinAudience(row)
    : [row.dom_id, row.sub_id];
  if (!audience.includes(req.user.id)) {
    const err = new Error('This conversation is not yours'); err.status = 403; throw err;
  }
  return { subject, row, audience };
}

// The subject description to reference in notifications (kept short).
async function subjectLabel(subject, row) {
  if (subject === 'task') return `the task <strong>${esc(row.title)}</strong>`;
  if (subject === 'punishment') return `the punishment <strong>${esc(row.title)}</strong>`;
  if (subject === 'checkin') return `their <strong>${esc(row.date)}</strong> check-in`;
  if (subject === 'post') return 'a feed post';
  if (subject === 'moment') return `the moment <strong>${esc(row.title)}</strong>`;
  const p = await db.get('SELECT text FROM prompts WHERE id = ?', row.prompt_id);
  return `a journal entry${p ? ` (“${esc(p.text.slice(0, 100))}”)` : ''}`;
}

router.get('/:subject/:subjectId', requireAuth, async (req, res) => {
  const { row } = await loadThread(req);
  // Only the Dom moderates comment threads; submissives see no delete control.
  const canDelete = () => req.user.role === 'dom';
  const comments = (await db.all(
    `SELECT c.id, c.author_id, c.body, c.created_at, u.name AS author_name, u.title AS author_title
     FROM comments c JOIN users u ON u.id = c.author_id
     WHERE c.subject = ? AND c.subject_id = ?
     ORDER BY c.created_at ASC LIMIT 200`, req.params.subject, req.params.subjectId))
    .map(c => ({ ...c, can_delete: canDelete(c) }));
  res.json({ comments });
});

router.post('/:subject/:subjectId', requireAuth, async (req, res) => {
  const { subject, row, audience } = await loadThread(req);
  const body = String((req.body || {}).body || '').trim();
  if (!body) return res.status(400).json({ error: 'Comment text is required' });

  const id = crypto.randomUUID();
  await db.run('INSERT INTO comments (id, subject, subject_id, author_id, body) VALUES (?, ?, ?, ?, ?)',
    id, subject, row.id, req.user.id, body.slice(0, 2000));

  // Notify everyone else in the thread (never the author) on their enabled
  // channels — notifyUser checks each recipient's email/SMS prefs.
  const authorName = req.user.title ? `${req.user.title} ${req.user.name}` : req.user.name;
  const label = await subjectLabel(subject, row);
  for (const uid of audience) {
    if (uid === req.user.id) continue;
    const u = await db.get('SELECT id, role FROM users WHERE id = ?', uid);
    if (!u) continue;
    const path = await threadPath(subject, row, u.role);
    notifyUser(uid, {
      subject: `New comment from ${authorName}`,
      html: `<p><strong>${esc(authorName)}</strong> commented on ${label}:</p>
             <p>“${esc(body.slice(0, 300))}${body.length > 300 ? '…' : ''}”</p>
             <p>Reply in Control to keep the conversation going.</p>
             ${mail.viewLink(path, 'View the conversation')}`,
      path
    });
  }
  res.json({ ok: true, id });
});

// Only the Dom may remove a comment (within their thread audience scope).
router.delete('/id/:commentId', requireAuth, async (req, res) => {
  const c = await db.get('SELECT * FROM comments WHERE id = ?', req.params.commentId);
  if (!c) return res.status(404).json({ error: 'Comment not found' });
  let allowed = false;
  if (req.user.role === 'dom') {
    const row = ITEM_FINDERS[c.subject] && await ITEM_FINDERS[c.subject](c.subject_id);
    allowed = !!row && (c.subject === 'entry'
      ? (await entryAudience(row)).includes(req.user.id)
      : c.subject === 'post' ? (await postAudience(row)).includes(req.user.id)
      : c.subject === 'moment' ? (await momentAudience(row)).includes(req.user.id)
      : (c.subject === 'checkin' ? await checkinAudience(row) : [row.dom_id, row.sub_id]).includes(req.user.id));
  }
  if (!allowed) return res.status(403).json({ error: 'Not allowed' });
  await db.run('DELETE FROM comments WHERE id = ?', c.id);
  res.json({ ok: true });
});

module.exports = router;