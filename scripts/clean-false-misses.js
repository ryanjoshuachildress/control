/* One-off maintenance: remove "missed deadline" records that the pre-2026-10-04
 * scheduler bug created for periods during which the task not only wasn't
 * completed — it didn't even exist (assigned after the deadline had passed).
 * Auto-punishments assigned in the same instant as such a false alert are
 * cancelled as well. Safe to run more than once — it is idempotent. */
const db = require('../src/db');
const time = require('../src/lib/time');

const tasks = db.prepare(`SELECT t.id, t.created_at, t.frequency, s.timezone AS sub_tz FROM tasks t JOIN users s ON s.id = t.sub_id`).all();
let removedAlerts = 0, cancelledPunishments = 0;

for (const t of tasks) {
  const created = time.parseSqliteTimestamp(t.created_at);
  if (!created) continue;
  const alerts = db.prepare('SELECT id, period_key, sent_at FROM missed_alerts WHERE task_id = ?').all(t.id);
  for (const a of alerts) {
    const deadline = a.period_key.startsWith('due:')
      ? time.dueDateInstant(t.sub_tz, a.period_key.slice(4))
      : time.deadlineInstant(t.sub_tz, t.frequency, a.period_key);
    if (!deadline || created.getTime() < deadline.getTime()) continue; // task existed before the deadline → miss may be real
    for (const p of db.prepare(
      `SELECT id FROM punishments WHERE auto_task_id = ? AND source = 'auto' AND status = 'open'
       AND ABS(strftime('%s', created_at) - strftime('%s', ?)) < 120`).all(t.id, a.sent_at)) {
      db.prepare(`UPDATE punishments SET status = 'cancelled' WHERE id = ?`).run(p.id);
      cancelledPunishments++;
    }
    db.prepare('DELETE FROM missed_alerts WHERE id = ?').run(a.id);
    removedAlerts++;
  }
}
console.log(`clean-false-misses: removed ${removedAlerts} false missed-alerts, cancelled ${cancelledPunishments} auto-punishments created along with them.`);