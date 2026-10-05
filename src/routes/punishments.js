const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const mail = require('../lib/mail');
const { requireDom, requireSub, assertDomOwnsSub, attachUser } = require('../lib/auth');
const { upload } = require('../lib/uploads');

const router = express.Router();

router.use(attachUser);

const PUNISH_LABEL = { checkoff: 'checking it off', evidence: 'photo/video evidence' };
const commentCount = db.prepare(
  "SELECT COUNT(*) AS n FROM comments WHERE subject = 'punishment' AND subject_id = ?");
const withCommentCount = (p) => ({ ...p, comment_count: commentCount.get(p.id).n });

// ---------- submissive ----------

router.get('/mine', requireSub, (req, res) => {
  const open = db.prepare("SELECT * FROM punishments WHERE sub_id = ? AND status = 'open' ORDER BY created_at").all(req.user.id);
  const recent = db.prepare("SELECT * FROM punishments WHERE sub_id = ? AND status != 'open' ORDER BY completed_at DESC, created_at DESC LIMIT 15").all(req.user.id);
  res.json({ open: open.map(withCommentCount), recent: recent.map(withCommentCount) });
});

router.post('/:id/complete', requireSub, (req, res) => {
  upload.single('evidence')(req, res, (err) => {
    if (err) {
      const msg = /file too large/i.test(err.message) ? 'File too large' : (err.message || 'Upload failed');
      return res.status(400).json({ error: msg });
    }
    try {
      const p = db.prepare("SELECT * FROM punishments WHERE id = ? AND sub_id = ? AND status = 'open'").get(req.params.id, req.user.id);
      if (!p) return res.status(404).json({ error: 'Punishment not found' });

      const method = req.file ? 'evidence' : String((req.body || {}).method || '');
      if (method !== p.completion_mode) {
        return res.status(400).json({
          error: p.completion_mode === 'evidence'
            ? 'This punishment requires photo or video evidence'
            : 'This punishment is completed with the checkbox'
        });
      }
      db.prepare("UPDATE punishments SET status = 'completed', evidence_path = ?, note = ?, completed_at = datetime('now') WHERE id = ?")
        .run(req.file ? req.file.filename : null, String((req.body || {}).note || '').slice(0, 500), p.id);

      const dom = db.prepare("SELECT email, email_notifications FROM users WHERE id = ?").get(p.dom_id);
      if (dom && dom.email_notifications) {
        mail.send(dom.email, `${req.user.name} completed punishment "${p.title}"`,
          `<p><strong>${req.user.name}</strong> completed the punishment <strong>${p.title}</strong>
           ${method === 'evidence' ? ' with photo/video evidence — view it under their punishment history.' : ''}</p>`);
      }
      res.json({ ok: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Failed to complete punishment' });
    }
  });
});

// ---------- dominant ----------

router.post('/', requireDom, (req, res) => {
  const { sub_id, title, description, completion_mode } = req.body || {};
  const sub = assertDomOwnsSub(db, req.user.id, String(sub_id || ''));
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'Punishment title is required' });
  if (!['checkoff', 'evidence'].includes(completion_mode)) return res.status(400).json({ error: 'Completion mode must be checkoff or evidence' });

  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO punishments (id, dom_id, sub_id, title, description, completion_mode, source)
              VALUES (?, ?, ?, ?, ?, ?, 'manual')`)
    .run(id, req.user.id, sub.id, String(title).trim().slice(0, 120), String(description || '').slice(0, 1000), completion_mode);

  if (sub.email_notifications) {
    mail.send(sub.email, `Punishment assigned: ${title}`,
      `<p><strong>${req.user.name}</strong> has assigned a punishment: <strong>${String(title).trim().slice(0, 120)}</strong>.
       Complete it within 24 hours${completion_mode === 'evidence' ? ' with photo/video evidence' : ''}.</p>`);
  }
  res.json({ ok: true, id });
});

router.delete('/:id', requireDom, (req, res) => {
  const p = db.prepare("SELECT * FROM punishments WHERE id = ? AND dom_id = ? AND status = 'open'").get(req.params.id, req.user.id);
  if (!p) return res.status(404).json({ error: 'Open punishment not found' });
  db.prepare("UPDATE punishments SET status = 'cancelled' WHERE id = ?").run(p.id);

  const sub = db.prepare('SELECT email, email_notifications FROM users WHERE id = ?').get(p.sub_id);
  if (sub && sub.email_notifications) {
    mail.send(sub.email, `Punishment cancelled: ${p.title}`,
      `<p><strong>${req.user.name}</strong> has cancelled the punishment <strong>${p.title}</strong>. Nothing is owed for it anymore.</p>`);
  }
  res.json({ ok: true });
});

router.get('/dom/sub/:subId', requireDom, (req, res) => {
  const sub = assertDomOwnsSub(db, req.user.id, req.params.subId);
  const open = db.prepare("SELECT * FROM punishments WHERE sub_id = ? AND status = 'open' ORDER BY created_at").all(sub.id);
  const history = db.prepare("SELECT * FROM punishments WHERE sub_id = ? AND status != 'open' ORDER BY COALESCE(completed_at, created_at) DESC LIMIT 30").all(sub.id);
  res.json({ open: open.map(withCommentCount), history: history.map(withCommentCount), weekly: { title: sub.weekly_punish_title || '', pct: sub.weekly_punish_pct } });
});

// Weekly compliance auto-punishment: fired by the scheduler when the sub's
// Sunday-midnight week ends, if daily-task completion for it was under the %.
router.put('/dom/sub/:subId/weekly', requireDom, (req, res) => {
  const sub = assertDomOwnsSub(db, req.user.id, req.params.subId);
  const { title, pct } = req.body || {};
  const cleanTitle = String(title || '').trim().slice(0, 120);
  let pctVal = null;
  if (pct !== undefined && pct !== null && String(pct).trim() !== '') {
    pctVal = Number(pct);
  }
  if (cleanTitle && (pctVal === null || !Number.isFinite(pctVal) || pctVal < 1 || pctVal > 100)) {
    return res.status(400).json({ error: 'Threshold must be a percentage between 1 and 100' });
  }
  if (!cleanTitle && pctVal !== null) {
    return res.status(400).json({ error: 'Punishment title is required when a threshold is set' });
  }
  db.prepare('UPDATE users SET weekly_punish_title = ?, weekly_punish_pct = ? WHERE id = ?')
    .run(cleanTitle, pctVal, sub.id);
  res.json({ ok: true, weekly: { title: cleanTitle, pct: pctVal } });
});

module.exports = router;