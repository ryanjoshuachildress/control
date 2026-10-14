const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const db = require('../db');
const { UPLOAD_DIR } = require('../db');
const { requireDom, requireSub, assertDomOwnsSub, attachUser } = require('../lib/auth');
const { resolveRefs } = require('../lib/immich');

const router = require("../lib/router")();

router.use(attachUser);

// Fields are Dom-global: every paired submissive's profile carries every field.
// Values and visibility are per-submissive and set here, one sub at a time.
// kind: 'text' (one line), 'multiline' (long text) or 'photo' (uploaded image).

// Profile photos go to the same uploads folder as evidence (prefix pf-), but
// images only, and they keep a small size limit.
const PHOTO_EXT = /\.(jpe?g|png|gif|webp)$/i;
const photoUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
      cb(null, `pf-${Date.now()}-${crypto.randomBytes(5).toString('hex')}${ext}`);
    }
  }),
  limits: { fileSize: Math.min(Number(process.env.MAX_UPLOAD_MB || 100), 20) * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, PHOTO_EXT.test(file.originalname.toLowerCase()))
});

// Removes a photo file a profile value points at (best effort — nothing breaks
// if the file is already gone).
function removePhotoFile(value) {
  if (!value || !/^pf-[\w.-]+$/.test(value)) return;
  try { fs.unlinkSync(path.join(UPLOAD_DIR, value)); } catch { /* already gone */ }
}

// Dom: full profile of one submissive — every field, its value, and whether
// that submissive can see it.
router.get('/sub/:subId', requireDom, async (req, res) => {
  const sub = await assertDomOwnsSub(db, req.user.id, req.params.subId);
  const fields = await db.all('SELECT * FROM profile_fields WHERE dom_id = ? ORDER BY position, created_at', req.user.id);
  const valMap = Object.fromEntries(
    (await db.all('SELECT field_id, value, immich_asset_id, immich_media, updated_at FROM profile_values WHERE sub_id = ?', sub.id))
      .map(v => [v.field_id, v]));
  const visible = new Set(
    (await db.all('SELECT field_id FROM profile_exposure WHERE sub_id = ?', sub.id)).map(e => e.field_id));
  res.json({
    sub: { id: sub.id, name: sub.name, title: sub.title },
    fields: fields.map(f => ({
      id: f.id,
      label: f.label,
      kind: f.kind || (f.multiline ? 'multiline' : 'text'),
      multiline: !!f.multiline,
      value: valMap[f.id] ? valMap[f.id].value : '',
      im_asset_id: valMap[f.id] ? valMap[f.id].immich_asset_id : null,
      im_media: valMap[f.id] ? valMap[f.id].immich_media : '',
      updated_at: valMap[f.id] ? valMap[f.id].updated_at : null,
      visible_to_sub: visible.has(f.id)
    }))
  });
});

// sub: their own profile, read-only — only the fields the Dom exposed to them,
// and only from their current Dom's catalog.
router.get('/mine', requireSub, async (req, res) => {
  if (!req.user.dom_id) return res.json({ dom: null, fields: [] });
  const dom = await db.get('SELECT id, name, title FROM users WHERE id = ?', req.user.dom_id);
  const fields = await db.all(
    `SELECT f.id, f.label, f.kind, f.multiline, v.value, v.immich_asset_id, v.immich_media, v.updated_at
     FROM profile_exposure pe
     JOIN profile_fields f ON f.id = pe.field_id AND f.dom_id = ?
     LEFT JOIN profile_values v ON v.field_id = f.id AND v.sub_id = ?
     ORDER BY f.position, f.created_at`, req.user.dom_id, req.user.id);
  res.json({
    dom: dom ? { id: dom.id, name: dom.name, title: dom.title } : null,
    fields: fields.map(f => ({
      id: f.id, label: f.label,
      kind: f.kind || (f.multiline ? 'multiline' : 'text'),
      multiline: !!f.multiline,
      value: f.value == null ? '' : f.value,
      im_asset_id: f.immich_asset_id, im_media: f.immich_media || '',
      updated_at: f.updated_at
    }))
  });
});

// ---------- Dom: field catalog ----------

const FIELD_KINDS = ['text', 'multiline', 'photo'];

router.post('/fields', requireDom, async (req, res) => {
  const { label, kind, multiline } = req.body || {};
  const labelStr = String(label || '').trim();
  if (!labelStr) return res.status(400).json({ error: 'Field name is required' });
  // kind wins; fall back to the old multiline boolean for older callers
  const kindStr = FIELD_KINDS.includes(kind) ? kind : (multiline === true ? 'multiline' : 'text');
  const pos = (await db.get('SELECT COALESCE(MAX(position), -1) AS m FROM profile_fields WHERE dom_id = ?', req.user.id)).m + 1;
  const id = crypto.randomUUID();
  await db.run('INSERT INTO profile_fields (id, dom_id, label, kind, multiline, position) VALUES (?, ?, ?, ?, ?, ?)',
    id, req.user.id, labelStr.slice(0, 120), kindStr, kindStr === 'multiline' ? 1 : 0, pos);
  res.json({ ok: true, id });
});

router.patch('/fields/:id', requireDom, async (req, res) => {
  const field = await db.get('SELECT * FROM profile_fields WHERE id = ? AND dom_id = ?', req.params.id, req.user.id);
  if (!field) return res.status(404).json({ error: 'Field not found' });
  const { label } = req.body || {};
  const labelStr = String(label === undefined ? field.label : label).trim();
  if (!labelStr) return res.status(400).json({ error: 'Field name is required' });
  await db.run('UPDATE profile_fields SET label = ? WHERE id = ?', labelStr.slice(0, 120), field.id);
  res.json({ ok: true });
});

router.delete('/fields/:id', requireDom, async (req, res) => {
  const field = await db.get('SELECT * FROM profile_fields WHERE id = ? AND dom_id = ?', req.params.id, req.user.id);
  if (!field) return res.status(404).json({ error: 'Field not found' });
  // clean up photo files this field's values point at (values cascade on delete)
  for (const v of await db.all('SELECT value FROM profile_values WHERE field_id = ?', field.id)) {
    removePhotoFile(v.value);
  }
  await db.run('DELETE FROM profile_fields WHERE id = ?', field.id); // values + exposure cascade
  res.json({ ok: true });
});

// ---------- Dom: one submissive's values + visibility ----------

async function ownField(req, fieldId) {
  const field = await db.get('SELECT * FROM profile_fields WHERE id = ? AND dom_id = ?', fieldId, req.user.id);
  if (!field) {
    const err = new Error('Field not found');
    err.status = 404;
    throw err;
  }
  return field;
}

router.put('/sub/:subId/value', requireDom, async (req, res) => {
  const sub = await assertDomOwnsSub(db, req.user.id, req.params.subId);
  const field = await ownField(req, String((req.body || {}).field_id || ''));
  if (field.kind === 'photo') {
    return res.status(400).json({ error: 'Photo fields are set with an upload, not text' });
  }
  const value = String((req.body || {}).value || '').slice(0, 4000);
  await db.run(
    `INSERT INTO profile_values (id, field_id, sub_id, value) VALUES (?, ?, ?, ?)
     ON CONFLICT (field_id, sub_id) DO UPDATE SET value = excluded.value,
       updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`,
    crypto.randomUUID(), field.id, sub.id, value);
  res.json({ ok: true });
});

// Dom: set (or replace) a photo field's image for one submissive. The value
// stored is the file's name, or — with asset_id — an Immich library link
// (immich_asset_id column); both are served only to that sub and their Dom.
router.post('/sub/:subId/photo', requireDom, (req, res) => {
  photoUpload.single('photo')(req, res, async (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? 'Photo too large (20 MB max)'
        : /fileFilter|unexpected field|invalid/i.test(String(err)) ? 'Only jpg, png, gif or webp images are allowed'
        : (err.message || 'Upload failed');
      return res.status(400).json({ error: msg });
    }
    try {
      const sub = await assertDomOwnsSub(db, req.user.id, req.params.subId);
      const field = await ownField(req, String((req.body || {}).field_id || ''));
      if (field.kind !== 'photo') return res.status(400).json({ error: 'This field is not a photo field' });

      // Immich-linked photo (uploads stay optional)
      let immichRow = null;
      if ((req.body || {}).asset_id) {
        try { [immichRow] = await resolveRefs(req.user.id, req.user.id, req.body.asset_id); }
        catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
      }
      if (!req.file && !immichRow) return res.status(400).json({ error: 'Choose a photo first' });

      const prev = await db.get('SELECT value FROM profile_values WHERE field_id = ? AND sub_id = ?', field.id, sub.id);
      await db.run(
        `INSERT INTO profile_values (id, field_id, sub_id, value, immich_asset_id, immich_media)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (field_id, sub_id) DO UPDATE SET
           value = excluded.value, immich_asset_id = excluded.immich_asset_id,
           immich_media = excluded.immich_media,
           updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`,
        crypto.randomUUID(), field.id, sub.id, req.file ? req.file.filename : '',
        immichRow ? immichRow.asset_id : null, immichRow ? immichRow.media : '');
      removePhotoFile(prev ? prev.value : null); // keep the replaced image from piling up

      res.json({ ok: true, value: req.file ? req.file.filename : null,
        asset_id: immichRow ? immichRow.asset_id : null });
    } catch (e) {
      if (req.file) removePhotoFile(req.file.filename); // don't keep orphans on failure
      console.error(e);
      res.status(e.status || 500).json({ error: e.message || 'Upload failed' });
    }
  });
});

// Show or hide a single field to this single submissive.
router.patch('/expose', requireDom, async (req, res) => {
  const sub = await assertDomOwnsSub(db, req.user.id, String((req.body || {}).sub_id || ''));
  const field = await ownField(req, String((req.body || {}).field_id || ''));
  const visible = !!(req.body || {}).visible;
  if (visible) {
    await db.run('INSERT INTO profile_exposure (field_id, sub_id) VALUES (?, ?) ON CONFLICT DO NOTHING', field.id, sub.id);
  } else {
    await db.run('DELETE FROM profile_exposure WHERE field_id = ? AND sub_id = ?', field.id, sub.id);
  }
  res.json({ ok: true, visible });
});

module.exports = router;