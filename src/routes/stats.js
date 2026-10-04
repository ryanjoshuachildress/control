const express = require('express');
const db = require('../db');
const time = require('../lib/time');
const { requireAuth, requireDom, requireSub, assertDomOwnsSub, attachUser } = require('../lib/auth');

const router = express.Router();

router.use(attachUser);

function buildStats(subId, subTz, days) {
  const now = new Date();
  const todayKey = time.currentDateKey(now, subTz);
  const sinceDate = new Date(Date.UTC(
    Number(todayKey.slice(0, 4)), Number(todayKey.slice(5, 7)) - 1, Number(todayKey.slice(8, 10)), 12
  ).valueOf() - (days - 1) * 86400000);
  const y = sinceDate.getUTCFullYear(), m = sinceDate.getUTCMonth() + 1, d = sinceDate.getUTCDate();
  const sinceKey = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

  const checkins = db.prepare(
    'SELECT date, mood, day_rating FROM checkins WHERE sub_id = ? AND date >= ? ORDER BY date').all(subId, sinceKey);

  // Streak: consecutive days (ending today or yesterday) with a check-in.
  let streak = 0;
  let cursor = todayKey;
  const has = new Set(db.prepare('SELECT date FROM checkins WHERE sub_id = ?').all(subId).map(r => r.date));
  if (!has.has(cursor)) cursor = localShift(todayKey, -1); // allow "not yet checked in today"
  for (;;) {
    if (!has.has(cursor)) break;
    streak++;
    cursor = localShift(cursor, -1);
  }

  // Daily task completion over the window (only daily-frequency tasks are period-comparable day by day).
  const dailyTasks = db.prepare("SELECT id, title FROM tasks WHERE sub_id = ? AND active = 1 AND frequency = 'daily'").all(subId);
  const taskRates = dailyTasks.map(t => {
    const comps = db.prepare(
      'SELECT COUNT(*) c FROM completions WHERE task_id = ? AND period_key >= ?').get(t.id, sinceKey).c;
    return { id: t.id, title: t.title, done: comps, expected: days, pct: Math.round((comps / days) * 100) };
  });

  // Simple totals across every frequency.
  const completionsTotal = db.prepare(
    `SELECT COUNT(*) c FROM completions c JOIN tasks t ON t.id = c.task_id
     WHERE t.sub_id = ? AND c.period_key >= ?`).get(subId, sinceKey).c;
  const missedTotal = db.prepare(
    `SELECT COUNT(*) c FROM missed_alerts a JOIN tasks t ON t.id = a.task_id
     WHERE t.sub_id = ? AND a.period_key >= ?`).get(subId, sinceKey).c;
  const punishmentsDone = db.prepare(
    "SELECT COUNT(*) c FROM punishments WHERE sub_id = ? AND status = 'completed'").get(subId).c;
  const punishmentsOpen = db.prepare(
    "SELECT COUNT(*) c FROM punishments WHERE sub_id = ? AND status = 'open'").get(subId).c;

  const inRange = checkins.length ? checkins : [];
  const avg = (arr, f) => arr.length ? Math.round((arr.reduce((s, r) => s + f(r), 0) / arr.length) * 10) / 10 : null;
  const recent = inRange.slice(-7);
  const avgMood = avg(recent, r => r.mood);
  const avgDay = avg(recent, r => r.day_rating);

  return {
    timezone: subTz,
    range_days: days,
    checkins,
    streak,
    taskRates,
    tiles: {
      avg_mood_7d: avgMood,
      avg_day_7d: avgDay,
      completions_total: completionsTotal,
      missed_total: missedTotal,
      punishments_done: punishmentsDone,
      punishments_open: punishmentsOpen
    }
  };
}

function localShift(key, days) {
  const [y, m, d] = key.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d, 12) + days * 86400000;
  const dt = new Date(t);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

router.get('/me', requireSub, (req, res) => {
  const days = [7, 30, 60].includes(Number((req.query || {}).days)) ? Number(req.query.days) : 30;
  res.json(buildStats(req.user.id, req.user.timezone, days));
});

router.get('/sub/:subId', requireDom, (req, res) => {
  const sub = assertDomOwnsSub(db, req.user.id, req.params.subId);
  const days = [7, 30, 60].includes(Number((req.query || {}).days)) ? Number(req.query.days) : 30;
  res.json(buildStats(sub.id, sub.timezone, days));
});

module.exports = router;