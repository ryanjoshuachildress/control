const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const mail = require('../lib/mail');
const { requireDom, requireSub, assertDomOwnsSub, attachUser } = require('../lib/auth');
const { upload } = require('../lib/uploads');
const { resolveRefs } = require('../lib/immich');

const router = express.Router();

router.use(attachUser);

const PUNISH_LABEL = { checkoff: 'checking it off', evidence: 'photo/video evidence' };
const commentCount = (id) => db.get(
  "SELECT COUNT(*)::int AS n FROM comments WHERE subject = 'punishment' AND subject_id = ?", id);
const withCommentCount = async (p) => ({ ...p, comment_count: (await commentCount(p.id)).n });

// ---------- submissive ----------

router.get('/mine', requireSub, async (req, res) => {
  const open = await db.all("SELECT * FROM punishments WHERE sub_id = ? AND status = 'open' ORDER BY created_at", req.user.id);
  const recent = await db.all("SELECT * FROM punishments WHERE sub_id = ? AND status != 'open' ORDER BY completed_at DESC, created_at DESC LIMIT 15", req.user.id);
  res.json({ open: await Promise.all(open.map(withCommentCount)), recent: await Promise.all(recent.map(withCommentCount)) });
});

router.post('/:id/complete', requireSub, async (req, res) => {
  upload.single('evidence')(req, res, async (err) => {
    if (err) {
      const msg = /file too large/i.test(err.message) ? 'File too large' : (err.message || 'Upload failed');
      return res.status(400).json({ error: msg });
    }
    try {
      const p = await db.get("SELECT * FROM punishments WHERE id = ? AND sub_id = ? AND status = 'open'", req.params.id, req.user.id);
      if (!p) return res.status(404).json({ error: 'Punishment not found' });

      // Evidence can be an uploaded file or a linked Immich library asset.
      let immichRow = null;
      if ((req.body || {}).immich) {
        try { [immichRow] = await resolveRefs(req.user.id, req.user.dom_id, req.body.immich); }
        catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
      }
      const method = (req.file || immichRow) ? 'evidence' : String((req.body || {}).method || '');
      if (method !== p.completion_mode) {
        return res.status(400).json({
          error: p.completion_mode === 'evidence'
            ? 'This punishment requires photo or video evidence'
            : 'This punishment is completed with the checkbox'
        });
      }
      await db.run(`UPDATE punishments SET status = 'completed', evidence_path = ?, note = ?, immich_asset_id = ?, immich_media = ?,
                  completed_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`,
        req.file ? req.file.filename : null, String((req.body || {}).note || '').slice(0, 500),
        immichRow ? immichRow.asset_id : null, immichRow ? immichRow.media : '', p.id);

      const dom = await db.get("SELECT email, email_notifications FROM users WHERE id = ?", p.dom_id);
      if (dom && dom.email_notifications) {
        mail.send(dom.email, `${req.user.name} completed punishment "${p.title}"`,
          `<p><strong>${req.user.name}</strong> completed the punishment <strong>${p.title}</strong>
           ${method === 'evidence' ? ' with photo/video evidence — view it in their punishment history.' : ''}</p>
           ${mail.viewLink(`sub/${p.sub_id}/punishments?focus=punishment:${p.id}`, 'View the punishment')}`);
      }
      res.json({ ok: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Failed to complete punishment' });
    }
  });
});

// ---------- dominant ----------

router.post('/', requireDom, async (req, res) => {
  const { sub_id, title, description, completion_mode } = req.body || {};
  const sub = await assertDomOwnsSub(db, req.user.id, String(sub_id || ''));
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'Punishment title is required' });
  if (!['checkoff', 'evidence'].includes(completion_mode)) return res.status(400).json({ error: 'Completion mode must be checkoff or evidence' });

  const id = crypto.randomUUID();
  await db.run(`INSERT INTO punishments (id, dom_id, sub_id, title, description, completion_mode, source)
              VALUES (?, ?, ?, ?, ?, ?, 'manual')`,
    id, req.user.id, sub.id, String(title).trim().slice(0, 120), String(description || '').slice(0, 1000), completion_mode);

  if (sub.email_notifications) {
    mail.send(sub.email, `Punishment assigned: ${title}`,
      `<p><strong>${req.user.name}</strong> has assigned a punishment: <strong>${String(title).trim().slice(0, 120)}</strong>.
       Complete it within 24 hours${completion_mode === 'evidence' ? ' with photo/video evidence' : ''}.</p>
       ${mail.viewLink(`today?focus=punishment:${id}`, 'View the punishment')}`);
  }
  res.json({ ok: true, id });
});

router.delete('/:id', requireDom, async (req, res) => {
  const p = await db.get("SELECT * FROM punishments WHERE id = ? AND dom_id = ? AND status = 'open'", req.params.id, req.user.id);
  if (!p) return res.status(404).json({ error: 'Open punishment not found' });
  await db.run("UPDATE punishments SET status = 'cancelled' WHERE id = ?", p.id);

  const sub = await db.get('SELECT email, email_notifications FROM users WHERE id = ?', p.sub_id);
  if (sub && sub.email_notifications) {
    mail.send(sub.email, `Punishment cancelled: ${p.title}`,
      `<p><strong>${req.user.name}</strong> has cancelled the punishment <strong>${p.title}</strong>. Nothing is owed for it anymore.</p>
       ${mail.viewLink('today', 'View your tasks')}`);
  }
  res.json({ ok: true });
});

router.get('/dom/sub/:subId', requireDom, async (req, res) => {
  const sub = await assertDomOwnsSub(db, req.user.id, req.params.subId);
  const open = await db.all("SELECT * FROM punishments WHERE sub_id = ? AND status = 'open' ORDER BY created_at", sub.id);
  const history = await db.all("SELECT * FROM punishments WHERE sub_id = ? AND status != 'open' ORDER BY COALESCE(completed_at, created_at) DESC LIMIT 30", sub.id);
  res.json({ open: await Promise.all(open.map(withCommentCount)), history: await Promise.all(history.map(withCommentCount)), weekly: { title: sub.weekly_punish_title || '', pct: sub.weekly_punish_pct } });
});

// Weekly compliance auto-punishment: fired by the scheduler when the sub's
// Sunday-midnight week ends, if daily-task completion for it was under the %.
router.put('/dom/sub/:subId/weekly', requireDom, async (req, res) => {
  const sub = await assertDomOwnsSub(db, req.user.id, req.params.subId);
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
  await db.run('UPDATE users SET weekly_punish_title = ?, weekly_punish_pct = ? WHERE id = ?',
    cleanTitle, pctVal, sub.id);
  res.json({ ok: true, weekly: { title: cleanTitle, pct: pctVal } });
});

module.exports = router;