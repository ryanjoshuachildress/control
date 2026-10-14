const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { requireAuth, requireDom, requireSub, assertDomOwnsSub, attachUser } = require('../lib/auth');

const router = require("../lib/router")();

router.use(attachUser);

// ---------- prompts (written by the Dom, answered by the sub) ----------

// Dom: create a prompt for a sub
router.post('/prompts', requireDom, async (req, res) => {
  const { sub_id, kind, text } = req.body || {};
  const sub = await assertDomOwnsSub(db, req.user.id, String(sub_id || ''));
  if (kind !== 'daily' && kind !== 'weekly') return res.status(400).json({ error: 'Kind must be daily or weekly' });
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'Prompt text is required' });
  const id = crypto.randomUUID();
  await db.run('INSERT INTO prompts (id, dom_id, sub_id, kind, text) VALUES (?, ?, ?, ?, ?)',
    id, req.user.id, sub.id, kind, String(text).trim().slice(0, 2000));
  res.json({ ok: true, id });
});

// Prompts visible to me: sub sees their Dom's active prompts; Dom sees every
// prompt they created, optionally narrowed to one submissive with ?sub_id=.
router.get('/prompts', requireAuth, async (req, res) => {
  if (req.user.role === 'sub') {
    const domId = req.user.dom_id;
    if (!domId) return res.json({ prompts: [], dom: null });
    const dom = await db.get('SELECT id, name, title FROM users WHERE id = ?', domId);
    const prompts = await db.all('SELECT * FROM prompts WHERE sub_id = ? AND active = 1 ORDER BY created_at DESC', req.user.id);
    return res.json({ prompts, dom });
  }
  const subId = String(req.query.sub_id || '');
  const prompts = subId
    ? await db.all('SELECT * FROM prompts WHERE dom_id = ? AND sub_id = ? ORDER BY created_at DESC', req.user.id, subId)
    : await db.all('SELECT * FROM prompts WHERE dom_id = ? ORDER BY created_at DESC', req.user.id);
  res.json({ prompts });
});

router.patch('/prompts/:id', requireDom, async (req, res) => {
  const prompt = await db.get('SELECT * FROM prompts WHERE id = ? AND dom_id = ?', req.params.id, req.user.id);
  if (!prompt) return res.status(404).json({ error: 'Prompt not found' });
  const { active } = req.body || {};
  if (typeof active !== 'boolean') return res.status(400).json({ error: 'active (boolean) is required' });
  await db.run('UPDATE prompts SET active = ? WHERE id = ?', active ? 1 : 0, prompt.id);
  res.json({ ok: true });
});

router.delete('/prompts/:id', requireDom, async (req, res) => {
  const prompt = await db.get('SELECT * FROM prompts WHERE id = ? AND dom_id = ?', req.params.id, req.user.id);
  if (!prompt) return res.status(404).json({ error: 'Prompt not found' });
  await db.run('DELETE FROM prompts WHERE id = ?', prompt.id); // entries keep prompt_id NULL via FK
  res.json({ ok: true });
});

// ---------- entries (journal responses; owner is whoever writes them) ----------

router.post('/entries', requireAuth, async (req, res) => {
  const { prompt_id, body, share_sub_id } = req.body || {};
  if (!body || !String(body).trim()) return res.status(400).json({ error: 'Entry body is required' });

  let prompt = null;
  if (prompt_id) {
    prompt = await db.get('SELECT * FROM prompts WHERE id = ?', prompt_id);
    if (!prompt) return res.status(404).json({ error: 'Prompt not found' });
    if (req.user.role === 'sub' && prompt.sub_id !== req.user.id) return res.status(403).json({ error: 'Not your prompt' });
    if (req.user.role === 'dom' && prompt.dom_id !== req.user.id) return res.status(403).json({ error: 'Not your prompt' });
  }

  const id = crypto.randomUUID();
  await db.run('INSERT INTO entries (id, prompt_id, owner_id, body, shared_with_sub) VALUES (?, ?, ?, ?, ?)',
    id, prompt ? prompt.id : null, req.user.id, String(body).trim().slice(0, 8000), 0);

  // Dom journal entries are shared to one submissive at a time (entry_shares);
  // the old shared_with_sub broadcast flag is retired.
  if (req.user.role === 'dom' && String(share_sub_id || '')) {
    const sub = await assertDomOwnsSub(db, req.user.id, String(share_sub_id));
    await db.run('INSERT INTO entry_shares (entry_id, sub_id) VALUES (?, ?) ON CONFLICT DO NOTHING', id, sub.id);
  }
  res.json({ ok: true, id });
});

// Own entries
router.get('/entries', requireAuth, async (req, res) => {
  const entries = await db.all(
    `SELECT e.*, p.text AS prompt_text, p.kind AS prompt_kind,
            (SELECT COUNT(*)::int FROM comments c WHERE c.subject = 'entry' AND c.subject_id = e.id) AS comment_count
     FROM entries e LEFT JOIN prompts p ON p.id = e.prompt_id
     WHERE e.owner_id = ? ORDER BY e.created_at DESC LIMIT 100`, req.user.id);
  if (req.user.role === 'dom') {
    for (const e of entries) e.shared_with = await getShares(e.id);
  }
  res.json({ entries });
});

const SHARES_SQL = `SELECT es.sub_id, u.name AS sub_name FROM entry_shares es
   JOIN users u ON u.id = es.sub_id WHERE es.entry_id = ? ORDER BY u.name`;
const getShares = (entryId) => db.all(SHARES_SQL, entryId);

// Dom: a sub's entries
router.get('/entries/sub/:subId', requireDom, async (req, res) => {
  const sub = await assertDomOwnsSub(db, req.user.id, req.params.subId);
  const entries = await db.all(
    `SELECT e.*, p.text AS prompt_text, p.kind AS prompt_kind,
            (SELECT COUNT(*)::int FROM comments c WHERE c.subject = 'entry' AND c.subject_id = e.id) AS comment_count
     FROM entries e LEFT JOIN prompts p ON p.id = e.prompt_id
     WHERE e.owner_id = ? ORDER BY e.created_at DESC LIMIT 100`, sub.id);
  res.json({ entries });
});

// Sub sees Dom's shared entries: only ones shared with them specifically
// (per-submissive isolation — one sub never sees another sub's shares).
router.get('/entries/from-dom', requireSub, async (req, res) => {
  if (!req.user.dom_id) return res.json({ entries: [] });
  const entries = await db.all(
    `SELECT e.*, p.text AS prompt_text, p.kind AS prompt_kind,
            (SELECT COUNT(*)::int FROM comments c WHERE c.subject = 'entry' AND c.subject_id = e.id) AS comment_count
     FROM entries e LEFT JOIN prompts p ON p.id = e.prompt_id
     WHERE e.owner_id = ?
       AND EXISTS (SELECT 1 FROM entry_shares es WHERE es.entry_id = e.id AND es.sub_id = ?)
     ORDER BY e.created_at DESC LIMIT 100`, req.user.dom_id, req.user.id);
  res.json({ entries });
});

router.patch('/entries/:id', requireAuth, async (req, res) => {
  const entry = await db.get('SELECT * FROM entries WHERE id = ? AND owner_id = ?', req.params.id, req.user.id);
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
  if (sets) await db.run(`UPDATE entries SET ${sets} WHERE id = ?`, ...Object.values(updates), entry.id);

  // Per-submissive share/unshare (one at a time).
  let shared = false, unshared = false;
  if (req.user.role === 'dom' && String(share_sub_id || '')) {
    const sub = await assertDomOwnsSub(db, req.user.id, String(share_sub_id));
    await db.run('INSERT INTO entry_shares (entry_id, sub_id) VALUES (?, ?) ON CONFLICT DO NOTHING', entry.id, sub.id);
    shared = true;
  }
  if (req.user.role === 'dom' && String(unshare_sub_id || '')) {
    await db.run('DELETE FROM entry_shares WHERE entry_id = ? AND sub_id = ?', entry.id, String(unshare_sub_id));
    unshared = true;
  }
  res.json({ ok: true, ...(shared ? { shared_with: String(share_sub_id) } : {}), ...(unshared ? { unshared_sub: String(unshare_sub_id) } : {}) });
});

router.delete('/entries/:id', requireAuth, async (req, res) => {
  const entry = await db.get('SELECT * FROM entries WHERE id = ? AND owner_id = ?', req.params.id, req.user.id);
  if (!entry) return res.status(404).json({ error: 'Entry not found' });
  await db.run("DELETE FROM comments WHERE subject = 'entry' AND subject_id = ?", entry.id);
  await db.run('DELETE FROM entries WHERE id = ?', entry.id);
  res.json({ ok: true });
});

module.exports = router;