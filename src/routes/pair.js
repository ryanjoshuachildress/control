const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const mail = require('../lib/mail');
const { requireAuth, assertDomOwnsSub, attachUser } = require('../lib/auth');

const router = express.Router();

router.use(attachUser);

router.use((req, res, next) => {
  if (req.user) {
    if (req.user.role === 'sub') {
      req.myDom = req.user.dom_id ? db.prepare("SELECT * FROM users WHERE id = ? AND role = 'dom'").get(req.user.dom_id) : null;
    } else {
      req.mySubs = db.prepare("SELECT id, name, title, email, timezone, created_at FROM users WHERE dom_id = ? AND role = 'sub' ORDER BY name").all(req.user.id);
    }
  }
  next();
});

router.get('/', requireAuth, (req, res) => {
  if (req.user.role === 'dom') {
    return res.json({ role: 'dom', invite_code: req.user.invite_code, subs: req.mySubs });
  }
  res.json({
    role: 'sub',
    dom: req.myDom ? { id: req.myDom.id, name: req.myDom.name, title: req.myDom.title } : null
  });
});

router.post('/', requireAuth, (req, res) => {
  if (req.user.role !== 'sub') return res.status(403).json({ error: 'Only submissives pair via invite code' });
  if (req.myDom) return res.status(409).json({ error: 'You are already paired with a Dom' });
  const dom = db.prepare("SELECT * FROM users WHERE invite_code = ? AND role = 'dom'")
    .get(String((req.body || {}).code || '').trim().toUpperCase());
  if (!dom) return res.status(404).json({ error: 'Invite code not recognized' });

  db.prepare('UPDATE users SET dom_id = ? WHERE id = ?').run(dom.id, req.user.id);
  if (dom.email_notifications) {
    mail.send(dom.email, `${req.user.name} paired with you on Control`,
      `<p><strong>${req.user.name}</strong>${req.user.title ? ` (${req.user.title})` : ''} has paired with you as your submissive.</p>`);
  }
  res.json({ ok: true, dom: { id: dom.id, name: dom.name, title: dom.title } });
});

router.delete('/', requireAuth, (req, res) => {
  if (req.user.role === 'sub') {
    if (!req.myDom) return res.status(404).json({ error: 'Not paired' });
    db.prepare('UPDATE tasks SET active = 0 WHERE sub_id = ?').run(req.user.id);
    db.prepare('UPDATE prompts SET active = 0 WHERE sub_id = ?').run(req.user.id);
    db.prepare('UPDATE users SET dom_id = NULL WHERE id = ?').run(req.user.id);
    return res.json({ ok: true });
  }
  const subId = (req.body || {}).sub_id;
  if (!subId) return res.status(400).json({ error: 'sub_id is required' });
  assertDomOwnsSub(db, req.user.id, subId);
  db.prepare('UPDATE tasks SET active = 0 WHERE sub_id = ?').run(subId);
  db.prepare('UPDATE prompts SET active = 0 WHERE sub_id = ?').run(subId);
  db.prepare('UPDATE users SET dom_id = NULL WHERE id = ? AND dom_id = ?').run(subId, req.user.id);
  res.json({ ok: true });
});

module.exports = router;