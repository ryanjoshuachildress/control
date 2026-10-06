const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../db');
const { UPLOAD_DIR } = require('../db');
const mail = require('../lib/mail');
const { requireAuth, assertDomOwnsSub, attachUser } = require('../lib/auth');
const { feedUpload, mediaKind, MULTER_MAX_FILES, MAX_UPLOAD_MB } = require('../lib/uploads');

const router = express.Router();

router.use(attachUser);

// commentCount('checkin', id) — same subquery pattern as tasks.js/journals.js
const commentCount = (subject, id) => db.prepare(
  `SELECT COUNT(*) AS n FROM comments WHERE subject = '${subject}' AND subject_id = ?`).get(id).n;

const AUTHOR_FIELDS = 'u.name AS author_name, u.title AS author_title, u.role AS author_role';

// GET /api/feed — a merged household stream. Both roles can read; what each
// role sees differs:
//   Dom  → every feed post in their dynamic, plus ALL submissive submissions:
//          check-ins, task completions, completed punishments, journal entries.
//   Sub  → only what involves them: their own posts, dom posts targeted to
//          them at creation (broadcast or specific), their own submissions,
//          and dom journal entries shared with them.
// Items are unioned from their own tables (comment threads keep pointing at
// the original items — feed_posts use the 'post' comment subject; the rest
// reuse their existing subjects).
router.get('/', requireAuth, (req, res) => {
  const me = req.user;
  const items = [];

  // --- feed posts ---
  const posts = me.role === 'dom'
    ? db.prepare(
        `SELECT p.*, ${AUTHOR_FIELDS},
                (SELECT COUNT(*) FROM comments c WHERE c.subject = 'post' AND c.subject_id = p.id) AS comment_count
         FROM feed_posts p JOIN users u ON u.id = p.author_id
         WHERE p.dom_id = ? ORDER BY p.created_at DESC LIMIT 100`).all(me.id)
    : db.prepare(
        `SELECT p.*, ${AUTHOR_FIELDS},
                (SELECT COUNT(*) FROM comments c WHERE c.subject = 'post' AND c.subject_id = p.id) AS comment_count
         FROM feed_posts p JOIN users u ON u.id = p.author_id
         WHERE p.author_id = ?
            OR EXISTS (SELECT 1 FROM feed_post_targets ft WHERE ft.post_id = p.id AND ft.sub_id = ?)
         ORDER BY p.created_at DESC LIMIT 100`).all(me.id, me.id);
  const getTargets = db.prepare(
    `SELECT ft.sub_id, u.name AS sub_name FROM feed_post_targets ft
     JOIN users u ON u.id = ft.sub_id WHERE ft.post_id = ? ORDER BY u.name`);
  // Attachments for every post in one round-trip (path is UNIQUE, so grouping
  // in JS is safe).
  const attMap = {};
  if (posts.length) {
    const ids = posts.map(p => p.id);
    const atts = db.prepare(
      `SELECT post_id, path, media FROM feed_attachments
       WHERE post_id IN (${ids.map(() => '?').join(',')})
       ORDER BY created_at, path`).all(...ids);
    for (const a of atts) (attMap[a.post_id] ||= []).push({ path: a.path, media: a.media });
  }
  for (const p of posts) {
    items.push({
      kind: 'post', id: p.id, ts: p.created_at,
      author_id: p.author_id, author_name: p.author_name, author_title: p.author_title,
      author_role: p.author_role, text: p.body,
      attachments: attMap[p.id] || [],
      comment_subject: 'post', comment_id: p.id, comment_count: p.comment_count,
      can_delete: p.author_id === me.id || (me.role === 'dom' && p.dom_id === me.id),
      ...(me.role === 'dom' ? { targets: getTargets.all(p.id) } : {})
    });
  }

  // --- check-ins ---
  const checkins = db.prepare(
    `SELECT c.*, ${AUTHOR_FIELDS}
     FROM checkins c JOIN users u ON u.id = c.sub_id
     WHERE c.sub_id ${me.role === 'dom' ? 'IN (SELECT id FROM users WHERE dom_id = ?)' : '= ?'}
     ORDER BY c.created_at DESC LIMIT 100`).all(me.id);
  for (const c of checkins) {
    items.push({
      kind: 'checkin', id: c.id, ts: c.created_at,
      author_id: c.sub_id, author_name: c.author_name, author_title: c.author_title,
      author_role: c.author_role, date: c.date, mood: c.mood, day_rating: c.day_rating,
      best_part: c.best_part, worst_part: c.worst_part, sexual_notes: c.sexual_notes,
      comment_subject: 'checkin', comment_id: c.id, comment_count: commentCount('checkin', c.id)
    });
  }

  // --- task completions ---
  const completions = db.prepare(
    `SELECT co.id, co.task_id, co.note, co.evidence_path, co.completed_at, co.period_key, t.title, t.sub_id,
            ${AUTHOR_FIELDS}
     FROM completions co JOIN tasks t ON t.id = co.task_id JOIN users u ON u.id = t.sub_id
     WHERE t.${me.role === 'dom' ? 'dom_id' : 'sub_id'} = ?
     ORDER BY co.completed_at DESC LIMIT 100`).all(me.id);
  for (const co of completions) {
    items.push({
      kind: 'task', id: co.id, ts: co.completed_at,
      author_id: co.sub_id, author_name: co.author_name, author_title: co.author_title,
      author_role: co.author_role, task_title: co.title, note: co.note, evidence_path: co.evidence_path,
      // task threads are keyed by the task id, not the completion id
      comment_subject: 'task', comment_id: co.task_id, comment_count: commentCount('task', co.task_id)
    });
  }

  // --- completed punishments ---
  const punished = db.prepare(
    `SELECT p.*, ${AUTHOR_FIELDS}
     FROM punishments p JOIN users u ON u.id = p.sub_id
     WHERE p.${me.role === 'dom' ? 'dom_id' : 'sub_id'} = ? AND p.status = 'completed'
     ORDER BY p.completed_at DESC LIMIT 100`).all(me.id);
  for (const p of punished) {
    items.push({
      kind: 'punishment', id: p.id, ts: p.completed_at || p.created_at,
      author_id: p.sub_id, author_name: p.author_name, author_title: p.author_title,
      author_role: p.author_role, title: p.title, note: p.note, evidence_path: p.evidence_path,
      comment_subject: 'punishment', comment_id: p.id, comment_count: commentCount('punishment', p.id)
    });
  }

  // --- journal entries ---
  // Dom: every sub's entry (they already read them all on the sub detail page).
  // Sub: own entries + dom entries shared with them (the /entries/from-dom rule).
  const entries = me.role === 'dom'
    ? db.prepare(
        `SELECT e.*, p.text AS prompt_text, ${AUTHOR_FIELDS}
         FROM entries e LEFT JOIN prompts p ON p.id = e.prompt_id JOIN users u ON u.id = e.owner_id
         WHERE e.owner_id IN (SELECT id FROM users WHERE dom_id = ?)
         ORDER BY e.created_at DESC LIMIT 100`).all(me.id)
    : db.prepare(
        `SELECT e.*, p.text AS prompt_text, ${AUTHOR_FIELDS}
         FROM entries e LEFT JOIN prompts p ON p.id = e.prompt_id JOIN users u ON u.id = e.owner_id
         WHERE e.owner_id = ?
            OR (e.owner_id = ? AND EXISTS (SELECT 1 FROM entry_shares es WHERE es.entry_id = e.id AND es.sub_id = ?))
         ORDER BY e.created_at DESC LIMIT 100`).all(me.id, me.dom_id || '', me.id);
  for (const e of entries) {
    items.push({
      kind: 'entry', id: e.id, ts: e.created_at,
      author_id: e.owner_id, author_name: e.author_name, author_title: e.author_title,
      author_role: e.author_role, text: e.body, prompt_text: e.prompt_text,
      comment_subject: 'entry', comment_id: e.id, comment_count: commentCount('entry', e.id)
    });
  }

  items.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
  res.json({ items: items.slice(0, 200) });
});

// POST /api/feed — both roles post. Multipart form: text `body` plus optional
// `media` files (photos/videos, cap MAX_UPLOAD_MB, up to MULTER_MAX_FILES).
// A post needs text, attachments, or both. JSON bodies (text-only) still work —
// multer passes non-multipart requests straight through.
// Targeting fields are for the Dom:
//   target_sub_ids  → address to those submissives (validated household)
//   target_all / no targeting → broadcast to every currently-paired sub
// (written as target rows at creation; submissives paired later never see it)
router.post('/', requireAuth, feedUpload.array('media', MULTER_MAX_FILES), (req, res) => {
  const text = String(req.body.body || '').trim();
  const files = req.files || [];
  if (!text && !files.length) {
    return res.status(400).json({ error: 'Write something or attach a photo/video' });
  }

  const id = crypto.randomUUID();
  const domId = req.user.role === 'dom' ? req.user.id : req.user.dom_id; // null when unpaired
  const ins = db.prepare('INSERT INTO feed_posts (id, dom_id, author_id, body) VALUES (?, ?, ?, ?)');
  const addTarget = db.prepare('INSERT OR IGNORE INTO feed_post_targets (post_id, sub_id) VALUES (?, ?)');
  const addAtt = db.prepare('INSERT INTO feed_attachments (id, post_id, path, media) VALUES (?, ?, ?, ?)');

  db.transaction(() => {
    ins.run(id, domId, req.user.id, text.slice(0, 8000));
    for (const f of files) addAtt.run(crypto.randomUUID(), id, f.filename, mediaKind(f.originalname));
    if (req.user.role !== 'dom') return;
    // One targeted sub arrives as a plain string in multipart form data; JSON
    // (and several appends of the same field) arrive as an array. Normalize.
    const raw = req.body.target_sub_ids;
    const list = (Array.isArray(raw) ? raw : raw ? [raw] : []).map(String).filter(Boolean);
    if (req.body.target_all || !list.length) {
      const subs = db.prepare("SELECT id FROM users WHERE dom_id = ? AND role = 'sub'").all(req.user.id);
      for (const s of subs) addTarget.run(id, s.id);
    } else {
      for (const sid of list) {
        const sub = assertDomOwnsSub(db, req.user.id, sid); // throws 404 outside the dynamic
        addTarget.run(id, sub.id);
      }
    }
  })();

  // Email notifications on the post itself (comments are notified by
  // comments.js): the submissive hears about the Dom's post addressed to them;
  // the Dom hears about a sub's post. Author never notified; the
  // email_notifications opt-out is respected. Fire-and-forget like comments.
  const authorName = req.user.title ? `${req.user.title} ${req.user.name}` : req.user.name;
  const excerpt = text
    ? `<p>“${mail.esc(text.slice(0, 300))}${text.length > 300 ? '…' : ''}”</p>` : '';
  const attNote = files.length
    ? `<p>With ${files.length} attachment${files.length === 1 ? '' : 's'}.</p>` : '';
  const subLine = (who) => mail.send(who,
    `New household post from ${authorName}`,
    `${excerpt || '<p>(photo/video post)</p>'}${attNote}
     <p>Open Control to see it in the feed.</p>`);
  const domLine = () => mail.send(
    db.prepare('SELECT email FROM users WHERE id = ?').get(req.user.dom_id)?.email,
    `New feed post from ${authorName}`,
    `${excerpt || '<p>(photo/video post)</p>'}${attNote}
     <p>Open Control to see it in the feed.</p>`);

  if (req.user.role === 'dom' && domId) {
    for (const t of db.prepare('SELECT sub_id FROM feed_post_targets WHERE post_id = ?').all(id)) {
      const u = db.prepare('SELECT email, email_notifications FROM users WHERE id = ?').get(t.sub_id);
      if (!u || !u.email_notifications) continue;
      subLine(u.email);
    }
  } else if (req.user.role === 'sub' && req.user.dom_id) {
    const u = db.prepare('SELECT email FROM users WHERE id = ?').get(req.user.dom_id);
    if (u) domLine();
  }

  res.json({ ok: true, id });
});

// Multipart errors come through here before the global handler: give them
// client-friendly statuses instead of 500.
router.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE'
      ? `File too large (max ${MAX_UPLOAD_MB} MB)`
      : err.code === 'LIMIT_UNEXPECTED_FILE'
        ? `Too many attachments (max ${MULTER_MAX_FILES})`
        : err.message;
    return res.status(400).json({ error: msg });
  }
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

// DELETE /api/feed/:id — feed posts only (check-ins/entries/completions are
// managed on their own pages). The author, or the household's Dom. Also unlinks
// the post's attachment files from uploads/.
router.delete('/:id', requireAuth, (req, res) => {
  const p = db.prepare('SELECT * FROM feed_posts WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Post not found' });
  const allowed = p.author_id === req.user.id
    || (req.user.role === 'dom' && p.dom_id === req.user.id);
  if (!allowed) return res.status(403).json({ error: 'Not allowed' });
  const atts = db.prepare('SELECT path FROM feed_attachments WHERE post_id = ?').all(p.id);
  db.transaction(() => {
    db.prepare("DELETE FROM comments WHERE subject = 'post' AND subject_id = ?").run(p.id);
    db.prepare('DELETE FROM feed_posts WHERE id = ?').run(p.id); // targets + attachments cascade via FK
  })();
  for (const a of atts) {
    fs.unlink(path.join(UPLOAD_DIR, a.path), () => { /* already gone is fine */ });
  }
  res.json({ ok: true });
});

module.exports = router;