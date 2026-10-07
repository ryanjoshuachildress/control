const crypto = require('crypto');
const db = require('../db');
const time = require('./time');
const mail = require('./mail');

function fmtPeriod(frequency, key) {
  if (frequency === 'daily') return key;
  if (frequency === 'weekly') return `week ending ${key}`;
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

// Weekly compliance: when a sub's week closes at Sunday midnight, check their
// daily-task completion rate; under the Dom's threshold, auto-assign once.
function checkWeeklyPerformance() {
  const now = new Date();
  const subs = db.prepare(`
    SELECT s.id, s.name, s.timezone AS tz, s.created_at, s.email_notifications AS sub_notify,
           s.weekly_punish_title, s.weekly_punish_pct,
           d.id AS dom_id, d.email AS dom_email, d.email_notifications AS dom_notify
    FROM users s JOIN users d ON d.id = s.dom_id
    WHERE s.dom_id IS NOT NULL
      AND s.weekly_punish_title != ''
      AND s.weekly_punish_pct IS NOT NULL AND s.weekly_punish_pct > 0
  `).all();

  for (const sub of subs) {
    try {
      const sunday = time.previousPeriodKey(now, sub.tz, 'weekly');     // Sunday ending the week just finished
      const deadline = time.deadlineInstant(sub.tz, 'weekly', sunday);  // its close: that Sunday midnight
      if (now < deadline) continue;

      const created = time.parseSqliteTimestamp(sub.created_at);
      if (!created || created.getTime() >= deadline.getTime()) continue;

      // Evaluate once per week.
      if (db.prepare('SELECT id FROM performance_alerts WHERE sub_id = ? AND period_key = ?').get(sub.id, sunday)) continue;

      const sundayKey = sunday;
      const dayKeys = []; // Monday..Sunday of that week
      for (let i = 6; i >= 0; i--) dayKeys.push(time.shiftDateKey(sundayKey, -i));
      const placeholders = dayKeys.map(() => '?').join(',');

      const dailyTasks = db.prepare(
        `SELECT id, created_at FROM tasks WHERE sub_id = ? AND frequency = 'daily' AND active = 1`).all(sub.id);
      const getComp = db.prepare(
        `SELECT COUNT(*) AS n FROM completions WHERE task_id = ? AND period_key IN (${placeholders})`);

      let required = 0, done = 0;
      for (const t of dailyTasks) {
        const createdT = time.parseSqliteTimestamp(t.created_at);
        for (const k of dayKeys) {
          // A day counts as required if the task existed before that day's deadline.
          const dd = time.deadlineInstant(sub.tz, 'daily', k);
          if (!createdT || createdT >= dd) continue;
          required++;
        }
        done += getComp.get(t.id, ...dayKeys).n;
      }
      if (required === 0) continue;

      const pct = Math.round((100 * done) / required);
      if (pct >= sub.weekly_punish_pct) continue;

      const desc = `Daily-task compliance was ${pct}% (${done} of ${required} possible completions) for the week ending ${sundayKey} — under the ${sub.weekly_punish_pct}% threshold.`;
      const punishTitle = String(sub.weekly_punish_title).trim().slice(0, 120);

      db.prepare('INSERT INTO performance_alerts (id, sub_id, period_key) VALUES (?, ?, ?)')
        .run(crypto.randomUUID(), sub.id, sundayKey);

      const punId = crypto.randomUUID();
      db.prepare(`INSERT INTO punishments (id, dom_id, sub_id, title, description, completion_mode, source)
                  VALUES (?, ?, ?, ?, ?, 'checkoff', 'auto')`)
        .run(punId, sub.dom_id, sub.id, punishTitle, desc);

      if (sub.dom_notify) {
        mail.send(sub.dom_email,
          `${sub.name} under ${sub.weekly_punish_pct}% this week — punishment assigned`,
          `<p><strong>${sub.name}</strong> completed only <strong>${pct}%</strong> of daily tasks in the week ending ${sundayKey}
           (${desc.replace('Daily-task compliance was ', 'compliance: ')}). Auto-punishment assigned: <strong>${punishTitle}</strong>.</p>
           ${mail.viewLink(`sub/${sub.id}/punishments?focus=punishment:${punId}`, 'View their punishments')}`);
      }
      if (sub.sub_notify) {
        mail.send(
          (db.prepare('SELECT email FROM users WHERE id = ?').get(sub.id) || {}).email,
          `This week's task compliance was ${pct}% — punishment assigned`,
          `<p>Your daily-task compliance for the week ending ${sundayKey} was <strong>${pct}%</strong>, under your Dominant's required ${sub.weekly_punish_pct}%.
           Punishment to complete within 24 hours: <strong>${punishTitle}</strong>.</p>
           ${mail.viewLink(`today?focus=punishment:${punId}`, 'View the punishment')}`);
      }
    } catch (err) {
      console.error('[scheduler] weekly performance check failed for', sub.id, err);
    }
  }
}

function checkDeadlines() {
  const now = new Date();
  const tasks = db.prepare(`
    SELECT t.id, t.title, t.frequency, t.completion_mode, t.due_date, t.created_at,
           s.id AS sub_id, s.name AS sub_name, s.title AS sub_title, s.email_notifications AS sub_notify,
           d.email AS dom_email, d.id AS dom_id, d.email_notifications AS dom_notify,
           s.timezone AS sub_tz, t.auto_punish_title
    FROM tasks t
    JOIN users s ON s.id = t.sub_id
    JOIN users d ON d.id = t.dom_id
    WHERE t.active = 1
  `).all();

  const getMissed = db.prepare('SELECT id FROM missed_alerts WHERE task_id = ? AND period_key = ?');
  const insertMissed = db.prepare('INSERT INTO missed_alerts (id, task_id, period_key) VALUES (?, ?, ?)');

  for (const t of tasks) {
    try {
      // A due date overrides the recurring frequency cycle entirely:
      // the task has one deadline, end of that day in the sub's local time.
      const key = t.due_date
        ? `due:${t.due_date}`
        : time.previousPeriodKey(now, t.sub_tz, t.frequency);
      const deadline = t.due_date
        ? time.dueDateInstant(t.sub_tz, t.due_date)
        : time.deadlineInstant(t.sub_tz, t.frequency, key);
      if (now < deadline) continue;

      // Never mark a period missed the task didn't exist for — this is what
      // made newly assigned tasks instantly "missed" (e.g. a task created on
      // the 4th flagged for the previous month or week it wasn't around in).
      const created = time.parseSqliteTimestamp(t.created_at);
      if (!created || created.getTime() >= deadline.getTime()) continue;

      const done = db.prepare('SELECT id FROM completions WHERE task_id = ? AND period_key = ?').get(t.id, key);
      if (done) continue;

      // Alert once per missed period (server downtime catch-up included).
      const existing = getMissed.get(t.id, key);
      if (existing) continue;

      // Dedupe key is recorded last so a failure above is retried next cycle.
      const period = t.due_date
        ? `due ${t.due_date} (midnight ${t.sub_tz} time)`
        : fmtPeriod(t.frequency, key);
      const deadlineDesc = t.due_date
        ? `the due-date deadline (${period}).`
        : `the ${t.frequency} deadline (${period}, midnight ${t.sub_tz} time).`;
      const need = t.completion_mode === 'evidence' ? 'photo/video evidence' : 'the task checkbox';

      // Auto-assigned punishment, if the Dom configured one for this task.
      if (t.auto_punish_title && String(t.auto_punish_title).trim()) {
        db.prepare(`INSERT INTO punishments (id, dom_id, sub_id, title, description, completion_mode, source, auto_task_id)
                    VALUES (?, ?, ?, ?, '', 'checkoff', 'auto', ?)`)
          .run(crypto.randomUUID(), t.dom_id, t.sub_id, String(t.auto_punish_title).trim().slice(0, 120), t.id);
      }

      insertMissed.run(crypto.randomUUID(), t.id, key);

      // A one-off (due-date) task is now resolved either way — retire it.
      if (t.due_date) db.prepare('UPDATE tasks SET active = 0 WHERE id = ?').run(t.id);

      if (t.dom_notify) {
        mail.send(
          t.dom_email,
          `${t.sub_name} missed "${t.title}" (${period})`,
          `<p><strong>${t.sub_name}</strong> did not complete <strong>${t.title}</strong> before ${deadlineDesc}
           Required completion: ${need}.
           ${t.auto_punish_title ? `<br>An auto-punishment was assigned for it: <strong>${t.auto_punish_title}</strong>.` : ''}</p>
           ${mail.viewLink(`sub/${t.sub_id}/tasks?focus=task:${t.id}`, 'View their tasks')}`
        );
      }
      if (t.sub_notify) {
        mail.send(
          (db.prepare('SELECT email FROM users WHERE id = ?').get(t.sub_id) || {}).email,
          `You missed "${t.title}" (${period})`,
          `<p>${deadlineDesc.charAt(0).toUpperCase() + deadlineDesc.slice(1)} passed without completion of <strong>${t.title}</strong>. Your Dom has been notified.
           ${t.auto_punish_title ? `<br>Punishment to complete within 24 hours: <strong>${t.auto_punish_title}</strong>.` : ''}
           </p>
           ${mail.viewLink(`today?focus=task:${t.id}`, 'View the task')}`
        );
      }
    } catch (err) {
      console.error('[scheduler] task check failed for', t.id, err);
    }
  }

  checkWeeklyPerformance();
  checkPunishmentLapses();
}

// A punishment left uncompleted 24 hours after assignment notifies the Dom once.
function checkPunishmentLapses() {
  const stale = db.prepare(`
    SELECT p.id, p.title, p.sub_id, s.name AS sub_name, d.email AS dom_email, d.email_notifications AS dom_notify
    FROM punishments p
    JOIN users s ON s.id = p.sub_id
    JOIN users d ON d.id = p.dom_id
    WHERE p.status = 'open' AND p.lapse_notified = 0
      AND p.created_at <= datetime('now', '-24 hours')`).all();
  for (const p of stale) {
    db.prepare('UPDATE punishments SET lapse_notified = 1 WHERE id = ?').run(p.id);
    if (p.dom_notify) {
      mail.send(p.dom_email, `Punishment not completed within 24h: "${p.title}"`,
        `<p><strong>${p.sub_name}</strong>'s punishment <strong>${p.title}</strong> (assigned 24+ hours ago) is still open.</p>
         ${mail.viewLink(`sub/${p.sub_id}/punishments?focus=punishment:${p.id}`, 'View the punishment')}`);
    }
  }
}

function startScheduler() {
  setInterval(checkDeadlines, 60 * 1000).unref();
  setTimeout(checkDeadlines, 10 * 1000).unref();
  console.log('[scheduler] running — checking every 60s for missed task deadlines');
}

module.exports = { startScheduler, checkDeadlines };