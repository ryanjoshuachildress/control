const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { requireDom, requireSub, assertDomOwnsSub, attachUser } = require('../lib/auth');

const router = express.Router();

router.use(attachUser);

// Fields are Dom-global: every paired submissive's profile carries every field.
// Values and visibility are per-submissive and set here, one sub at a time.

// Dom: full profile of one submissive — every field, its value, and whether
// that submissive can see it.
router.get('/sub/:subId', requireDom, (req, res) => {
  const sub = assertDomOwnsSub(db, req.user.id, req.params.subId);
  const fields = db.prepare('SELECT * FROM profile_fields WHERE dom_id = ? ORDER BY position, created_at').all(req.user.id);
  const valMap = Object.fromEntries(
    db.prepare('SELECT field_id, value, updated_at FROM profile_values WHERE sub_id = ?').all(sub.id)
      .map(v => [v.field_id, v]));
  const visible = new Set(
    db.prepare('SELECT field_id FROM profile_exposure WHERE sub_id = ?').all(sub.id).map(e => e.field_id));
  res.json({
    sub: { id: sub.id, name: sub.name, title: sub.title },
    fields: fields.map(f => ({
      id: f.id,
      label: f.label,
      multiline: !!f.multiline,
      value: valMap[f.id] ? valMap[f.id].value : '',
      updated_at: valMap[f.id] ? valMap[f.id].updated_at : null,
      visible_to_sub: visible.has(f.id)
    }))
  });
});

// sub: their own profile, read-only — only the fields the Dom exposed to them,
// and only from their current Dom's catalog.
router.get('/mine', requireSub, (req, res) => {
  if (!req.user.dom_id) return res.json({ dom: null, fields: [] });
  const dom = db.prepare('SELECT id, name, title FROM users WHERE id = ?').get(req.user.dom_id);
  const fields = db.prepare(
    `SELECT f.id, f.label, f.multiline, v.value, v.updated_at
     FROM profile_exposure pe
     JOIN profile_fields f ON f.id = pe.field_id AND f.dom_id = ?
     LEFT JOIN profile_values v ON v.field_id = f.id AND v.sub_id = ?
     ORDER BY f.position, f.created_at`).all(req.user.dom_id, req.user.id);
  res.json({
    dom: dom ? { id: dom.id, name: dom.name, title: dom.title } : null,
    fields: fields.map(f => ({
      id: f.id, label: f.label, multiline: !!f.multiline,
      value: f.value == null ? '' : f.value, updated_at: f.updated_at
    }))
  });
});

// ---------- Dom: field catalog ----------

router.post('/fields', requireDom, (req, res) => {
  const { label, multiline } = req.body || {};
  const labelStr = String(label || '').trim();
  if (!labelStr) return res.status(400).json({ error: 'Field name is required' });
  const pos = db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM profile_fields WHERE dom_id = ?')
    .get(req.user.id).m + 1;
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO profile_fields (id, dom_id, label, multiline, position) VALUES (?, ?, ?, ?, ?)')
    .run(id, req.user.id, labelStr.slice(0, 120), multiline === true ? 1 : 0, pos);
  res.json({ ok: true, id });
});

router.patch('/fields/:id', requireDom, (req, res) => {
  const field = db.prepare('SELECT * FROM profile_fields WHERE id = ? AND dom_id = ?').get(req.params.id, req.user.id);
  if (!field) return res.status(404).json({ error: 'Field not found' });
  const { label } = req.body || {};
  const labelStr = String(label === undefined ? field.label : label).trim();
  if (!labelStr) return res.status(400).json({ error: 'Field name is required' });
  db.prepare('UPDATE profile_fields SET label = ? WHERE id = ?').run(labelStr.slice(0, 120), field.id);
  res.json({ ok: true });
});

router.delete('/fields/:id', requireDom, (req, res) => {
  const field = db.prepare('SELECT * FROM profile_fields WHERE id = ? AND dom_id = ?').get(req.params.id, req.user.id);
  if (!field) return res.status(404).json({ error: 'Field not found' });
  db.prepare('DELETE FROM profile_fields WHERE id = ?').run(field.id); // values + exposure cascade
  res.json({ ok: true });
});

// ---------- Dom: one submissive's values + visibility ----------

function ownField(req, fieldId) {
  const field = db.prepare('SELECT * FROM profile_fields WHERE id = ? AND dom_id = ?').get(fieldId, req.user.id);
  if (!field) {
    const err = new Error('Field not found');
    err.status = 404;
    throw err;
  }
  return field;
}

router.put('/sub/:subId/value', requireDom, (req, res) => {
  const sub = assertDomOwnsSub(db, req.user.id, req.params.subId);
  const field = ownField(req, String((req.body || {}).field_id || ''));
  const value = String((req.body || {}).value || '').slice(0, 4000);
  db.prepare(
    `INSERT INTO profile_values (id, field_id, sub_id, value) VALUES (?, ?, ?, ?)
     ON CONFLICT (field_id, sub_id) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`)
    .run(crypto.randomUUID(), field.id, sub.id, value);
  res.json({ ok: true });
});

// Show or hide a single field to this single submissive.
router.patch('/expose', requireDom, (req, res) => {
  const sub = assertDomOwnsSub(db, req.user.id, String((req.body || {}).sub_id || ''));
  const field = ownField(req, String((req.body || {}).field_id || ''));
  const visible = !!(req.body || {}).visible;
  if (visible) {
    db.prepare('INSERT OR IGNORE INTO profile_exposure (field_id, sub_id) VALUES (?, ?)').run(field.id, sub.id);
  } else {
    db.prepare('DELETE FROM profile_exposure WHERE field_id = ? AND sub_id = ?').run(field.id, sub.id);
  }
  res.json({ ok: true, visible });
});

module.exports = router;