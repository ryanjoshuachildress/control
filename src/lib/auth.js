const db = require('../db');

// Starts (or re-creates) a writable session. cookie-session can leave
// req.session null after an invalid cookie or an invalidation in the same
// request, so write paths go through this instead of touching req.session directly.
function startSession(req, userId, pwver) {
  if (!req.session) req.session = {};
  req.session.userId = userId;
  req.session.pwver = pwver;
}

// Attaches the signed-in user to every request; invalidates sessions
// minted before the latest password change (pw_version bump).
async function attachUser(req, res, next) {
  if (req.session && req.session.userId) {
    const u = await db.get('SELECT * FROM users WHERE id = ?', req.session.userId);
    if (!u) {
      req.session = null;
    } else if ((req.session.pwver ?? -1) === u.pw_version) {
      req.user = u;
    } else {
      req.session = null; // password changed since this session was issued
    }
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  next();
}

function requireDom(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  if (req.user.role !== 'dom') return res.status(403).json({ error: 'Dominant only' });
  next();
}

function requireSub(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  if (req.user.role !== 'sub') return res.status(403).json({ error: 'submissive only' });
  next();
}

// First argument kept for call-site compatibility with the SQLite code (its
// better-sqlite3 handle); the helpers module is required directly here.
async function assertDomOwnsSub(_db, domId, subId) {
  const sub = await db.get('SELECT id, name, title, timezone, email, weekly_punish_title, weekly_punish_pct FROM users WHERE id = ? AND dom_id = ? AND role = ?',
    subId, domId, 'sub');
  if (!sub) {
    const err = new Error('Submissive not found in your dynamic');
    err.status = 404;
    throw err;
  }
  return sub;
}

// Household cross-submissive master switch (allow_sub_interaction on the
// Dom's row). Off — the default — keeps every submissive sandboxed from every
// other; on lets submissives in the same dynamic see each other's
// household-wide feed posts and Moment versions.
async function interactionOn(domId) {
  if (!domId) return false;
  const row = await db.get('SELECT allow_sub_interaction AS v FROM users WHERE id = ?', domId);
  return !!row && !!row.v;
}

module.exports = { attachUser, startSession, requireAuth, requireDom, requireSub, assertDomOwnsSub, interactionOn };