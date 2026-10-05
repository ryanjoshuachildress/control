const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const time = require('../lib/time');
const { requireDom, requireSub, assertDomOwnsSub, attachUser } = require('../lib/auth');

const router = express.Router();

router.use(attachUser);

// submissive: today's check-in (for prefilling the form)
router.get('/today', requireSub, (req, res) => {
  const date = time.currentDateKey(new Date(), req.user.timezone);
  const checkin = db.prepare('SELECT * FROM checkins WHERE sub_id = ? AND date = ?').get(req.user.id, date) || null;
  if (checkin) {
    checkin.comment_count = db.prepare(
      "SELECT COUNT(*) AS n FROM comments WHERE subject = 'checkin' AND subject_id = ?").get(checkin.id).n;
  }
  res.json({ date, timezone: req.user.timezone, checkin });
});

// submissive: create or update today's check-in
router.post('/', requireSub, (req, res) => {
  const { mood, day_rating, best_part, worst_part, sexual_notes } = req.body || {};
  const clamp = (n) => Math.max(1, Math.min(10, Number(n) || 0));
  const moodV = clamp(mood), ratingV = clamp(day_rating);
  if (!mood || !day_rating) return res.status(400).json({ error: 'Mood and day rating are required' });

  const date = time.currentDateKey(new Date(), req.user.timezone);
  const existing = db.prepare('SELECT id FROM checkins WHERE sub_id = ? AND date = ?').get(req.user.id, date);
  if (existing) {
    db.prepare(`UPDATE checkins SET mood = ?, day_rating = ?, best_part = ?, worst_part = ?, sexual_notes = ?, updated_at = datetime('now')
                WHERE id = ?`)
      .run(moodV, ratingV, String(best_part || '').slice(0, 2000), String(worst_part || '').slice(0, 2000),
           String(sexual_notes || '').slice(0, 4000), existing.id);
    res.json({ ok: true, date, checkin_id: existing.id });
  } else {
    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO checkins (id, sub_id, date, mood, day_rating, best_part, worst_part, sexual_notes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, req.user.id, date, moodV, ratingV,
           String(best_part || '').slice(0, 2000), String(worst_part || '').slice(0, 2000),
           String(sexual_notes || '').slice(0, 4000));
    res.json({ ok: true, date, checkin_id: id });
  }
});

// submissive: own recent check-ins
router.get('/mine', requireSub, (req, res) => {
  const rows = db.prepare('SELECT * FROM checkins WHERE sub_id = ? ORDER BY date DESC LIMIT 30').all(req.user.id);
  res.json({ checkins: rows });
});

// dominant: a sub's check-ins
router.get('/dom/:subId', requireDom, (req, res) => {
  const sub = assertDomOwnsSub(db, req.user.id, req.params.subId);
  const rows = db.prepare(
    `SELECT c.*, (SELECT COUNT(*) FROM comments cm WHERE cm.subject = 'checkin' AND cm.subject_id = c.id) AS comment_count
     FROM checkins c WHERE c.sub_id = ? ORDER BY c.date DESC LIMIT 60`).all(sub.id);
  res.json({ sub: { id: sub.id, name: sub.name, title: sub.title }, checkins: rows });
});

module.exports = router;