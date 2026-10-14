// Immich integration: link photos/videos from the household's Immich library
// into Moments instead of uploading copies. API keys stay server-side —
// browsers only ever see Control's own proxies (/api/immich/...).
const db = require('../db');

const BASE = () => (process.env.IMMICH_URL || '').replace(/\/+$/, '');
const configured = () => !!BASE();

// Ordered pool of keys that may resolve an asset for this author:
//   their own key → the household Dom's key → the IMMICH_KEY env fallback →
//   any other household member's key. First working key wins, so a submissive
//   can link from their own library and the Dom still sees it.
async function keyPool(authorId, domId) {
  const out = [];
  const push = (k) => { if (k && !out.includes(k)) out.push(k); };
  if (authorId) push((await db.get('SELECT immich_key AS k FROM users WHERE id = ?', authorId) || {}).k);
  if (domId && domId !== authorId) push((await db.get('SELECT immich_key AS k FROM users WHERE id = ?', domId) || {}).k);
  push(process.env.IMMICH_KEY);
  if (domId) {
    for (const r of await db.all(
      "SELECT immich_key AS k FROM users WHERE dom_id = ? AND immich_key != ''", domId)) push(r.k);
  }
  return out;
}

// First key that can read the asset → { meta, key }, else null.
async function assetMeta(assetId, keys) {
  for (const key of keys) {
    try {
      const res = await fetch(`${BASE()}/api/assets/${encodeURIComponent(assetId)}`, {
        headers: { 'x-api-key': key },
        signal: AbortSignal.timeout(10000)
      });
      if (res.status === 200) return { meta: await res.json(), key };
    } catch { /* try next key / allow later retry */ }
  }
  return null;
}

// Fetch a raw asset stream (thumbnail ?size=preview, or /original) for
// proxying. Range headers pass through for video playback.
async function assetStream(assetId, suffix, keys, range) {
  for (const key of keys) {
    const h = { 'x-api-key': key };
    if (range) h.range = range;
    try {
      const res = await fetch(`${BASE()}/api/assets/${encodeURIComponent(assetId)}${suffix}`, {
        headers: h,
        signal: AbortSignal.timeout(15000)
      });
      if (res.ok) return res;
    } catch { /* try next key */ }
  }
  return null;
}

const mediaOf = (meta) => (meta && String(meta.type || '').toUpperCase() === 'VIDEO' ? 'video' : 'image');

// Picker search around a date window (viewer's key pool, first key only —
// Immich enforces per-user library access itself). Sorted newest-first here
// rather than via Immich's order param (version-dependent).
async function searchAssets(leadKey, { start, end, page, size }) {
  const res = await fetch(`${BASE()}/api/search/metadata`, {
    method: 'POST',
    headers: { 'x-api-key': leadKey, 'content-type': 'application/json' },
    body: JSON.stringify({ takenAfter: start, takenBefore: end, page: page || 1, size: size || 100 }),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) return { error: `Immich search failed (${res.status})` };
  const j = await res.json().catch(() => ({}));
  const items = (((j.assets || {}).items) || [])
    .map(a => ({ id: a.id, media: String(a.type || '').toUpperCase() === 'VIDEO' ? 'video' : 'image', takenAt: a.takenAt || a.fileCreatedAt || '' }))
    .sort((a, b) => String(b.takenAt).localeCompare(String(a.takenAt)))
    .map(a => ({ id: a.id, media: a.media }));
  return { items };
}

// Parse pasted/typed Immich references: bare asset ids or /photos/<id> URLs.
const ACTID_RE = /^[0-9a-fA-F-]{8,64}$/;
function idsFromPayload(raw) {
  const parts = (Array.isArray(raw) ? raw : [raw]).map(String).join(',').split(',')
    .map(s => s.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    const m = p.match(/photos\/([0-9a-fA-F-]{8,64})/) || (ACTID_RE.test(p) ? [null, p] : null);
    if (m && m[1] && !out.includes(m[1])) out.push(m[1]);
  }
  return out.slice(0, 40);
}

// Validate Immich references for any feature payload against the household
// key pool. Throws { status } shaped errors; returns [{asset_id, media}].
async function resolveRefs(actorId, domId, raw) {
  const ids = idsFromPayload(raw);
  if (!ids.length) return [];
  if (!BASE()) {
    throw Object.assign(new Error('Immich is not configured on this server — upload the files instead'), { status: 400 });
  }
  const keys = await keyPool(actorId, domId);
  if (!keys.length) {
    throw Object.assign(new Error('No Immich API key on file — add one in Settings, or upload the files'), { status: 400 });
  }
  const rows = [];
  for (const id of ids) {
    const found = await assetMeta(id, keys);
    if (!found) {
      throw Object.assign(new Error(`Immich asset ${id} is not accessible — check it is shared or use your own API key in Settings`), { status: 400 });
    }
    rows.push({ asset_id: id, media: mediaOf(found.meta) });
  }
  return rows;
}

module.exports = { BASE, configured, keyPool, assetMeta, assetStream, mediaOf, searchAssets, idsFromPayload, resolveRefs };