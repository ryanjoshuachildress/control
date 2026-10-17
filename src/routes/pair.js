const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const mail = require('../lib/mail');
const { notifyUser } = require('../lib/notify');
const { requireAuth, assertDomOwnsSub, attachUser } = require('../lib/auth');

const router = require("../lib/router")();

router.use(attachUser);

router.use(async (req, res, next) => {
  if (req.user) {
    if (req.user.role === 'sub') {
      req.myDom = req.user.dom_id ? await db.get("SELECT * FROM users WHERE id = ? AND role = 'dom'", req.user.dom_id) : null;
    } else {
      req.mySubs = await db.all("SELECT id, name, title, email, timezone, created_at FROM users WHERE dom_id = ? AND role = 'sub' ORDER BY name", req.user.id);
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

router.post('/', requireAuth, async (req, res) => {
  if (req.user.role !== 'sub') return res.status(403).json({ error: 'Only submissives pair via invite code' });
  if (req.myDom) return res.status(409).json({ error: 'You are already paired with a Dom' });
  const dom = await db.get("SELECT * FROM users WHERE invite_code = ? AND role = 'dom'",
    String((req.body || {}).code || '').trim().toUpperCase());
  if (!dom) return res.status(404).json({ error: 'Invite code not recognized' });

  await db.run('UPDATE users SET dom_id = ? WHERE id = ?', dom.id, req.user.id);
  notifyUser(dom.id, {
    subject: `${req.user.name} paired with you on Control`,
    html: `<p><strong>${req.user.name}</strong>${req.user.title ? ` (${req.user.title})` : ''} has paired with you as your submissive.</p>
           ${mail.viewLink('dash', 'View your dashboard')}`,
    path: 'dash'
  });
  res.json({ ok: true, dom: { id: dom.id, name: dom.name, title: dom.title } });
});

router.delete('/', requireAuth, async (req, res) => {
  if (req.user.role === 'sub') {
    if (!req.myDom) return res.status(404).json({ error: 'Not paired' });
    await db.run('UPDATE tasks SET active = 0 WHERE sub_id = ?', req.user.id);
    await db.run('UPDATE prompts SET active = 0 WHERE sub_id = ?', req.user.id);
    await db.run('UPDATE users SET dom_id = NULL WHERE id = ?', req.user.id);
    return res.json({ ok: true });
  }
  const subId = (req.body || {}).sub_id;
  if (!subId) return res.status(400).json({ error: 'sub_id is required' });
  await assertDomOwnsSub(db, req.user.id, subId);
  await db.run('UPDATE tasks SET active = 0 WHERE sub_id = ?', subId);
  await db.run('UPDATE prompts SET active = 0 WHERE sub_id = ?', subId);
  await db.run('UPDATE users SET dom_id = NULL WHERE id = ? AND dom_id = ?', subId, req.user.id);
  res.json({ ok: true });
});

module.exports = router;