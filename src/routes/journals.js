const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { requireAuth, requireDom, requireSub, assertDomOwnsSub, attachUser } = require('../lib/auth');

const router = express.Router();

router.use(attachUser);

// ---------- prompts (written by the Dom, answered by the sub) ----------

// Dom: create a prompt for a sub
router.post('/prompts', requireDom, (req, res) => {
  const { sub_id, kind, text } = req.body || {};
  const sub = assertDomOwnsSub(db, req.user.id, String(sub_id || ''));
  if (kind !== 'daily' && kind !== 'weekly') return res.status(400).json({ error: 'Kind must be daily or weekly' });
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'Prompt text is required' });
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO prompts (id, dom_id, sub_id, kind, text) VALUES (?, ?, ?, ?, ?)')
    .run(id, req.user.id, sub.id, kind, String(text).trim().slice(0, 2000));
  res.json({ ok: true, id });
});

// Prompts visible to me: sub sees their Dom's active prompts; Dom sees every
// prompt they created, optionally narrowed to one submissive with ?sub_id=.
router.get('/prompts', requireAuth, (req, res) => {
  if (req.user.role === 'sub') {
    const domId = req.user.dom_id;
    if (!domId) return res.json({ prompts: [], dom: null });
    const dom = db.prepare('SELECT id, name, title FROM users WHERE id = ?').get(domId);
    const prompts = db.prepare('SELECT * FROM prompts WHERE sub_id = ? AND active = 1 ORDER BY created_at DESC').all(req.user.id);
    return res.json({ prompts, dom });
  }
  const subId = String(req.query.sub_id || '');
  const prompts = subId
    ? db.prepare('SELECT * FROM prompts WHERE dom_id = ? AND sub_id = ? ORDER BY created_at DESC').all(req.user.id, subId)
    : db.prepare('SELECT * FROM prompts WHERE dom_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json({ prompts });
});

router.patch('/prompts/:id', requireDom, (req, res) => {
  const prompt = db.prepare('SELECT * FROM prompts WHERE id = ? AND dom_id = ?').get(req.params.id, req.user.id);
  if (!prompt) return res.status(404).json({ error: 'Prompt not found' });
  const { active } = req.body || {};
  if (typeof active !== 'boolean') return res.status(400).json({ error: 'active (boolean) is required' });
  db.prepare('UPDATE prompts SET active = ? WHERE id = ?').run(active ? 1 : 0, prompt.id);
  res.json({ ok: true });
});

router.delete('/prompts/:id', requireDom, (req, res) => {
  const prompt = db.prepare('SELECT * FROM prompts WHERE id = ? AND dom_id = ?').get(req.params.id, req.user.id);
  if (!prompt) return res.status(404).json({ error: 'Prompt not found' });
  db.prepare('DELETE FROM prompts WHERE id = ?').run(prompt.id); // entries keep prompt_id NULL via FK
  res.json({ ok: true });
});

// ---------- entries (journal responses; owner is whoever writes them) ----------

router.post('/entries', requireAuth, (req, res) => {
  const { prompt_id, body, share_sub_id } = req.body || {};
  if (!body || !String(body).trim()) return res.status(400).json({ error: 'Entry body is required' });

  let prompt = null;
  if (prompt_id) {
    prompt = db.prepare('SELECT * FROM prompts WHERE id = ?').get(prompt_id);
    if (!prompt) return res.status(404).json({ error: 'Prompt not found' });
    if (req.user.role === 'sub' && prompt.sub_id !== req.user.id) return res.status(403).json({ error: 'Not your prompt' });
    if (req.user.role === 'dom' && prompt.dom_id !== req.user.id) return res.status(403).json({ error: 'Not your prompt' });
  }

  const id = crypto.randomUUID();
  db.prepare('INSERT INTO entries (id, prompt_id, owner_id, body, shared_with_sub) VALUES (?, ?, ?, ?, ?)')
    .run(id, prompt ? prompt.id : null, req.user.id, String(body).trim().slice(0, 8000), 0);

  // Dom journal entries are shared to one submissive at a time (entry_shares);
  // the old shared_with_sub broadcast flag is retired.
  if (req.user.role === 'dom' && String(share_sub_id || '')) {
    const sub = assertDomOwnsSub(db, req.user.id, String(share_sub_id));
    db.prepare('INSERT OR IGNORE INTO entry_shares (entry_id, sub_id) VALUES (?, ?)').run(id, sub.id);
  }
  res.json({ ok: true, id });
});

// Own entries
router.get('/entries', requireAuth, (req, res) => {
  const entries = db.prepare(
    `SELECT e.*, p.text AS prompt_text, p.kind AS prompt_kind,
            (SELECT COUNT(*) FROM comments c WHERE c.subject = 'entry' AND c.subject_id = e.id) AS comment_count
     FROM entries e LEFT JOIN prompts p ON p.id = e.prompt_id
     WHERE e.owner_id = ? ORDER BY e.created_at DESC LIMIT 100`).all(req.user.id);
  const getShares = db.prepare(
    `SELECT es.sub_id, u.name AS sub_name FROM entry_shares es
     JOIN users u ON u.id = es.sub_id WHERE es.entry_id = ? ORDER BY u.name`);
  if (req.user.role === 'dom') entries.forEach(e => { e.shared_with = getShares.all(e.id); });
  res.json({ entries });
});

// Dom: a sub's entries
router.get('/entries/sub/:subId', requireDom, (req, res) => {
  const sub = assertDomOwnsSub(db, req.user.id, req.params.subId);
  const entries = db.prepare(
    `SELECT e.*, p.text AS prompt_text, p.kind AS prompt_kind,
            (SELECT COUNT(*) FROM comments c WHERE c.subject = 'entry' AND c.subject_id = e.id) AS comment_count
     FROM entries e LEFT JOIN prompts p ON p.id = e.prompt_id
     WHERE e.owner_id = ? ORDER BY e.created_at DESC LIMIT 100`).all(sub.id);
  res.json({ entries });
});

// Sub sees Dom's shared entries: only ones shared with them specifically
// (per-submissive isolation — one sub never sees another sub's shares).
router.get('/entries/from-dom', requireSub, (req, res) => {
  if (!req.user.dom_id) return res.json({ entries: [] });
  const entries = db.prepare(
    `SELECT e.*, p.text AS prompt_text, p.kind AS prompt_kind,
            (SELECT COUNT(*) FROM comments c WHERE c.subject = 'entry' AND c.subject_id = e.id) AS comment_count
     FROM entries e LEFT JOIN prompts p ON p.id = e.prompt_id
     WHERE e.owner_id = ?
       AND EXISTS (SELECT 1 FROM entry_shares es WHERE es.entry_id = e.id AND es.sub_id = ?)
     ORDER BY e.created_at DESC LIMIT 100`).all(req.user.dom_id, req.user.id);
  res.json({ entries });
});

router.patch('/entries/:id', requireAuth, (req, res) => {
  const entry = db.prepare('SELECT * FROM entries WHERE id = ? AND owner_id = ?').get(req.params.id, req.user.id);
  if (!entry) return res.status(404).json({ error: 'Entry not found' });
  const { body, share_sub_id, unshare_sub_id } = req.body || {};
  const updates = {};
  if (body !== undefined) {
    if (!String(body).trim()) return res.status(400).json({ error: 'Entry body is required' });
    updates.body = String(body).trim().slice(0, 8000);
    updates.updated_at = new Date().toISOString();
  }
  if (!Object.keys(updates).length && !String(share_sub_id || '') && !String(unshare_sub_id || '')) {
    return res.status(400).json({ error: 'Nothing to update' });
  }
  const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  if (sets) db.prepare(`UPDATE entries SET ${sets} WHERE id = ?`).run(...Object.values(updates), entry.id);

  // Per-submissive share/unshare (one at a time).
  let shared = false, unshared = false;
  if (req.user.role === 'dom' && String(share_sub_id || '')) {
    const sub = assertDomOwnsSub(db, req.user.id, String(share_sub_id));
    db.prepare('INSERT OR IGNORE INTO entry_shares (entry_id, sub_id) VALUES (?, ?)').run(entry.id, sub.id);
    shared = true;
  }
  if (req.user.role === 'dom' && String(unshare_sub_id || '')) {
    db.prepare('DELETE FROM entry_shares WHERE entry_id = ? AND sub_id = ?')
      .run(entry.id, String(unshare_sub_id));
    unshared = true;
  }
  res.json({ ok: true, ...(shared ? { shared_with: String(share_sub_id) } : {}), ...(unshared ? { unshared_sub: String(unshare_sub_id) } : {}) });
});

router.delete('/entries/:id', requireAuth, (req, res) => {
  const entry = db.prepare('SELECT * FROM entries WHERE id = ? AND owner_id = ?').get(req.params.id, req.user.id);
  if (!entry) return res.status(404).json({ error: 'Entry not found' });
  db.prepare('DELETE FROM comments WHERE subject = \'entry\' AND subject_id = ?').run(entry.id);
  db.prepare('DELETE FROM entries WHERE id = ?').run(entry.id);
  res.json({ ok: true });
});

module.exports = router;