const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const time = require('../lib/time');
const mail = require('../lib/mail');
const { requireDom, requireSub, assertDomOwnsSub, attachUser } = require('../lib/auth');
const { upload } = require('../lib/uploads');

const router = express.Router();

router.use(attachUser);

const TASK_FREQS = ['daily', 'weekly', 'monthly'];
const LABEL = { daily: 'Due daily — deadline midnight', weekly: 'Due weekly — deadline Sunday midnight', monthly: 'Due monthly — deadline end of month' };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const esc = s => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const commentCount = db.prepare(
  `SELECT COUNT(*) AS n FROM comments WHERE subject = 'task' AND subject_id = ?`);

// Deadlines in the sub's own time; a due date overrides the recurring cycle.
function deadlineLine(t, tz) {
  return t.due_date
    ? `Deadline: <strong>${esc(t.due_date)}</strong>, end of that day (midnight ${esc(tz)} time${t.frequency ? `; overrides the ${esc(t.frequency)} cycle` : ''}).`
    : `${esc(LABEL[t.frequency])} (midnight ${esc(tz)} time).`;
}

// Notify the sub about a task change: diffs the PATCH updates against the
// pre-update row, and skips mail entirely when nothing actually differs.
function subTaskChangeMail(task, updates) {
  const sub = db.prepare('SELECT email, email_notifications, timezone FROM users WHERE id = ?').get(task.sub_id);
  if (!sub || !sub.email_notifications) return;
  const tz = sub.timezone;
  const changes = [];
  if (updates.title !== undefined && updates.title !== task.title)
    changes.push(`Renamed from “${esc(task.title)}” to “<strong>${esc(updates.title)}</strong>”`);
  if (updates.description !== undefined && String(updates.description) !== (task.description || ''))
    changes.push('Description updated');
  if (updates.due_date !== undefined && (updates.due_date || null) !== (task.due_date || null))
    changes.push(updates.due_date
      ? `Deadline changed to ${esc(updates.due_date)} — end of that day (midnight ${esc(tz)} time)`
      : `Due date removed — deadline is back to ${esc(LABEL[task.frequency])} (midnight ${esc(tz)} time)`);
  if (updates.auto_punish_title !== undefined && String(updates.auto_punish_title) !== (task.auto_punish_title || ''))
    changes.push(updates.auto_punish_title
      ? `A missed deadline will now auto-assign the punishment: <strong>${esc(updates.auto_punish_title)}</strong> (24h to complete)`
      : 'The auto-punishment for a missed deadline was cleared');
  if (updates.active !== undefined)
    changes.push(updates.active
      ? 'The task is active again — its deadline counts as usual'
      : 'The task is paused — its deadline is on hold');
  if (!changes.length) return;

  const current = { ...task, ...updates };
  const domName = (db.prepare('SELECT name FROM users WHERE id = ?').get(task.dom_id) || {}).name || 'Your Dom';
  mail.send(sub.email, `Task changed: ${updates.title || task.title}`,
    `<p><strong>${esc(domName)}</strong> changed the task <strong>${esc(current.title)}</strong>:</p>
     <ul><li>${changes.join('</li><li>')}</li></ul>
     <p>${deadlineLine(current, tz)}${current.active ? '' : ' It is currently paused, so the deadline is on hold.'}</p>
     ${mail.viewLink(`today?focus=task:${task.id}`, 'View the task')}`);
}

function normalizeDueDate(raw) {
  const v = String(raw || '').trim();
  if (!v) return { ok: true, value: null };
  if (!DATE_RE.test(v)) return { ok: false };
  return { ok: true, value: v };
}

// ---------- submissive ----------

router.get('/today', requireSub, (req, res) => {
  const tz = req.user.timezone;
  const now = new Date();
  const tasks = db.prepare('SELECT * FROM tasks WHERE sub_id = ? AND active = 1 ORDER BY created_at').all(req.user.id);
  const getCompletion = db.prepare('SELECT * FROM completions WHERE task_id = ? AND period_key = ?');

  const out = tasks.map(t => {
    const periodKey = t.due_date ? `due:${t.due_date}` : time.currentPeriodKey(now, tz, t.frequency);
    const comp = getCompletion.get(t.id, periodKey);
    return {
      id: t.id,
      title: t.title,
      description: t.description,
      frequency: t.frequency,
      frequency_label: t.due_date ? `Due ${t.due_date} (overrides frequency)` : LABEL[t.frequency],
      due_date: t.due_date || null,
      completion_mode: t.completion_mode,
      period_key: periodKey,
      done: !!comp,
      method: comp && comp.method,
      completed_at: comp && comp.completed_at,
      comment_count: commentCount.get(t.id).n
    };
  });
  res.json({ paired: !!req.user.dom_id, timezone: tz, date: time.currentDateKey(now, tz), tasks: out });
});

router.post('/:id/complete', requireSub, (req, res) => {
  upload.single('evidence')(req, res, (err) => {
    if (err) {
      const msg = /file too large/i.test(err.message) ? 'File too large' : (err.message || 'Upload failed');
      return res.status(400).json({ error: msg });
    }
    try {
      const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND sub_id = ?').get(req.params.id, req.user.id);
      if (!task || !task.active) return res.status(404).json({ error: 'Task not found' });

      const periodKey = task.due_date
        ? `due:${task.due_date}`
        : time.currentPeriodKey(new Date(), req.user.timezone, task.frequency);
      if (db.prepare('SELECT id FROM completions WHERE task_id = ? AND period_key = ?').get(task.id, periodKey)) {
        return res.status(409).json({ error: 'Task already completed for this period' });
      }

      const method = req.file ? 'evidence' : String((req.body || {}).method || '');
      if (method !== task.completion_mode) {
        return res.status(400).json({
          error: task.completion_mode === 'evidence'
            ? 'This task requires photo or video evidence'
            : 'This task is completed with the checkbox'
        });
      }

      const id = crypto.randomUUID();
      db.prepare(`INSERT INTO completions (id, task_id, period_key, method, evidence_path, note)
                  VALUES (?, ?, ?, ?, ?, ?)`)
        .run(id, task.id, periodKey, method, req.file ? req.file.filename : null,
             String((req.body || {}).note || '').slice(0, 500));

      // A due-date task is a one-off: completing it retires the task.
      if (task.due_date) db.prepare('UPDATE tasks SET active = 0 WHERE id = ?').run(task.id);

      const dom = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'dom'").get(task.dom_id);
      if (dom && dom.email_notifications) {
        mail.send(dom.email, `${req.user.name} completed "${task.title}"`,
          `<p><strong>${req.user.name}</strong> completed <strong>${task.title}</strong> (period ${periodKey})${method === 'evidence' ? ' with photo/video evidence' : ''} — view it in their task history.</p>
           ${mail.viewLink(`sub/${task.sub_id}/tasks?focus=task:${task.id}`, 'View the task')}`);
      }
      res.json({ ok: true, task: { id: task.id, done: true, method, completed_at: new Date().toISOString() } });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Failed to complete task' });
    }
  });
});

// ---------- dominant ----------

router.post('/', requireDom, (req, res) => {
  const { sub_id, title, description, frequency, completion_mode, auto_punish_title, due_date } = req.body || {};
  const sub = assertDomOwnsSub(db, req.user.id, String(sub_id || ''));
  const due = normalizeDueDate(due_date);
  if (!due.ok) return res.status(400).json({ error: 'Due date must be YYYY-MM-DD' });
  if (!title || String(title).trim().length === 0) return res.status(400).json({ error: 'Task title is required' });
  if (!TASK_FREQS.includes(frequency)) return res.status(400).json({ error: 'Frequency must be daily, weekly, or monthly' });
  if (!['checkoff', 'evidence'].includes(completion_mode)) return res.status(400).json({ error: 'Completion mode must be checkoff or evidence' });

  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO tasks (id, dom_id, sub_id, title, description, frequency, completion_mode, auto_punish_title, due_date)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, req.user.id, sub.id, String(title).trim().slice(0, 120), String(description || '').slice(0, 1000), frequency, completion_mode,
         String(auto_punish_title || '').trim().slice(0, 120), due.value);

  if (sub.email_notifications) {
    mail.send(sub.email, `New task from your ${req.user.title || 'Dom'}: ${esc(title)}`,
      `<p><strong>${esc(req.user.name)}</strong> assigned you a ${frequency} task: <strong>${esc(String(title).trim().slice(0, 120))}</strong></p>
       <p>${due.value
         ? `Deadline: <strong>${esc(due.value)}</strong>, end of that day (midnight ${esc(sub.timezone)} time). This overrides the frequency deadline.`
         : LABEL[frequency]}${completion_mode === 'evidence' ? ' — photo/video evidence required.' : ' — check it off when done.'}</p>
       ${mail.viewLink(`today?focus=task:${id}`, 'View the task')}`);
  }
  res.json({ ok: true, id });
});

router.patch('/:id', requireDom, (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND dom_id = ?').get(req.params.id, req.user.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const { active, title, description, auto_punish_title, due_date } = req.body || {};
  const updates = {};
  if (active !== undefined) updates.active = active ? 1 : 0;
  if (auto_punish_title !== undefined) updates.auto_punish_title = String(auto_punish_title || '').trim().slice(0, 120);
  if (due_date !== undefined) {
    const due = normalizeDueDate(due_date);
    if (!due.ok) return res.status(400).json({ error: 'Due date must be YYYY-MM-DD (empty clears it)' });
    updates.due_date = due.value;
  }
  if (title !== undefined) {
    if (!String(title).trim()) return res.status(400).json({ error: 'Task title is required' });
    updates.title = String(title).trim().slice(0, 120);
  }
  if (description !== undefined) updates.description = String(description).slice(0, 1000);
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nothing to update' });
  const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE tasks SET ${sets} WHERE id = ?`).run(...Object.values(updates), task.id);
  subTaskChangeMail(task, updates);
  res.json({ ok: true });
});

router.delete('/:id', requireDom, (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND dom_id = ?').get(req.params.id, req.user.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  db.prepare('DELETE FROM completions WHERE task_id = ?').run(task.id);
  db.prepare('DELETE FROM missed_alerts WHERE task_id = ?').run(task.id);
  db.prepare('DELETE FROM comments WHERE subject = \'task\' AND subject_id = ?').run(task.id);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);

  const sub = db.prepare('SELECT email, email_notifications FROM users WHERE id = ?').get(task.sub_id);
  if (sub && sub.email_notifications) {
    mail.send(sub.email, `Task removed: ${task.title}`,
      `<p><strong>${esc(req.user.name)}</strong> removed the task <strong>${esc(task.title)}</strong>
       (was ${task.due_date ? `a one-off due ${esc(task.due_date)}` : esc(LABEL[task.frequency]).toLowerCase()}).
       Nothing is owed for it anymore.</p>
       ${mail.viewLink('today', 'View your tasks')}`);
  }
  res.json({ ok: true });
});

router.get('/dom/sub/:subId', requireDom, (req, res) => {
  const sub = assertDomOwnsSub(db, req.user.id, req.params.subId);
  const now = new Date();
  const tz = sub.timezone;
  const tasks = db.prepare('SELECT * FROM tasks WHERE sub_id = ? ORDER BY active DESC, created_at DESC').all(sub.id);
  const completions = db.prepare(
    `SELECT c.id, c.task_id, c.period_key, c.method, c.evidence_path, c.note, c.completed_at,
            t.title AS task_title, t.frequency
     FROM completions c JOIN tasks t ON t.id = c.task_id
     WHERE t.sub_id = ? ORDER BY c.completed_at DESC LIMIT 50`).all(sub.id);
  const missed = db.prepare(
    `SELECT a.id, a.task_id, a.period_key, a.sent_at, t.title AS task_title, t.frequency
     FROM missed_alerts a JOIN tasks t ON t.id = a.task_id
     WHERE t.sub_id = ? ORDER BY a.sent_at DESC LIMIT 50`).all(sub.id);
  const withStatus = tasks.map(t => {
    const periodKey = t.due_date ? `due:${t.due_date}` : time.currentPeriodKey(now, tz, t.frequency);
    const comp = db.prepare('SELECT * FROM completions WHERE task_id = ? AND period_key = ?').get(t.id, periodKey);
    return { ...t, current_period: periodKey, current_done: !!comp, comment_count: commentCount.get(t.id).n };
  });
  res.json({ sub, tasks: withStatus, completions, missed, labels: LABEL });
});

router.get('/dom/events', requireDom, (req, res) => {
  const completions = db.prepare(
    `SELECT c.id, c.completed_at, c.method, c.period_key, t.title AS task_title, t.frequency,
            s.name AS sub_name, s.id AS sub_id
     FROM completions c JOIN tasks t ON t.id = c.task_id JOIN users s ON s.id = t.sub_id
     WHERE t.dom_id = ? ORDER BY c.completed_at DESC LIMIT 25`).all(req.user.id);
  const missed = db.prepare(
    `SELECT a.id, a.sent_at, a.period_key, t.title AS task_title, t.frequency,
            s.name AS sub_name, s.id AS sub_id
     FROM missed_alerts a JOIN tasks t ON t.id = a.task_id JOIN users s ON s.id = t.sub_id
     WHERE t.dom_id = ? ORDER BY a.sent_at DESC LIMIT 25`).all(req.user.id);
  res.json({ completions, missed });
});

module.exports = router;