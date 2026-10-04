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

function checkDeadlines() {
  const now = new Date();
  const tasks = db.prepare(`
    SELECT t.id, t.title, t.frequency, t.completion_mode,
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
      const prevKey = time.previousPeriodKey(now, t.sub_tz, t.frequency);
      if (!time.isPastDeadline(now, t.sub_tz, t.frequency, prevKey)) continue;

      const done = db.prepare('SELECT id FROM completions WHERE task_id = ? AND period_key = ?').get(t.id, prevKey);
      if (done) continue;

      // Alert once per missed period (server downtime catch-up included).
      const existing = getMissed.get(t.id, prevKey);
      if (existing) continue;

      // Dedupe key is recorded last so a failure above is retried next cycle.
      const period = fmtPeriod(t.frequency, prevKey);
      const need = t.completion_mode === 'evidence' ? 'photo/video evidence' : 'the task checkbox';

      // Auto-assigned punishment, if the Dom configured one for this task.
      if (t.auto_punish_title && String(t.auto_punish_title).trim()) {
        db.prepare(`INSERT INTO punishments (id, dom_id, sub_id, title, description, completion_mode, source, auto_task_id)
                    VALUES (?, ?, ?, ?, '', 'checkoff', 'auto', ?)`)
          .run(crypto.randomUUID(), t.dom_id, t.sub_id, String(t.auto_punish_title).trim().slice(0, 120), t.id);
      }

      insertMissed.run(crypto.randomUUID(), t.id, prevKey);

      if (t.dom_notify) {
        mail.send(
          t.dom_email,
          `${t.sub_name} missed "${t.title}" (${period})`,
          `<p><strong>${t.sub_name}</strong> did not complete <strong>${t.title}</strong> before the ${t.frequency} deadline
           (${period}, midnight ${t.sub_tz} time). Required completion: ${need}.
           ${t.auto_punish_title ? `<br>An auto-punishment was assigned for it: <strong>${t.auto_punish_title}</strong>.` : ''}</p>`
        );
      }
      if (t.sub_notify) {
        mail.send(
          (db.prepare('SELECT email FROM users WHERE id = ?').get(t.sub_id) || {}).email,
          `You missed "${t.title}" (${period})`,
          `<p>The ${period} deadline for <strong>${t.title}</strong> has passed without completion. Your Dom has been notified.
           ${t.auto_punish_title ? `<br>Punishment to complete within 24 hours: <strong>${t.auto_punish_title}</strong>.</p>` : '</p>'}`
        );
      }
    } catch (err) {
      console.error('[scheduler] task check failed for', t.id, err);
    }
  }

  checkPunishmentLapses();
}

// A punishment left uncompleted 24 hours after assignment notifies the Dom once.
function checkPunishmentLapses() {
  const stale = db.prepare(`
    SELECT p.id, p.title, s.name AS sub_name, d.email AS dom_email, d.email_notifications AS dom_notify
    FROM punishments p
    JOIN users s ON s.id = p.sub_id
    JOIN users d ON d.id = p.dom_id
    WHERE p.status = 'open' AND p.lapse_notified = 0
      AND p.created_at <= datetime('now', '-24 hours')`).all();
  for (const p of stale) {
    db.prepare('UPDATE punishments SET lapse_notified = 1 WHERE id = ?').run(p.id);
    if (p.dom_notify) {
      mail.send(p.dom_email, `Punishment not completed within 24h: "${p.title}"`,
        `<p><strong>${p.sub_name}</strong>'s punishment <strong>${p.title}</strong> (assigned 24+ hours ago) is still open.</p>`);
    }
  }
}

function startScheduler() {
  setInterval(checkDeadlines, 60 * 1000).unref();
  setTimeout(checkDeadlines, 10 * 1000).unref();
  console.log('[scheduler] running — checking every 60s for missed task deadlines');
}

module.exports = { startScheduler };