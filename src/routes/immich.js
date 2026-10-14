// Immich proxies for Moments. Thumbnails and originals stream through Control
// so no Immich API key ever reaches a browser. Two classes of access:
//   /pick/...  — the recorder's own browsing picker (their key pool)
//   /asset/... — assets already attached to a moment (same visibility rules
//                as moment uploads: household dom, the version's author, or a
//                member who has recorded — plus the interaction switch for a
//                fellow submissive's version)
const express = require('express');
const db = require('../db');
const { requireAuth, attachUser, interactionOn } = require('../lib/auth');
const { BASE, configured, keyPool, searchAssets, assetStream } = require('../lib/immich');

const router = require("../lib/router")();

router.use(attachUser);

// Stream an Immich response into the Express response (ranges preserved).
async function proxy(res, fetched) {
  if (!fetched) return res.status(404).json({ error: 'Asset not accessible' });
  res.status(fetched.status);
  const ct = fetched.headers.get('content-type');
  if (ct) res.setHeader('content-type', ct);
  for (const h of ['content-length', 'content-range', 'accept-ranges', 'cache-control']) {
    const v = fetched.headers.get(h);
    if (v) res.setHeader(h, v);
  }
  const reader = fetched.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
      // backpressure: pause when the socket is full
      if (res.writableNeedDrain) await new Promise(r => res.once('drain', r));
    }
    res.end();
  } catch (err) {
    res.destroy();
  }
}

// GET /api/immich/search?start=&end=&page=&size= — picker feed around a date
// window. start/end are ISO instants computed by the browser (its timezone).
router.get('/search', requireAuth, async (req, res) => {
  const me = req.user;
  const domId = me.role === 'dom' ? me.id : me.dom_id;
  if (!domId) return res.status(400).json({ error: 'Pair with a Dominant first' });
  if (!configured()) return res.status(400).json({ error: 'Immich is not configured on this server' });
  const { start, end } = req.query;
  if (!/^\d{4}-\d{2}-\d{2}T/.test(String(start || '')) || !/^\d{4}-\d{2}-\d{2}T/.test(String(end || ''))) {
    return res.status(400).json({ error: 'Missing date window' });
  }
  const keys = await keyPool(me.id, domId);
  if (!keys.length) return res.status(400).json({ error: 'No Immich API key on file — add one in Settings' });
  const r = await searchAssets(keys[0], {
    start, end,
    page: Math.max(1, Number(req.query.page) || 1),
    size: Math.min(500, Math.max(1, Number(req.query.size) || 100))
  });
  if (r.error) return res.status(400).json({ error: r.error });
  res.json(r);
});

// GET /api/immich/pick/:assetId/thumb — thumbnails while BROWSING (not yet
// attached), so only the viewer's key pool applies, no moment sharing rules.
router.get('/pick/:assetId/thumb', requireAuth, async (req, res) => {
  const me = req.user;
  const domId = me.role === 'dom' ? me.id : me.dom_id;
  if (!domId || !configured()) return res.status(400).json({ error: 'Immich is not configured' });
  const keys = await keyPool(me.id, domId);
  proxy(res, await assetStream(req.params.assetId, '/thumbnail?size=preview', keys));
});

// GET /api/immich/asset/:assetId/thumb|/original — attached assets, guarded.
// The same asset may be linked from many places (moments, feed posts, task or
// punishment evidence, profile photos) — access is granted if the viewer can
// see ANY of them, each by its own feature's rules.
router.get('/asset/:assetId/:what(thumb|original)', requireAuth, async (req, res) => {
  const me = req.user;
  const domId = me.role === 'dom' ? me.id : me.dom_id;
  if (!domId || !configured()) return res.status(400).json({ error: 'Immich is not configured' });
  const asset = req.params.assetId;
  const interact = await interactionOn(domId);

  // moments: household dom, the version's author, or a member who has recorded
  const momentRows = await db.all(
    `SELECT v.author_id AS owner_id, g.dom_id AS owner_dom,
            (SELECT 1 FROM moment_versions mv WHERE mv.group_id = g.id AND mv.author_id = ?) AS viewer_recorded
     FROM moment_immich mi
     JOIN moment_versions v ON v.id = mi.version_id
     JOIN moment_groups g ON g.id = v.group_id
     WHERE mi.asset_id = ?`, me.id, asset);

  // feed posts: author, household dom, a targeted sub, or any household sub
  // for household-wide posts while interaction is on
  const feedRows = await db.all(
    `SELECT p.author_id AS owner_id, p.dom_id AS owner_dom,
            (SELECT 1 FROM feed_post_targets ft WHERE ft.post_id = p.id AND ft.sub_id = ?) AS targeted
     FROM feed_immich fi
     JOIN feed_posts p ON p.id = fi.post_id
     WHERE fi.asset_id = ?`, me.id, asset);

  // task/punishment evidence: the submitting sub and their dom
  const evRows = await db.all(
    `SELECT s.id AS owner_id, s.dom_id AS owner_dom, s.id AS evidence_sub FROM completions c
     JOIN tasks t ON t.id = c.task_id JOIN users s ON s.id = t.sub_id
     WHERE c.immich_asset_id = ?
     UNION ALL SELECT s.id, s.dom_id, s.id FROM punishments pu
               JOIN users s ON s.id = pu.sub_id WHERE pu.immich_asset_id = ?`, asset, asset);

  // profile photos: that submissive and their dom
  const pvRows = await db.all(
    `SELECT u.id AS owner_id, u.dom_id AS owner_dom FROM profile_values pv
     JOIN users u ON u.id = pv.sub_id WHERE pv.immich_asset_id = ?`, asset);

  if (!momentRows.length && !feedRows.length && !evRows.length && !pvRows.length) {
    return res.status(404).json({ error: 'Not found' });
  }
  const allowed =
    momentRows.some(r => me.id === r.owner_id
      || (me.role === 'dom' && me.id === r.owner_dom)
      || (me.role === 'sub' && r.viewer_recorded && me.dom_id === r.owner_dom
        && (r.owner_id === r.owner_dom || interact)))
    || feedRows.some(r => me.id === r.owner_id
      || (me.role === 'dom' && me.id === r.owner_dom)
      || (me.role === 'sub' && (r.targeted || (interact && r.owner_dom === me.dom_id))))
    || evRows.some(r => me.id === r.evidence_sub || (me.role === 'dom' && me.id === r.owner_dom))
    || pvRows.some(r => me.id === r.owner_id || (me.role === 'dom' && me.id === r.owner_dom));
  if (!allowed) return res.status(403).json({ error: 'Not allowed' });

  const r = (momentRows[0] || feedRows[0] || evRows[0] || pvRows[0] || {});
  const suffix = req.params.what === 'thumb' ? '/thumbnail?size=preview' : '/original';
  proxy(res, await assetStream(asset, suffix, await keyPool(r.owner_id || me.id, r.owner_dom || domId),
    req.params.what === 'original' ? req.headers.range : undefined));
});

module.exports = router;