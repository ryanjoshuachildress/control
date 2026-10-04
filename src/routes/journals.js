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

// Prompts visible to me: sub sees their Dom's active prompts; Dom sees every prompt they created.
router.get('/prompts', requireAuth, (req, res) => {
  if (req.user.role === 'sub') {
    const domId = req.user.dom_id;
    if (!domId) return res.json({ prompts: [], dom: null });
    const dom = db.prepare('SELECT id, name, title FROM users WHERE id = ?').get(domId);
    const prompts = db.prepare('SELECT * FROM prompts WHERE sub_id = ? AND active = 1 ORDER BY created_at DESC').all(req.user.id);
    return res.json({ prompts, dom });
  }
  const prompts = db.prepare('SELECT * FROM prompts WHERE dom_id = ? ORDER BY created_at DESC').all(req.user.id);
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
  const { prompt_id, body, share } = req.body || {};
  if (!body || !String(body).trim()) return res.status(400).json({ error: 'Entry body is required' });

  let prompt = null;
  if (prompt_id) {
    prompt = db.prepare('SELECT * FROM prompts WHERE id = ?').get(prompt_id);
    if (!prompt) return res.status(404).json({ error: 'Prompt not found' });
    if (req.user.role === 'sub' && prompt.sub_id !== req.user.id) return res.status(403).json({ error: 'Not your prompt' });
    if (req.user.role === 'dom' && prompt.dom_id !== req.user.id) return res.status(403).json({ error: 'Not your prompt' });
  }

  let shared = 0;
  if (req.user.role === 'dom') {
    // Dom entries only make sense to share when the prompt is aimed at their sub (or a free-write)
    shared = share ? 1 : 0;
  }

  const id = crypto.randomUUID();
  db.prepare('INSERT INTO entries (id, prompt_id, owner_id, body, shared_with_sub) VALUES (?, ?, ?, ?, ?)')
    .run(id, prompt ? prompt.id : null, req.user.id, String(body).trim().slice(0, 8000), shared);
  res.json({ ok: true, id });
});

// Own entries
router.get('/entries', requireAuth, (req, res) => {
  const entries = db.prepare(
    `SELECT e.*, p.text AS prompt_text, p.kind AS prompt_kind
     FROM entries e LEFT JOIN prompts p ON p.id = e.prompt_id
     WHERE e.owner_id = ? ORDER BY e.created_at DESC LIMIT 100`).all(req.user.id);
  res.json({ entries });
});

// Dom: a sub's entries
router.get('/entries/sub/:subId', requireDom, (req, res) => {
  const sub = assertDomOwnsSub(db, req.user.id, req.params.subId);
  const entries = db.prepare(
    `SELECT e.*, p.text AS prompt_text, p.kind AS prompt_kind
     FROM entries e LEFT JOIN prompts p ON p.id = e.prompt_id
     WHERE e.owner_id = ? ORDER BY e.created_at DESC LIMIT 100`).all(sub.id);
  res.json({ entries });
});

// Dom: sub sees Dom's shared entries (their own prompts + general free-writes)
router.get('/entries/from-dom', requireSub, (req, res) => {
  if (!req.user.dom_id) return res.json({ entries: [] });
  const entries = db.prepare(
    `SELECT e.*, p.text AS prompt_text, p.kind AS prompt_kind
     FROM entries e LEFT JOIN prompts p ON p.id = e.prompt_id
     WHERE e.owner_id = ? AND e.shared_with_sub = 1
       AND (e.prompt_id IS NULL OR p.sub_id = ?)
     ORDER BY e.created_at DESC LIMIT 100`).all(req.user.dom_id, req.user.id);
  res.json({ entries });
});

router.patch('/entries/:id', requireAuth, (req, res) => {
  const entry = db.prepare('SELECT * FROM entries WHERE id = ? AND owner_id = ?').get(req.params.id, req.user.id);
  if (!entry) return res.status(404).json({ error: 'Entry not found' });
  const { body, share } = req.body || {};
  const updates = {};
  if (body !== undefined) {
    if (!String(body).trim()) return res.status(400).json({ error: 'Entry body is required' });
    updates.body = String(body).trim().slice(0, 8000);
    updates.updated_at = new Date().toISOString();
  }
  if (share !== undefined && req.user.role === 'dom') updates.shared_with_sub = share ? 1 : 0;
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nothing to update' });
  const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE entries SET ${sets} WHERE id = ?`).run(...Object.values(updates), entry.id);
  res.json({ ok: true });
});

router.delete('/entries/:id', requireAuth, (req, res) => {
  const entry = db.prepare('SELECT * FROM entries WHERE id = ? AND owner_id = ?').get(req.params.id, req.user.id);
  if (!entry) return res.status(404).json({ error: 'Entry not found' });
  db.prepare('DELETE FROM entries WHERE id = ?').run(entry.id);
  res.json({ ok: true });
});

module.exports = router;