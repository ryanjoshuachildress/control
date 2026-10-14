const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../db');
const { UPLOAD_DIR } = require('../db');
const mail = require('../lib/mail');
const { requireAuth, attachUser, requireDom, assertDomOwnsSub, interactionOn } = require('../lib/auth');
const { momentUpload, mediaKind, MULTER_MAX_FILES, MAX_UPLOAD_MB } = require('../lib/uploads');
const { configured: immichConfigured, BASE: immichBase, resolveRefs } = require('../lib/immich');

const router = express.Router();

router.use(attachUser);

// --- household helpers ----------------------------------------------------

// The household's Dominant: themselves for a Dom, their Dom for a submissive.
const householdDomOf = (me) => (me.role === 'dom' ? me.id : me.dom_id);

// Word caps (per spec: summary 2000 words, best/not-so-good 100 words), while
// the closing one-line review is capped at 180 characters.
const wordCount = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;
const RATING_FIELDS = [['r_originality', 'Originality'], ['r_hotness', 'Hotness'], ['r_surprise', 'Surprise'], ['r_connection', 'Connection']];

// Reads and validates one person's version fields from req.body. Shared by
// moment creation and "record your version". Returns { _error } on rejection.
function readVersionFields(body) {
  const again = String(body.again || '').trim().toLowerCase();
  if (again !== 'yes' && again !== 'no') return { _error: 'Answer "would you do it again?" with yes or no' };
  const fields = {
    summary: String(body.summary || ''),
    best_part: String(body.best_part || ''),
    worst_part: String(body.worst_part || ''),
    again,
    review: String(body.review || '')
  };
  for (const [key, label] of RATING_FIELDS) {
    const v = Number(body[key]);
    if (!Number.isInteger(v) || v < 1 || v > 5) {
      return { _error: `Rate ${label.toLowerCase()} from 1 to 5 stars (all four are required)` };
    }
    fields[key] = v;
  }
  if (wordCount(fields.summary) > 2000) return { _error: 'The summary is at most 2000 words' };
  if (wordCount(fields.best_part) > 100) return { _error: '"The best part" is at most 100 words' };
  if (wordCount(fields.worst_part) > 100) return { _error: '"The not so good part" is at most 100 words' };
  if (fields.review.length > 180) return { _error: 'The review is at most 180 characters' };
  return fields;
}

// Attachment rows for many versions in one round-trip (path is UNIQUE, so
// grouping in JS is safe).
async function attMapFor(versionIds) {
  if (!versionIds.length) return {};
  const map = {};
  const atts = await db.all(
    `SELECT id, version_id, path, media FROM moment_attachments
     WHERE version_id IN (${versionIds.map(() => '?').join(',')})
     ORDER BY created_at, path`, ...versionIds);
  for (const a of atts) (map[a.version_id] ||= []).push({ id: a.id, path: a.path, media: a.media });
  return map;
}

// Resolves the creator's tag names against the household master list.
// Unknown names become master-list entries immediately: approved when a Dom
// types them, 'pending' when a submissive does — the Dom approves those.
async function resolveTags(domId, me, raw) {
  const parts = (Array.isArray(raw) ? raw : [raw]).map(String).flatMap(s => s.split(','))
    .map(s => s.trim()).filter(Boolean).slice(0, 24)
    .map(s => s.slice(0, 40));
  const out = [];
  const seen = new Set();
  for (const name of parts) {
    const lower = name.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    let row = await db.get('SELECT id, name, status, created_by FROM tags WHERE dom_id = ? AND name = ?', domId, name);
    if (!row) {
      const id = crypto.randomUUID();
      await db.run('INSERT INTO tags (id, dom_id, name, status, created_by) VALUES (?, ?, ?, ?, ?)',
        id, domId, name, me.role === 'dom' ? 'approved' : 'pending', me.id);
      row = await db.get('SELECT id, name, status, created_by FROM tags WHERE dom_id = ? AND name = ?', domId, name);
    }
    out.push(row);
  }
  return out;
}

// The household's master tag list everyone can attach from, plus the pending
// additions (the Dom approves those; a sub's own pending tags are attachable).
async function tagListFor(domId) {
  if (!domId) return { tags: [], pending: [] };
  const tag = (t) => ({ id: t.id, name: t.name, status: t.status, created_by: t.created_by });
  const tags = (await db.all("SELECT * FROM tags WHERE dom_id = ? AND status = 'approved' ORDER BY name", domId)).map(tag);
  const pending = (await db.all("SELECT * FROM tags WHERE dom_id = ? AND status = 'pending' ORDER BY name", domId)).map(tag);
  return { tags, pending };
}

// Loads a moment group after checking this user may at least SEE it.
// Dom: any group in their household. Sub: groups they created (with or
// without people) or are listed as a person in.
async function loadGroupForReading(me, groupId) {
  const g = await db.get(
    `SELECT g.*, u.name AS creator_name, u.title AS creator_title
     FROM moment_groups g JOIN users u ON u.id = g.created_by
     WHERE g.id = ?`, groupId);
  if (!g) return null;
  if (g.dom_id !== (me.role === 'dom' ? me.id : me.dom_id)) return null;
  if (me.role === 'sub' && g.created_by !== me.id && !(await db.get(
    'SELECT 1 FROM moment_group_subs WHERE group_id = ? AND sub_id = ?', g.id, me.id))) return null;
  return g;
}

// Shapes a group + its versions for this viewer. Version readability:
//   Dom → reads everything in their household.
//   Sub → own version always; the Dom's version only once their own version is
//         recorded (the unlock); other submissives' versions only when the
//         household interaction switch is on (also after recording their own).
// Locked versions keep only enough identity to invite the sub to record.
async function shapeGroup(g, me) {
  const subs = await db.all(
    `SELECT gs.sub_id, u.name, u.title FROM moment_group_subs gs
     JOIN users u ON u.id = gs.sub_id WHERE gs.group_id = ? ORDER BY u.name`, g.id);
  const tags = await db.all(
    `SELECT t.id, t.name, t.status FROM moment_tags gt
     JOIN tags t ON t.id = gt.tag_id WHERE gt.group_id = ? ORDER BY t.name`, g.id);
  const versions = await db.all(
    `SELECT v.*, u.name AS author_name, u.title AS author_title, u.role AS author_role
     FROM moment_versions v JOIN users u ON u.id = v.author_id
     WHERE v.group_id = ? ORDER BY v.created_at ASC`, g.id);
  const atts = await attMapFor(versions.map(v => v.id));

  // Immich links merged alongside uploaded files ({ immich: true, asset_id }).
  const immMap = {};
  if (versions.length) {
    const ids = versions.map(v => v.id);
    const ir = await db.all(
      `SELECT version_id, asset_id, media FROM moment_immich
       WHERE version_id IN (${ids.map(() => '?').join(',')})`, ...ids);
    for (const r of ir) (immMap[r.version_id] ||= []).push({ immich: true, asset_id: r.asset_id, media: r.media });
  }

  const isDomView = me.role === 'dom' && me.id === g.dom_id;
  const isSub = me.role === 'sub';
  const recorded = versions.some(v => v.author_id === me.id);
  const interact = isSub ? await interactionOn(g.dom_id) : false;

  const domUser = await db.get('SELECT id, name, title FROM users WHERE id = ?', g.dom_id);
  const shaped = versions.map(v => {
    const canRead =
      isDomView || v.author_id === me.id ||
      (isSub && recorded && (v.author_id === g.dom_id || interact));
    // name/title mirror the author_* columns so peopleLabel() works on every shape
    if (!canRead) {
      return { locked: true, author_id: v.author_id, name: v.author_name, title: v.author_title,
        author_name: v.author_name, author_title: v.author_title, author_role: v.author_role };
    }
    return {
      id: v.id,
      author_id: v.author_id, name: v.author_name, title: v.author_title,
      author_name: v.author_name, author_title: v.author_title, author_role: v.author_role,
      summary: v.summary, best_part: v.best_part, worst_part: v.worst_part,
      again: v.again, review: v.review,
      ratings: { originality: v.r_originality, hotness: v.r_hotness, surprise: v.r_surprise, connection: v.r_connection },
      attachments: [...(atts[v.id] || []), ...(immMap[v.id] || [])],
      created_at: v.created_at,
      mine: v.author_id === me.id
    };
  });

  // Who was listed but hasn't recorded yet — shown to the Dom only, so a
  // shared moment never looks "blank" to them (subs learn through their own
  // prompt; cross-sub pending status stays behind the interaction switch).
  let pending = [];
  if (isDomView) {
    const recordedIds = new Set(versions.map(v => v.author_id));
    if (!recordedIds.has(g.created_by)) {
      const cu = await db.get('SELECT id, name, title FROM users WHERE id = ?', g.created_by);
      if (cu && cu.id !== g.dom_id) pending.push({ id: cu.id, name: cu.name, title: cu.title });
    }
    for (const s of subs) if (!recordedIds.has(s.sub_id)) pending.push({ id: s.sub_id, name: s.name, title: s.title });
  }

  return {
    id: g.id,
    title: g.title, description: g.description, date: g.mdate, time: g.mtime,
    planned: { kind: g.planned_kind, other: g.planned_other },
    people: {
      dom_involved: !!g.people_dom,
      dom: g.people_dom ? { id: domUser.id, name: domUser.name, title: domUser.title } : null,
      subs,
      other: g.people_other
    },
    created_by: g.created_by, creator_name: g.creator_name, creator_title: g.creator_title,
    created_at: g.created_at,
    tags,
    can_record: !recorded,
    needs_record: isSub && !recorded && shaped.some(v => v.locked && v.author_id === g.dom_id),
    can_delete: isDomView || g.created_by === me.id,
    comment_count: (await db.get(
      "SELECT COUNT(*) AS n FROM comments WHERE subject = 'moment' AND subject_id = ?", g.id)).n,
    pending,
    versions: shaped
  };
}

const PLANNED_LABEL = { planned: 'Planned', spontaneous: 'Spontaneous', both: 'Planned & spontaneous', other: 'Other' };

// --- list + detail --------------------------------------------------------

// GET /api/moments?q=&tag_id= — visible groups for this viewer, optional
// search (title/description/summary/review/tag text) and tag filter.
router.get('/', requireAuth, async (req, res) => {
  const me = req.user;
  const groups = me.role === 'dom'
    ? await db.all(
        `SELECT g.*, u.name AS creator_name, u.title AS creator_title
         FROM moment_groups g JOIN users u ON u.id = g.created_by
         WHERE g.dom_id = ? ORDER BY g.created_at DESC`, me.id)
    : me.dom_id
      ? await db.all(
          `SELECT g.*, u.name AS creator_name, u.title AS creator_title
           FROM moment_groups g JOIN users u ON u.id = g.created_by
           WHERE g.dom_id = ? AND (g.created_by = ? OR EXISTS
             (SELECT 1 FROM moment_group_subs s WHERE s.group_id = g.id AND s.sub_id = ?))
           ORDER BY g.created_at DESC`, me.dom_id, me.id, me.id)
      : [];
  let out = await Promise.all(groups.map(g => shapeGroup(g, me)));
  const q = String(req.query.q || '').trim().toLowerCase();
  const tagId = String(req.query.tag_id || '').trim();
  if (tagId) out = out.filter(g => g.tags.some(t => t.id === tagId));
  if (q) {
    out = out.filter(g =>
      [g.title, g.description, g.people.other,
        ...(g.versions.flatMap(v => v.locked ? [] : [v.summary, v.review])),
        ...g.tags.map(t => t.name)]
        .some(s => String(s || '').toLowerCase().includes(q)));
  }
  res.json({
    groups: out, planned_label: PLANNED_LABEL, tags: await tagListFor(householdDomOf(me)),
    immich_origin: immichConfigured() ? immichBase() : null
  });
});

// GET /api/moments/recap?year=&mode=year|month&month= — yearly or monthly
// roll-up of what this viewer can see. Registered before '/:id' so 'recap'
// is never swallowed by the detail route.
router.get('/recap', requireAuth, async (req, res) => {
  const me = req.user;
  const domId = householdDomOf(me);
  const mode = req.query.mode === 'month' ? 'month' : 'year';
  let year = String(req.query.year || '').trim();
  const ym = /^\d{4}$/;
  if (!ym.test(year)) year = String(new Date().getFullYear());
  let month = String(req.query.month || '').trim();
  const mOk = /^(0?[1-9]|1[0-2])$/.test(month);
  if (mode === 'year' || !mOk) month = mOk ? String(Number(month)) : String(new Date().getMonth() + 1);

  let rows = me.role === 'dom'
    ? await db.all("SELECT g.*, u.name AS creator_name, u.title AS creator_title FROM moment_groups g JOIN users u ON u.id = g.created_by WHERE g.dom_id = ? AND substr(g.mdate, 1, 4) = ?", domId, year)
    : !me.dom_id ? []
    : await db.all(
        `SELECT g.*, u.name AS creator_name, u.title AS creator_title
         FROM moment_groups g JOIN users u ON u.id = g.created_by
         WHERE g.dom_id = ? AND substr(g.mdate, 1, 4) = ?
           AND (g.created_by = ? OR EXISTS
             (SELECT 1 FROM moment_group_subs s WHERE s.group_id = g.id AND s.sub_id = ?))`,
        me.dom_id, year, me.id, me.id);
  if (mode === 'month') rows = rows.filter(g => String(Number(g.mdate.slice(5, 7))) === String(Number(month)));

  // Ratings aggregate over versions this viewer can actually read.
  const shaped = await Promise.all(rows.map(async g => ({ group: await shapeGroup(g, me) })));
  const readable = shaped.flatMap(s => s.group.versions.filter(v => !v.locked));
  const avgOf = (key) => {
    const vals = readable.map(v => v.ratings[key]).filter(v => v >= 1);
    return vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null;
  };
  const avg = { originality: avgOf('originality'), hotness: avgOf('hotness'), surprise: avgOf('surprise'), connection: avgOf('connection') };
  const againYes = readable.filter(v => v.again === 'yes').length;

  // Histograms: moments per month (year view) or per day of month (month view).
  const hist = {};
  for (const g of rows) {
    const k = mode === 'month' ? String(Number(g.mdate.slice(8, 10))) : String(Number(g.mdate.slice(5, 7)));
    hist[k] = (hist[k] || 0) + 1;
  }
  const buckets = [];
  const nBuckets = mode === 'month' ? 31 : 12;
  for (let i = 1; i <= nBuckets; i++) if (hist[i]) buckets.push({ bucket: i, n: hist[i] });

  // Tags across the scope, top 10.
  const tagCounts = {};
  for (const s of shaped) for (const t of s.group.tags) tagCounts[t.name] = (tagCounts[t.name] || 0) + 1;
  const tags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([name, n]) => ({ name, n }));

  // People: how many of the scope's moments each household person was in.
  const peopleCounts = {};
  const addPerson = (p) => { if (p) { peopleCounts[p.id] = peopleCounts[p.id] || { ...p, n: 0 }; peopleCounts[p.id].n++; } };
  for (const s of shaped) {
    addPerson(s.group.people.dom);
    if (s.group.created_by === domId) addPerson(s.group.people.dom); // creator-dom counts too
    for (const p of s.group.people.subs) addPerson({ id: p.sub_id, name: p.name, title: p.title });
  }
  const people = Object.values(peopleCounts).sort((a, b) => b.n - a.n);

  // Top moments: best average of the four ratings, top 5.
  const groupAvg = (g) => {
    const vs = g.versions.filter(v => !v.locked);
    const nums = vs.flatMap(v => Object.values(v.ratings)).filter(v => v >= 1);
    return nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10 : null;
  };
  const top = shaped.map(s => ({ id: s.group.id, title: s.group.title, date: s.group.date, avg: groupAvg(s.group) }))
    .filter(t => t.avg)
    .sort((a, b) => b.avg - a.avg).slice(0, 5);

  const years = (await db.all(
    `SELECT DISTINCT substr(mdate, 1, 4) AS y FROM moment_groups WHERE dom_id = ? ORDER BY y DESC`, domId)).map(r => r.y);

  res.json({ year, month, mode, years, total: rows.length, buckets, tags, people, avg, again_pct: readable.length ? Math.round(againYes / readable.length * 100) : null, top });
});

// GET /api/moments/:id — one group (same visibility rules).
router.get('/:id', requireAuth, async (req, res) => {
  const g = await loadGroupForReading(req.user, req.params.id);
  if (!g) return res.status(404).json({ error: 'Moment not found' });
  res.json({ group: await shapeGroup(g, req.user) });
});

// --- create ---------------------------------------------------------------

// POST /api/moments — both roles record. Multipart: the creator's own version
// fields + optional `media` files + comma-separated `tags`. A Dom lists which
// of their submissives were involved (`sub_ids`, repeatable); a submissive
// only picks "my Dom" (they cannot list other submissives — the Dom controls
// who is in a dynamic). Group + version + attachments + tags in one write.
router.post('/', requireAuth, momentUpload.array('media', MULTER_MAX_FILES), async (req, res) => {
  const me = req.user;
  const b = req.body || {};
  const domId = householdDomOf(me);
  if (!domId) return res.status(400).json({ error: 'Pair with a Dominant first' });

  const title = String(b.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Title is required' });
  if (title.length > 50) return res.status(400).json({ error: 'Title is at most 50 characters' });
  const description = String(b.description || '');
  if (description.length > 160) return res.status(400).json({ error: 'Description is at most 160 characters' });
  const mdate = String(b.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(mdate)) return res.status(400).json({ error: 'Pick the date the moment happened' });
  const mtime = String(b.time || '').trim();
  if (mtime && !/^\d{2}:\d{2}$/.test(mtime)) return res.status(400).json({ error: 'Time format is HH:MM' });
  if (mtime && (Number(mtime.slice(0, 2)) > 23 || Number(mtime.slice(3)) > 59)) {
    return res.status(400).json({ error: 'Time looks impossible (HH:MM, 24h)' });
  }
  const planned_kind = ['planned', 'spontaneous', 'other', 'both'].includes(b.planned_kind) ? b.planned_kind : 'planned';
  const planned_other = String(b.planned_other || '').slice(0, 80);
  if (planned_kind === 'other' && !planned_other.trim()) {
    return res.status(400).json({ error: 'Describe the "other" option' });
  }
  const people_other = String(b.people_other || '').slice(0, 200);
  const people_dom = b.people_dom ? 1 : 0;

  const version = readVersionFields(b);
  if (version._error) return res.status(400).json({ error: version._error });

  let immichRows = [];
  try { immichRows = await resolveRefs(me.id, domId, b.immich); }
  catch (err) { return res.status(err.status || 400).json({ error: err.message }); }

  let subsIn = [];
  try {
    if (me.role === 'dom') {
      const raw = (Array.isArray(b.sub_ids) ? b.sub_ids : b.sub_ids ? [b.sub_ids] : []).map(String).filter(Boolean);
      for (const sid of raw) subsIn.push((await assertDomOwnsSub(db, me.id, sid)).id);
    }
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }

  const tagsOut = [];
  const id = crypto.randomUUID();
  await db.transaction(async () => {
    const verId = crypto.randomUUID();
    await db.run(
      `INSERT INTO moment_groups
         (id, dom_id, created_by, title, description, mdate, mtime, planned_kind, planned_other, people_dom, people_other)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, domId, me.id, title, description.slice(0, 160), mdate, mtime, planned_kind, planned_other, people_dom, people_other);
    await db.run(
      `INSERT INTO moment_versions
         (id, group_id, author_id, summary, best_part, worst_part, again, review, r_originality, r_hotness, r_surprise, r_connection)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      verId, id, me.id, version.summary, version.best_part, version.worst_part, version.again, version.review,
      version.r_originality, version.r_hotness, version.r_surprise, version.r_connection);
    for (const f of (req.files || [])) {
      await db.run('INSERT INTO moment_attachments (id, version_id, path, media) VALUES (?, ?, ?, ?)',
        crypto.randomUUID(), verId, f.filename, mediaKind(f.originalname));
    }
    for (const r of immichRows) {
      await db.run('INSERT INTO moment_immich (id, version_id, asset_id, media) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
        crypto.randomUUID(), verId, r.asset_id, r.media);
    }
    for (const t of await resolveTags(domId, me, b.tags)) {
      tagsOut.push(t);
      await db.run('INSERT INTO moment_tags (group_id, tag_id) VALUES (?, ?) ON CONFLICT DO NOTHING', id, t.id);
    }
    for (const sid of subsIn) {
      await db.run('INSERT INTO moment_group_subs (group_id, sub_id) VALUES (?, ?) ON CONFLICT DO NOTHING', id, sid);
    }
  });

  // Email: involved submissives hear a Dom-created moment exists (and must
  // record their version to read it); the Dom hears a sub-created one.
  const by = me.title ? `${me.title} ${me.name}` : me.name;
  if (me.role === 'dom') {
    for (const sid of subsIn) {
      const u = await db.get('SELECT email, email_notifications FROM users WHERE id = ?', sid);
      if (!u || !u.email_notifications) continue;
      mail.send(u.email, `New moment recorded: ${title}`,
        `<p><strong>${mail.esc(by)}</strong> recorded a moment — <strong>${mail.esc(title)}</strong> on ${mail.esc(mdate)}.</p>
         <p>Record your own version of it to unlock reading theirs.</p>
         ${mail.viewLink(`moments?focus=moment:${id}`, 'Open the moments')}`);
    }
  } else {
    const d = await db.get('SELECT email, email_notifications FROM users WHERE id = ?', domId);
    if (d && d.email_notifications) {
      mail.send(d.email, `New moment recorded: ${title}`,
        `<p><strong>${mail.esc(by)}</strong> recorded a moment — <strong>${mail.esc(title)}</strong> on ${mail.esc(mdate)}.</p>
         ${mail.viewLink(`moments?focus=moment:${id}`, 'Open the moments')}`);
    }
  }

  res.json({ ok: true, id });
});

// --- record your version --------------------------------------------------

// POST /api/moments/:id/version — the recording submissive (or the Dom) adds
// their version of the group's moment. One per person (UNIQUE index).
router.post('/:id/version', requireAuth, momentUpload.array('media', MULTER_MAX_FILES), async (req, res) => {
  const me = req.user;
  const g = await loadGroupForReading(me, req.params.id);
  if (!g) return res.status(404).json({ error: 'Moment not found' });
  const dup = await db.get('SELECT id FROM moment_versions WHERE group_id = ? AND author_id = ?', g.id, me.id);
  if (dup) return res.status(409).json({ error: 'You already recorded your version of this moment' });

  const version = readVersionFields(req.body || {});
  if (version._error) return res.status(400).json({ error: version._error });

  const verId = crypto.randomUUID();
  await db.transaction(async () => {
    await db.run(
      `INSERT INTO moment_versions
         (id, group_id, author_id, summary, best_part, worst_part, again, review, r_originality, r_hotness, r_surprise, r_connection)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      verId, g.id, me.id, version.summary, version.best_part, version.worst_part, version.again, version.review,
      version.r_originality, version.r_hotness, version.r_surprise, version.r_connection);
    for (const f of (req.files || [])) {
      await db.run('INSERT INTO moment_attachments (id, version_id, path, media) VALUES (?, ?, ?, ?)',
        crypto.randomUUID(), verId, f.filename, mediaKind(f.originalname));
    }
  });

  // The recording submissive tells the Dom; a Dom filling one in tells the
  // submissive(s) in the group their read is unlocked.
  const by = me.title ? `${me.title} ${me.name}` : me.name;
  if (me.role === 'sub') {
    const d = await db.get('SELECT email, email_notifications FROM users WHERE id = ?', g.dom_id);
    if (d && d.email_notifications) {
      mail.send(d.email, `A version was recorded: ${g.title}`,
        `<p><strong>${mail.esc(by)}</strong> recorded their version of <strong>${mail.esc(g.title)}</strong>.</p>
         ${mail.viewLink(`moments?focus=moment:${g.id}`, 'Open the moments')}`);
    }
  } else {
    for (const u of await db.all(
      `SELECT u.id, u.email, u.email_notifications FROM moment_group_subs gs
       JOIN users u ON u.id = gs.sub_id WHERE gs.group_id = ?`, g.id)) {
      if (!u.email_notifications) continue;
      mail.send(u.email, `Your Dom added their version of “${g.title}”`,
        `<p>Their account of it is unlocked for you now — yours is too.</p>
         ${mail.viewLink(`moments?focus=moment:${g.id}`, 'Open the moments')}`);
    }
  }

  res.json({ ok: true, id: verId });
});

// PUT /api/moments/:id/version — edit your own recorded version (text and
// ratings re-validated in full; new `media` files are appended; a provided
// `immich` list REPLACES the linked assets — empty string clears them).
// Author-only.
router.put('/:id/version', requireAuth, momentUpload.array('media', MULTER_MAX_FILES), async (req, res) => {
  const me = req.user;
  const g = await loadGroupForReading(me, req.params.id);
  if (!g) return res.status(404).json({ error: 'Moment not found' });
  const v = await db.get('SELECT * FROM moment_versions WHERE group_id = ? AND author_id = ?', g.id, me.id);
  if (!v) return res.status(404).json({ error: 'You have no recorded version on this moment' });

  const b = req.body || {};
  const fields = readVersionFields(b);
  if (fields._error) return res.status(400).json({ error: fields._error });

  let immichRows = null;
  if (b.immich !== undefined) {
    try { immichRows = await resolveRefs(me.id, g.dom_id, b.immich); }
    catch (err) { return res.status(err.status || 400).json({ error: err.message }); }
  }

  await db.transaction(async () => {
    await db.run(
      `UPDATE moment_versions SET summary = ?, best_part = ?, worst_part = ?, again = ?, review = ?,
         r_originality = ?, r_hotness = ?, r_surprise = ?, r_connection = ?
       WHERE id = ?`,
      fields.summary, fields.best_part, fields.worst_part, fields.again, fields.review,
      fields.r_originality, fields.r_hotness, fields.r_surprise, fields.r_connection, v.id);
    for (const f of (req.files || [])) {
      await db.run('INSERT INTO moment_attachments (id, version_id, path, media) VALUES (?, ?, ?, ?)',
        crypto.randomUUID(), v.id, f.filename, mediaKind(f.originalname));
    }
    if (immichRows !== null) {
      await db.run('DELETE FROM moment_immich WHERE version_id = ?', v.id);
      for (const r of immichRows) {
        await db.run('INSERT INTO moment_immich (id, version_id, asset_id, media) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
          crypto.randomUUID(), v.id, r.asset_id, r.media);
      }
    }
  });
  res.json({ ok: true });
});

// DELETE /api/moments/:id/attachments/:attId — the version's author (or the
// household Dom) removes one photo/video; the file is unlinked.
router.delete('/:id/attachments/:attId', requireAuth, async (req, res) => {
  const me = req.user;
  const g = await loadGroupForReading(me, req.params.id);
  if (!g) return res.status(404).json({ error: 'Moment not found' });
  const a = await db.get(
    `SELECT a.id, a.path, v.author_id FROM moment_attachments a
     JOIN moment_versions v ON v.id = a.version_id
     WHERE a.id = ? AND v.group_id = ?`, req.params.attId, g.id);
  if (!a) return res.status(404).json({ error: 'Attachment not found' });
  const allowed = a.author_id === me.id || (me.role === 'dom' && me.id === g.dom_id);
  if (!allowed) return res.status(403).json({ error: 'Not allowed' });
  await db.run('DELETE FROM moment_attachments WHERE id = ?', a.id);
  fs.unlink(path.join(UPLOAD_DIR, a.path), () => { /* already gone is fine */ });
  res.json({ ok: true });
});

// --- tags on a moment -----------------------------------------------------

// POST /api/moments/:id/tags { tags: "a, b" } — attach more tags after the
// fact (same master-list resolution as creation).
router.post('/:id/tags', requireAuth, async (req, res) => {
  const me = req.user;
  const g = await loadGroupForReading(me, req.params.id);
  if (!g) return res.status(404).json({ error: 'Moment not found' });
  const tags = await resolveTags(householdDomOf(me), me, (req.body || {}).tags);
  await db.transaction(async () => {
    for (const t of tags) {
      await db.run('INSERT INTO moment_tags (group_id, tag_id) VALUES (?, ?) ON CONFLICT DO NOTHING', g.id, t.id);
    }
  });
  res.json({ ok: true, added: tags.map(t => ({ id: t.id, name: t.name })) });
});

// DELETE /api/moments/:id/tags/:tagId — detach one tag (creator or Dom; the
// master-list entry itself is untouched).
router.delete('/:id/tags/:tagId', requireAuth, async (req, res) => {
  const me = req.user;
  const g = await loadGroupForReading(me, req.params.id);
  if (!g) return res.status(404).json({ error: 'Moment not found' });
  await db.run('DELETE FROM moment_tags WHERE group_id = ? AND tag_id = ?', g.id, req.params.tagId);
  res.json({ ok: true });
});

// --- master tag list ------------------------------------------------------

// POST /api/moments/tags { name } — propose one tag for the household list.
// Dom: approved immediately. Sub: pending until the Dom approves.
router.post('/tags', requireAuth, async (req, res) => {
  const me = req.user;
  const domId = householdDomOf(me);
  if (!domId) return res.status(400).json({ error: 'Pair with a Dominant first' });
  const name = String((req.body || {}).name || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: 'Tag name is required' });
  const existing = await db.get('SELECT id, status FROM tags WHERE dom_id = ? AND name = ?', domId, name);
  if (existing) {
    return res.status(409).json({ error: 'That tag is already on the list', tag: existing });
  }
  if ((await db.get('SELECT COUNT(*) AS n FROM tags WHERE dom_id = ?', domId)).n >= 500) {
    return res.status(400).json({ error: 'Your tag list is full (500) — remove some first' });
  }
  const id = crypto.randomUUID();
  const status = me.role === 'dom' ? 'approved' : 'pending';
  await db.run('INSERT INTO tags (id, dom_id, name, status, created_by) VALUES (?, ?, ?, ?, ?)', id, domId, name, status, me.id);
  res.json({ ok: true, tag: { id, name, status } });
});

// PATCH /api/moments/tags/:id { name } — the Dom renames a master-list tag.
router.patch('/tags/:id', requireDom, async (req, res) => {
  const u = req.user;
  const t = await db.get('SELECT * FROM tags WHERE id = ?', req.params.id);
  if (!t || t.dom_id !== u.id) return res.status(404).json({ error: 'Tag not found' });
  const name = String((req.body || {}).name || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: 'Tag name is required' });
  try {
    await db.run('UPDATE tags SET name = ? WHERE id = ?', name, t.id);
  } catch (err) {
    // PostgreSQL reports duplicate keys via SQLSTATE 23505
    if (String(err.message).includes('duplicate key')) return res.status(409).json({ error: 'Another tag already has that name' });
    throw err;
  }
  res.json({ ok: true });
});

// POST /api/moments/tags/:id/approve — the Dom approves a pending tag. If an
// approved tag already spells the same thing, the pending one merges into it.
router.post('/tags/:id/approve', requireDom, async (req, res) => {
  const u = req.user;
  const t = await db.get('SELECT * FROM tags WHERE id = ?', req.params.id);
  if (!t || t.dom_id !== u.id) return res.status(404).json({ error: 'Tag not found' });
  if (t.status !== 'pending') return res.json({ ok: true });
  await db.transaction(async () => {
    const same = await db.get("SELECT id FROM tags WHERE dom_id = ? AND name = ? AND id != ?", u.id, t.name, t.id);
    if (same) {
      await db.run('INSERT INTO moment_tags (group_id, tag_id) SELECT group_id, ? FROM moment_tags WHERE tag_id = ? ON CONFLICT DO NOTHING', same.id, t.id);
      await db.run('DELETE FROM tags WHERE id = ?', t.id); // moment_tags rows cascade
    } else {
      await db.run("UPDATE tags SET status = 'approved' WHERE id = ?", t.id);
    }
  });
  res.json({ ok: true });
});

// DELETE /api/moments/tags/:id — the Dom removes a tag from the master list
// (attachments on moments cascade with it).
router.delete('/tags/:id', requireDom, async (req, res) => {
  const u = req.user;
  const t = await db.get('SELECT * FROM tags WHERE id = ?', req.params.id);
  if (!t || t.dom_id !== u.id) return res.status(404).json({ error: 'Tag not found' });
  await db.run('DELETE FROM tags WHERE id = ?', t.id);
  res.json({ ok: true });
});

// --- delete a moment ------------------------------------------------------

// DELETE /api/moments/:id — the household Dom or the group's creator. Group,
// versions, attachments (files unlinked) and tag attachments all go.
router.delete('/:id', requireAuth, async (req, res) => {
  const me = req.user;
  const g = await loadGroupForReading(me, req.params.id);
  if (!g) return res.status(404).json({ error: 'Moment not found' });
  const allowed = (me.role === 'dom' && g.dom_id === me.id) || g.created_by === me.id;
  if (!allowed) return res.status(403).json({ error: 'Not allowed' });
  const atts = await db.all(
    `SELECT a.path FROM moment_attachments a JOIN moment_versions v ON v.id = a.version_id
     WHERE v.group_id = ?`, g.id);
  await db.run('DELETE FROM moment_groups WHERE id = ?', g.id); // everything cascades
  for (const a of atts) fs.unlink(path.join(UPLOAD_DIR, a.path), () => { /* already gone is fine */ });
  res.json({ ok: true });
});

// --- multer errors → client-friendly statuses (same as feed.js) -----------
router.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE'
      ? `File too large (max ${MAX_UPLOAD_MB} MB)`
      : err.code === 'LIMIT_UNEXPECTED_FILE'
        ? `Too many attachments (max ${MULTER_MAX_FILES})`
        : err.message;
    return res.status(400).json({ error: msg });
  }
  if (err.status) return res.status(err.status).json({ error: err.message });
  res.status(500).json({ error: err.message || 'Server error' });
});

module.exports = router;