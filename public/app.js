/* Control — frontend (vanilla JS, hash routing) */
'use strict';

const app = document.getElementById('app');

/* ---------- helpers ---------- */
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

let toastTimer = null;
function toast(msg, isErr = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.hidden = false;
  t.className = 'toast' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3800);
}

function fmtDT(s) {
  if (!s) return '';
  const d = new Date(String(s).includes('T') ? s : String(s).replace(' ', 'T') + 'Z');
  if (isNaN(d)) return s;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function fmtDate(s) {
  if (!s) return '';
  const d = new Date(String(s) + 'T12:00:00Z');
  if (isNaN(d)) return s;
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}
const MOOD_WORDS = ['Terrible', 'Rough', 'Low', 'Poor', 'Meh', 'Okay', 'Good', 'Great', 'Lovely', 'Blissful'];

async function api(path, opts = {}) {
  const init = {
    method: opts.method || 'GET',
    headers: {},
    credentials: 'same-origin'
  };
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch('/api' + path, init);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && user) { user = null; location.hash = '#/login'; throw new Error(data.error || 'Signed out'); }
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

/* ---------- constants ---------- */
const DOM_TITLES = ['Sir', 'Master', 'Daddy', 'Madam', 'Mistress', 'Goddess', 'Owner', 'Lord'];
const SUB_TITLES = ['baby girl', 'pet', 'toy', 'slave', 'princess', 'kitten', 'little one', 'good girl'];
const FREQ_LABEL = { daily: 'Daily · due midnight', weekly: 'Weekly · due Sunday midnight', monthly: 'Monthly · due end of month' };

/* ---------- state ---------- */
let user = null;
let tz = 'UTC';
try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { /* keep UTC */ }

/* ---------- router ---------- */
function route() {
  if (!user) {
    api('/auth/me').then(d => { user = d.user; route(); }).catch(() => renderAuth());
    return;
  }
  const parts = (location.hash || '').slice(1).split('/').filter(Boolean);
  const page = parts[0] || (user.role === 'dom' ? 'dash' : 'today');

  if (user.role === 'dom') {
    if (page === 'sub' && parts[1]) return renderDomSub(parts[1], parts[2] || 'tasks');
    if (page === 'journal') return renderDomJournal();
    if (page === 'settings') return renderSettings();
    return renderDash();
  }
  if (user.role === 'sub') {
    if (page === 'about') return renderSubAbout();
    if (page === 'journal') return renderSubJournal();
    if (page === 'stats') return renderStats();
    if (page === 'settings') return renderSettings();
    return renderToday();
  }
}

function go(hash) { location.hash = hash; }

/* ---------- auth screens ---------- */
function titleOptions(role) {
  const list = role === 'dom' ? DOM_TITLES : SUB_TITLES;
  return list.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('') + '<option value="__custom">Other…</option>';
}

function renderAuth() {
  const hash = location.hash || '';
  if (hash === '#/forgot') return renderForgot();
  if (hash.startsWith('#/reset/')) return renderReset(hash.slice('#/reset/'.length));
  const isRegister = hash === '#/register';
  if (isRegister) {
    app.innerHTML = `
    <div class="auth-wrap">
      <div class="card">
        <div class="auth-brand">Control</div>
        <div class="auth-sub">Create your account</div>
        <form data-form="register">
          <div class="role-pick" id="rolePick">
            <label data-role="dom">Dominant<input type="radio" name="role" value="dom" checked></label>
            <label data-role="sub">submissive<input type="radio" name="role" value="sub"></label>
          </div>
          <label class="f"><span>Title</span>
            <select name="title" id="titleSelect">${titleOptions('dom')}</select>
          </label>
          <label class="f" id="customTitleWrap" hidden><span>Custom title</span><input type="text" name="customTitle" maxlength="60"></label>
          <label class="f"><span>Display name</span><input type="text" name="name" required maxlength="80" placeholder="How you are addressed"></label>
          <label class="f"><span>Email</span><input type="email" name="email" required></label>
          <label class="f"><span>Password <span class="tiny">(8+ characters)</span></span><input type="password" name="password" required minlength="8"></label>
          <label class="f" id="inviteWrap" hidden><span>Dom's invite code <span class="tiny">(pair later in Settings instead)</span></span>
            <input type="text" name="inviteCode" placeholder="CTRL-…"></label>
          <button class="primary" style="width:100%" type="submit">Create account</button>
        </form>
        <div class="auth-alt">Already have an account? <a href="#/login">Sign in</a></div>
      </div>
    </div>`;

    const rolePick = document.getElementById('rolePick');
    const syncRole = () => {
      const role = rolePick.querySelector('input:checked').value;
      rolePick.querySelectorAll('label').forEach(l => l.classList.toggle('on', l.dataset.role === role));
      document.getElementById('titleSelect').innerHTML = titleOptions(role);
      document.getElementById('customTitleWrap').hidden = true;
      const inviteWrap = document.getElementById('inviteWrap');
      inviteWrap.hidden = role !== 'sub';
    };
    rolePick.addEventListener('change', syncRole);
    document.getElementById('titleSelect').addEventListener('change', (e) => {
      document.getElementById('customTitleWrap').hidden = e.target.value !== '__custom';
    });
    syncRole();
    return;
  }

  app.innerHTML = `
  <div class="auth-wrap">
    <div class="card">
      <div class="auth-brand">Control</div>
      <div class="auth-sub">A private place to guide and grow your dynamic</div>
      <form data-form="login">
        <label class="f"><span>Email</span><input type="email" name="email" required></label>
        <label class="f"><span>Password</span><input type="password" name="password" required></label>
        <button class="primary" style="width:100%" type="submit">Sign in</button>
      </form>
      <div class="auth-alt">New here? <a href="#/register">Create an account</a> · <a href="#/forgot">Forgot password?</a></div>
    </div>
  </div>`;
}

function renderForgot() {
  app.innerHTML = `
  <div class="auth-wrap">
    <div class="card">
      <div class="auth-brand">Control</div>
      <div class="auth-sub">Reset your password</div>
      <form data-form="forgot">
        <label class="f"><span>Email</span><input type="email" name="email" required></label>
        <button class="primary" style="width:100%" type="submit">Send reset link</button>
      </form>
      <div class="auth-alt">Remembered it? <a href="#/login">Sign in</a></div>
    </div>
  </div>`;
}

function renderReset(token) {
  if (!token) { go('#/login'); return renderAuth(); }
  app.innerHTML = `
  <div class="auth-wrap">
    <div class="card">
      <div class="auth-brand">Control</div>
      <div class="auth-sub">Choose a new password</div>
      <form data-form="reset" data-token="${esc(token)}">
        <label class="f"><span>New password <span class="tiny">(8+ characters)</span></span>
          <input type="password" name="password" required minlength="8"></label>
        <label class="f"><span>Confirm new password</span>
          <input type="password" name="confirm" required minlength="8"></label>
        <button class="primary" style="width:100%" type="submit">Set new password</button>
      </form>
    </div>
  </div>`;
}

/* ---------- shell ---------- */
const TABS = {
  dom: [['#/dash', 'Dashboard'], ['#/journal', 'My journal'], ['#/settings', 'Settings']],
  sub: [['#/today', 'Today'], ['#/journal', 'Journal'], ['#/about', 'About me'], ['#/stats', 'Stats'], ['#/settings', 'Settings']]
};

function shell(active, inner) {
  const tabs = TABS[user.role].map(([href, label]) =>
    `<a href="${href}" class="${active === href ? 'on' : ''}">${esc(label)}</a>`).join('');
  const who = user.title ? esc(user.title) : esc(user.name);
  app.innerHTML = `
  <header class="topbar"><div class="wrap">
    <a class="brand" href="#/">Control</a>
    <nav class="tabs">${tabs}</nav>
    <div class="whoami"><b>${who}</b><button class="small ghost" data-action="logout">Log out</button></div>
  </div></header>
  <main class="wrap">${inner}</main>`;
}

/* ---------- sub: today ---------- */
async function renderToday() {
  let data = { paired: false, tasks: [], date: '' };
  let checkin = null;
  let pun = { open: [], recent: [] };
  try {
    [data, checkin] = await Promise.all([api('/tasks/today'), api('/checkins/today')]);
    if (data.paired) pun = await api('/punishments/mine');
  } catch (e) { return shell('#/today', `<div class="empty">${esc(e.message)}</div>`); }

  const pending = data.tasks.filter(t => !t.done);
  const done = data.tasks.filter(t => t.done);

  const taskCard = (t) => `
    <div class="item" data-task="${esc(t.id)}">
      <div class="spread">
        <div><div class="title">${esc(t.title)}</div>
          ${t.description ? `<div class="muted">${esc(t.description)}</div>` : ''}</div>
        <span class="chip">${t.due_date ? `Due ${esc(fmtDate(t.due_date))}` : esc(FREQ_LABEL[t.frequency] || t.frequency)}</span>
      </div>
      <div class="row" style="margin-top:12px">
        ${t.done
          ? `<span class="done-badge">✓ Completed</span>
             <span class="tiny">${esc(t.method === 'evidence' ? 'with evidence' : 'checked off')}${t.completed_at ? ' · ' + esc(fmtDT(t.completed_at)) : ''}</span>`
          : (t.completion_mode === 'checkoff'
              ? `<button class="primary small" data-action="checkoff" data-task="${esc(t.id)}">Mark complete</button>`
              : `<form data-form="evidence" data-task="${esc(t.id)}" class="row" style="align-items:flex-start;gap:14px">
                   <label class="f fileinput" style="margin:0;flex:1;min-width:210px"><span>Photo / video evidence</span><input type="file" name="evidence" accept="image/*,video/*" required></label>
                   <label class="f" style="margin:0;flex:1;min-width:180px"><span>Note (optional)</span><input type="text" name="note" maxlength="500"></label>
                   <button class="primary small" type="submit" style="margin-top:22px">Submit evidence</button>
                 </form>`)}
      </div>
      ${commentsBlock('task', t.id, t.comment_count)}
    </div>`;

  const checkinHtml = `
    <div class="card" id="checkinCard">
      <h2>Daily check-in</h2>
      <p class="hint">${esc(fmtDate(checkin.date || data.date))}${checkin.checkin ? ' — already submitted; you can update it' : ''}</p>
      <form data-form="checkin">
        <label class="f"><span>How is your mood today?</span>
          <input type="range" name="mood" min="1" max="10" value="${(checkin.checkin && checkin.checkin.mood) || 5}" data-outlabel="1">
          <div class="scale-out" id="moodOut"></div>
          <div class="scale-vals"><span>1 Terrible</span><span>10 Blissful</span></div>
        </label>
        <label class="f"><span>Rate your day</span>
          <input type="range" name="day_rating" min="1" max="10" value="${(checkin.checkin && checkin.checkin.day_rating) || 5}" data-outlabel="ratingOut">
          <div class="scale-out" id="ratingOut"></div>
          <div class="scale-vals"><span>1 Rough</span><span>10 Wonderful</span></div>
        </label>
        <label class="f"><span>Best part of your day</span><textarea name="best_part" maxlength="2000">${esc((checkin.checkin && checkin.checkin.best_part) || '')}</textarea></label>
        <label class="f"><span>Worst part of your day</span><textarea name="worst_part" maxlength="2000">${esc((checkin.checkin && checkin.checkin.worst_part) || '')}</textarea></label>
        <label class="f"><span>Something sexual you thought about or did today</span><textarea name="sexual_notes" maxlength="4000">${esc((checkin.checkin && checkin.checkin.sexual_notes) || '')}</textarea></label>
        <button class="primary" type="submit">${checkin.checkin ? 'Update check-in' : 'Submit check-in'}</button>
      </form>
      ${checkin.checkin ? commentsBlock('checkin', checkin.checkin.id, checkin.checkin.comment_count) : ''}
    </div>`;

  const punishCard = (p) => `
    <div class="item">
      <div class="spread">
        <div><div class="title">${esc(p.title)}</div>
          ${p.description ? `<div class="muted">${esc(p.description)}</div>` : ''}
          <div class="tiny">Due within 24 hours of assignment${p.auto_task_id ? ' · auto-assigned for a missed task' : ''}</div></div>
        <span class="chip bad">punishment</span>
      </div>
      <div class="row" style="margin-top:12px">
        ${p.completion_mode === 'checkoff'
          ? `<button class="primary small" data-action="punish-checkoff" data-id="${esc(p.id)}">Mark complete</button>`
          : `<form data-form="punish-evidence" data-id="${esc(p.id)}" class="row" style="align-items:flex-start;gap:14px">
               <label class="f fileinput" style="margin:0;flex:1;min-width:210px"><span>Photo / video evidence</span><input type="file" name="evidence" accept="image/*,video/*" required></label>
               <label class="f" style="margin:0;flex:1;min-width:180px"><span>Note (optional)</span><input type="text" name="note" maxlength="500"></label>
               <button class="primary small" type="submit" style="margin-top:22px">Submit evidence</button>
             </form>`}
      </div>
      ${commentsBlock('punishment', p.id, p.comment_count)}
    </div>`;

  shell('#/today', `
    ${!data.paired ? `
      <div class="card"><h2>Pair with your Dominant</h2>
        <p class="hint">Enter the invite code they gave you (or do it later in Settings).</p>
        <form data-form="pair" class="row">
          <input type="text" name="code" placeholder="CTRL-…" style="max-width:240px" required>
          <button class="primary" type="submit">Pair</button>
        </form>
      </div>` : ''}
    ${pun.open.length ? `
    <div class="card punish-card"><h2>Punishments</h2>
      <p class="hint">Open punishments from your Dominant — complete these first.</p>
      ${pun.open.map(punishCard).join('')}
      ${pun.recent.length ? `<div class="tiny" style="margin-top:10px">Recently closed: ${pun.recent.slice(0, 3).map(r => `${esc(r.title)} (${r.status})`).join(' · ')}</div>` : ''}
    </div>` : ''}
    <div class="card"><h2>Tasks</h2>
      <p class="hint">${data.tasks.length ? '' : 'No tasks assigned yet.'}</p>
      ${pending.map(taskCard).join('')}
      ${done.length ? `<div style="margin-top:18px"><div class="muted" style="margin-bottom:8px">Completed today</div>${done.map(taskCard).join('')}</div>` : ''}
    </div>
    ${checkinHtml}
  `);
  updateScales();
}

function updateScales() {
  app.querySelectorAll('input[type="range"][data-outlabel]').forEach(r => {
    const out = document.getElementById(r.dataset.outlabel);
    if (out) out.textContent = `${r.value} · ${MOOD_WORDS[r.value - 1]}`;
  });
}

/* ---------- sub: journal ---------- */
async function renderSubJournal() {
  let promptsData, mine, fromDom;
  try {
    [promptsData, mine, fromDom] = await Promise.all([
      api('/prompts'), api('/entries'), api('/entries/from-dom')
    ]);
  } catch (e) { return shell('#/journal', `<div class="empty">${esc(e.message)}</div>`); }

  const daily = promptsData.prompts.filter(p => p.kind === 'daily');
  const weekly = promptsData.prompts.filter(p => p.kind === 'weekly');

  const promptCard = (p) => `
    <div class="item">
      <div class="spread"><div class="title">${esc(p.text)}</div><span class="chip acc">${esc(p.kind)}</span></div>
      <form data-form="entry" data-prompt="${esc(p.id)}" style="margin-top:12px">
        <label class="f"><textarea name="body" maxlength="8000" placeholder="Write your entry…" required></textarea></label>
        <button class="primary small" type="submit">Save entry</button>
      </form>
    </div>`;

  const entryCard = (e) => `
    <div class="item">
      ${e.prompt_text ? `<div class="muted">Prompt: ${esc(e.prompt_text)}</div>` : ''}
      <div class="entry-body">${esc(e.body)}</div>
      <div class="entry-meta">${esc(fmtDT(e.created_at))}</div>
      ${commentsBlock('entry', e.id, e.comment_count)}
    </div>`;

  shell('#/journal', `
    ${!promptsData.dom ? `
      <div class="card"><h2>Journal</h2><p class="hint">Pair with a Dominant to receive daily and weekly journal prompts.</p></div>` : ''}
    ${daily.length ? `<div class="card"><h2>Today's prompts</h2>${daily.map(promptCard).join('')}</div>` : ''}
    ${weekly.length ? `<div class="card"><h2>This week's prompts</h2>${weekly.map(promptCard).join('')}</div>` : ''}
    ${fromDom.entries.length ? `<div class="card"><h2>From your Dominant</h2>${fromDom.entries.map(entryCard).join('')}</div>` : ''}
    <div class="card"><h2>My entries</h2>
      <form data-form="entry" style="margin-bottom:16px">
        <label class="f"><textarea name="body" maxlength="8000" placeholder="Free-write — anything on your mind…" required></textarea></label>
        <button class="primary small" type="submit">Save entry</button>
      </form>
      ${mine.entries.length ? mine.entries.map(entryCard).join('') : '<div class="empty">No entries yet.</div>'}
    </div>`);
}

/* ---------- sub: about me (read-only, Dom-controlled) ---------- */
async function renderSubAbout() {
  let d;
  try { d = await api('/profile/mine'); }
  catch (e) { return shell('#/about', `<div class="empty">${esc(e.message)}</div>`); }

  const row = (f) => `
    <div class="item" style="${f.multiline ? '' : ''}">
      <div class="tiny">${esc(f.label)}</div>
      <div class="entry-body" style="margin-top:2px">${f.value ? esc(f.value) : '<span class="tiny">—</span>'}</div>
    </div>`;

  shell('#/about', `
    <div class="card"><h2>About me</h2>
      <p class="hint">${d.dom
        ? `Your ${esc(d.dom.title || 'Dominant')} keeps this information — only they can edit it, and only what they have chosen to show you appears here.`
        : 'Pair with a Dominant to see this page.'}
      </p>
      ${d.fields.length ? d.fields.map(row).join('') : '<div class="empty">Nothing shared with you yet.</div>'}
    </div>`);
}

/* ---------- comment threads (journals & tasks) ---------- */
const commentsBlock = (subject, id, count) => `
  <div class="comments" data-comment-subject="${esc(subject)}" data-comment-id="${esc(id)}">
    <button class="small ghost" data-action="toggle-comments">💬 Comments${count ? ` · ${count}` : ''}</button>
    <div class="comment-list" hidden></div>
    <form data-form="comment" class="comment-form" hidden>
      <label class="f" style="margin:10px 0"><textarea name="body" maxlength="2000" required placeholder="Write a comment…"></textarea></label>
      <button class="primary small" type="submit">Post comment</button>
    </form>
  </div>`;

async function loadComments(box) {
  const list = box.querySelector('.comment-list');
  list.innerHTML = '<div class="tiny" style="padding:4px 6px">Loading…</div>';
  try {
    const d = await api(`/comments/${box.dataset.commentSubject}/${box.dataset.commentId}`);
    list.innerHTML = d.comments.length ? d.comments.map(c => `
      <div class="comment">
        <div class="comment-head"><b>${esc(c.author_name)}</b>${c.author_title ? `<span>· ${esc(c.author_title)}</span>` : ''}
          <span>${esc(fmtDT(c.created_at))}</span>
          ${c.can_delete ? `<button class="small ghost comment-del" data-action="del-comment" data-comment="${esc(c.id)}">delete</button>` : ''}
        </div>
        <div class="comment-body">${esc(c.body)}</div>
      </div>`).join('')
      : '<div class="empty" style="padding:8px">No comments yet.</div>';
  } catch (e) { list.innerHTML = `<div class="tiny" style="padding:4px 6px">${esc(e.message)}</div>`; }
}

/* ---------- stats & charts ---------- */

// Palette validated (dataviz) against the app's dark surface #1d1d29.
const VIZ = {
  s1: '#3987e5',     // Mood (categorical slot 1, dark)
  s2: '#d95926',     // Rate your day (categorical slot 2, dark)
  track: 'rgba(57,135,229,.16)',
  grid: '#2c2c2a',
  axis: '#383835',
  muted: '#898781'
};
const VIZ_NAMES = { s1: 'Mood', s2: 'Day rating' };

async function renderStats() {
  statsCtx = { subId: null };
  let s;
  try { s = await api('/stats/me'); } catch (e) { return shell('#/stats', `<div class="empty">${esc(e.message)}</div>`); }
  shell('#/stats', statsBody(s));
  bindViz();
}

let vizCurrent = null;
let statsCtx = null; // null = own sub stats; set to {subId} for the Dom's sub-detail stats tab

function statsBody(s) {
  const rangeRow = `
    <div class="filter-row">
      <label class="f" style="margin:0"><span>Time range</span>
        <select data-formid="statsRange" id="statsRange">
          <option value="7"${s.range_days === 7 ? ' selected' : ''}>Last 7 days</option>
          <option value="30"${s.range_days === 30 ? ' selected' : ''}>Last 30 days</option>
          <option value="60"${s.range_days === 60 ? ' selected' : ''}>Last 60 days</option>
        </select></label>
    </div>`;

  const t = s.tiles;
  const tiles = `
    <div class="tiles">
      ${tile('Check-in streak', s.streak === 1 ? '1 day' : `${s.streak} days`)}
      ${tile('Avg mood · 7d', t.avg_mood_7d == null ? '—' : `${t.avg_mood_7d}/10`)}
      ${tile('Avg day rating · 7d', t.avg_day_7d == null ? '—' : `${t.avg_day_7d}/10`)}
      ${tile('Punishments', t.punishments_open ? `${t.punishments_open} open` : `${t.punishments_done} completed`)}
    </div>`;

  const lineVizObj = s.checkins.length >= 2 ? vizLine(s.checkins) : null;
  vizCurrent = lineVizObj;
  const barViz = `
    <div class="card"><h2>Daily task completion · % of days in range</h2>
      <p class="hint">Only daily-frequency tasks count day by day. ${s.taskRates.length ? '' : 'No daily tasks yet.'}</p>
      ${s.taskRates.map(taskRateRow).join('')}
    </div>`;

  const table = `
    <details class="viz-table">
      <summary>View check-in data as a table</summary>
      <table class="plain">
        <thead><tr><th>Date</th><th>Mood</th><th>Day rating</th></tr></thead>
        <tbody>${[...s.checkins].reverse().map(c => `<tr><td>${esc(c.date)}</td><td>${c.mood}/10</td><td>${c.day_rating}/10</td></tr>`).join('')}</tbody>
      </table>
    </details>`;

  return `
    ${rangeRow}
    ${tiles}
    <div class="chart-zone">
      <div class="card"><h2>Mood &amp; day rating · last ${s.range_days} days</h2>
        ${lineVizObj ? `<div class="viz">${lineVizObj.svg}
          <div class="viz-tip" hidden></div></div>
          <div class="viz-legend"><span class="lkey s1"></span>${esc(VIZ_NAMES.s1)}<span class="lkey s2"></span>${esc(VIZ_NAMES.s2)}</div>`
        : '<div class="empty">Need at least two check-ins to draw the chart.</div>'}
      </div>
      ${barViz}
    </div>
    ${table}`;
}

const tile = (label, value) =>
  `<div class="tile"><div class="tile-label">${esc(label)}</div><div class="tile-value">${esc(value)}</div></div>`;

const taskRateRow = (r) => `
  <div class="hbar">
    <div class="hbar-label">${esc(r.title)}</div>
    <div class="hbar-track"><div class="hbar-fill" style="width:${Math.max(0, Math.min(100, r.pct))}%"></div></div>
    <div class="hbar-val">${r.done} day${r.done === 1 ? '' : 's'} · ${r.pct}%</div>
  </div>`;

function vizLine(checkins) {
  const n = checkins.length;
  const W = 640, H = 260, L = 38, R = 52, T = 16, B = 30;
  const pw = W - L - R, ph = H - T - B;
  const x = (i) => L + (n === 1 ? pw / 2 : (i / (n - 1)) * pw);
  const y = (v) => T + (10 - v) / 9 * ph;

  const path = (f) => checkins.map((c, i) => `${x(i).toFixed(1)},${y(f(c)).toFixed(1)}`).join(' ');
  const grid = [2, 4, 6, 8, 10].map(v =>
    `<line x1="${L}" y1="${y(v)}" x2="${W - R}" y2="${y(v)}" stroke="${VIZ.grid}" stroke-width="1"/>`).join('');
  const ticks = [2, 4, 6, 8, 10].map(v =>
    `<text x="${L - 8}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="${VIZ.muted}">${v}</text>`).join('');
  // date ticks: first / middle / last
  const xt = (i, anchor) =>
    `<text x="${x(i)}" y="${H - 8}" text-anchor="${anchor}" font-size="11" fill="${VIZ.muted}">${esc(fmtDateShort(checkins[i].date))}</text>`;
  const dateTicks = n >= 2 ? xt(0, 'start') + xt(Math.floor((n - 1) / 2), 'middle') + xt(n - 1, 'end') : '';

  // last-point markers with a surface ring, plus sparse end labels (nudged apart if colliding)
  const last = checkins[n - 1], prev = checkins[n - 2];
  let ly1 = y(last.mood), ly2 = y(last.day_rating);
  if (Math.abs(ly1 - ly2) < 14) { const mid = (ly1 + ly2) / 2; ly1 = mid - 8; ly2 = mid + 8; }
  const endLabels =
    `<text x="${W - R + 7}" y="${ly1 + 4}" font-size="11" fill="var(--text-dim)">${last.mood}</text>
     <text x="${W - R + 7}" y="${ly2 + 4}" font-size="11" fill="var(--text-dim)">${last.day_rating}</text>`;
  const markers = n >= 2 ? `
    <circle cx="${x(n - 1)}" cy="${y(last.mood)}" r="4" fill="${VIZ.s1}" stroke="var(--bg-card)" stroke-width="2"/>
    <circle cx="${x(n - 1)}" cy="${y(last.day_rating)}" r="4" fill="${VIZ.s2}" stroke="var(--bg-card)" stroke-width="2"/>
    <circle cx="${x(n - 2)}" cy="${y(prev.mood)}" r="4" fill="${VIZ.s1}" stroke="var(--bg-card)" stroke-width="2"/>
    <circle cx="${x(n - 2)}" cy="${y(prev.day_rating)}" r="4" fill="${VIZ.s2}" stroke="var(--bg-card)" stroke-width="2"/>` : '';

  const svg = `<svg viewBox="0 0 ${W} ${H}" data-viz="1" style="width:100%;height:auto;display:block">
    ${grid}
    <line x1="${L}" y1="${y(1)}" x2="${W - R}" y2="${y(1)}" stroke="${VIZ.axis}" stroke-width="1"/>
    ${ticks}${dateTicks}
    <polyline points="${path(c => c.mood)}" fill="none" stroke="${VIZ.s1}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <polyline points="${path(c => c.day_rating)}" fill="none" stroke="${VIZ.s2}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${markers}${endLabels}
    <line class="xhair" x1="0" y1="${T}" x2="0" y2="${H - B}" stroke="${VIZ.axis}" stroke-width="1" visibility="hidden"/>
  </svg>`;
  return { svg, data: checkins, x, y, L, pw };
}

function fmtDateShort(key) {
  const parts = key.split('-');
  return `${parts[1]}/${parts[2]}`;
}

// Hover crosshair + one tooltip listing every series at the snapped X (dataviz spec).
function bindViz() {
  const viz = app.querySelector('.viz');
  if (!viz || !vizCurrent) return;
  const svg = viz.querySelector('svg');
  const tip = viz.querySelector('.viz-tip');
  const xhair = svg && svg.querySelector('.xhair');
  if (!svg || !tip || !xhair) return;
  const data = vizCurrent.data;

  svg.addEventListener('pointermove', (e) => {
    if (!data || data.length < 2) return;
    const rect = svg.getBoundingClientRect();
    const vx = (e.clientX - rect.left) * (VIZ_GEO.W / rect.width);
    let best = 0, bd = Infinity;
    for (let i = 0; i < data.length; i++) {
      const d = Math.abs(vizCurrent.x(i) - vx);
      if (d < bd) { bd = d; best = i; }
    }
    const px = vizCurrent.x(best);
    xhair.setAttribute('x1', px); xhair.setAttribute('x2', px);
    xhair.setAttribute('visibility', 'visible');

    // Tooltip built with textContent — labels are user data (dataviz: never innerHTML it).
    tip.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'viz-tip-date';
    head.textContent = data[best].date;
    tip.appendChild(head);
    [['s1', data[best].mood], ['s2', data[best].day_rating]].forEach(([k, v]) => {
      const rowv = document.createElement('div'); rowv.className = 'viz-tip-row';
      const key = document.createElement('span'); key.className = 'lkey ' + k;
      const val = document.createElement('b'); val.textContent = v;
      const name = document.createElement('span'); name.textContent = VIZ_NAMES[k];
      rowv.append(key, val, name);
      tip.appendChild(rowv);
    });
    tip.hidden = false;
    const vr = viz.getBoundingClientRect(), tr = tip.getBoundingClientRect();
    let left = (px / VIZ_GEO.W) * vr.width + 14;
    if (left + tr.width > vr.width - 8) left = (px / VIZ_GEO.W) * vr.width - tr.width - 14;
    tip.style.left = Math.max(4, left) + 'px';
    tip.style.top = '14px';
  });
  svg.addEventListener('pointerleave', () => { tip.hidden = true; xhair.setAttribute('visibility', 'hidden'); });
}

/* ---------- dom: dashboard ---------- */
async function renderDash() {
  let pair, events;
  try { [pair, events] = await Promise.all([api('/pair'), api('/tasks/dom/events')]); }
  catch (e) { return shell('#/dash', `<div class="empty">${esc(e.message)}</div>`); }

  const subCard = (s) => `
    <a class="sub-card" href="#/sub/${esc(s.id)}/tasks">
      <div class="name">${esc(s.name)}</div>
      <div class="muted">${esc(s.title || '—')} · ${esc(s.timezone)}</div>
    </a>`;

  const eventRow = (c) => `
    <tr><td>${esc(c.completed_at ? fmtDT(c.completed_at) : '')}</td>
        <td><a href="#/sub/${esc(c.sub_id)}/tasks">${esc(c.sub_name)}</a></td>
        <td><span class="chip good">completed</span> ${esc(c.task_title)} <span class="tiny">(${esc(c.period_key)})</span></td></tr>`;
  const missedRow = (m) => `
    <tr><td>${esc(m.sent_at ? fmtDT(m.sent_at) : '')}</td>
        <td><a href="#/sub/${esc(m.sub_id)}/tasks">${esc(m.sub_name)}</a></td>
        <td><span class="chip bad">missed</span> ${esc(m.task_title)} <span class="tiny">(${esc(m.period_key)})</span></td></tr>`;

  shell('#/dash', `
    <div class="card"><h2>Invite code</h2>
      <p class="hint">Share this with a submissive — they enter it at registration or in Settings to pair with you.</p>
      <div class="code-box"><code id="inviteCode">${esc(pair.invite_code || '—')}</code>
        <button class="small" data-action="copy-code">Copy</button></div>
    </div>
    <div class="card"><h2>My submissives</h2>
      ${pair.subs.length ? `<div class="subs-grid">${pair.subs.map(subCard).join('')}</div>` : '<div class="empty">No submissives paired yet.</div>'}
    </div>
    <div class="grid2">
      <div class="card"><h2>Recent completions</h2>
        ${events.completions.length ? `<table class="plain"><tbody>${events.completions.map(eventRow).join('')}</tbody></table>` : '<div class="empty">Nothing yet.</div>'}
      </div>
      <div class="card"><h2>Missed deadlines</h2>
        ${events.missed.length ? `<table class="plain"><tbody>${events.missed.map(missedRow).join('')}</tbody></table>` : '<div class="empty">Nothing yet — good.</div>'}
      </div>
    </div>`);
}

/* ---------- dom: sub detail ---------- */
async function renderDomSub(subId, tab) {
  let d;
  try { d = await api(`/tasks/dom/sub/${subId}`); }
  catch (e) { return shell('#/dash', `<div class="empty">${esc(e.message)}</div>`); }

  const tabs = [
    ['tasks', 'Tasks'], ['punishments', 'Punishments'], ['checkins', 'Check-ins'], ['stats', 'Stats'], ['journal', 'Journal'], ['profile', 'About']
  ].map(([k, l]) => `<a href="#/sub/${esc(subId)}/${k}" class="${tab === k ? 'on' : ''}">${l}</a>`).join('');
  statsCtx = tab === 'stats' ? { subId } : null;

  let inner = '';

  if (tab === 'tasks') {
    const taskRow = (t) => `
      <div class="item" style="${t.active ? '' : 'opacity:.55'}">
        <div class="spread">
          <div><div class="title">${esc(t.title)}</div>
            ${t.description ? `<div class="muted">${esc(t.description)}</div>` : ''}
            <div class="tiny">${t.due_date
              ? `One-off — due <span class="pun-text">${esc(fmtDate(t.due_date))}</span> (end of day) · needs ${esc(t.completion_mode === 'evidence' ? 'photo/video evidence' : 'checkbox')}`
              : `${esc(FREQ_LABEL[t.frequency] || t.frequency)} · needs ${esc(t.completion_mode === 'evidence' ? 'photo/video evidence' : 'checkbox')}`}
              ${t.auto_punish_title ? ` · auto-punish on miss: <span class="pun-text">${esc(t.auto_punish_title)}</span>` : ''}</div>
          </div>
          <div class="row">
            ${t.current_done
              ? (t.due_date ? '<span class="chip good">done ✓</span>' : '<span class="chip good">this period ✓</span>')
              : (t.active ? (t.due_date ? '<span class="chip acc">due date open</span>' : '<span class="chip acc">this period open</span>') : '<span class="chip">inactive</span>')}
            <button class="small" data-action="toggle-task" data-id="${esc(t.id)}" data-active="${t.active}">${t.active ? 'Pause' : 'Resume'}</button>
            <button class="small danger" data-action="del-task" data-id="${esc(t.id)}">Delete</button>
          </div>
        </div>
      </div>
      ${commentsBlock('task', t.id, t.comment_count)}
    </div>`;

    const compRow = (c) => `
      <tr><td>${esc(fmtDT(c.completed_at))}</td><td>${esc(c.task_title)}</td><td>${esc(c.period_key)}</td>
          <td class="evid-links">${c.method === 'evidence'
            ? (c.evidence_path ? `<a href="/uploads/${esc(c.evidence_path)}" target="_blank">view</a>` : '<span class="tiny">evidence missing</span>')
            : '<span class="tiny">checked off</span>'}${c.note ? ` <span class="tiny">“${esc(c.note)}”</span>` : ''}</td></tr>`;
    const missedRow = (m) => `
      <tr><td>${esc(fmtDT(m.sent_at))}</td><td>${esc(m.task_title)}</td><td>${esc(m.period_key)}</td></tr>`;

    inner = `
      <div class="card"><h2>Assign new task</h2>
        <form data-form="assign" data-sub="${esc(subId)}">
          <label class="f"><span>Task</span><input type="text" name="title" required maxlength="120" placeholder="e.g. Write in journal every evening"></label>
          <label class="f"><span>Details (optional)</span><textarea name="description" maxlength="1000"></textarea></label>
          <div class="row">
            <label class="f" style="flex:1;min-width:150px"><span>Frequency</span>
              <select name="frequency"><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></label>
            <label class="f" style="flex:1;min-width:150px"><span>Completed by</span>
              <select name="completion_mode"><option value="checkoff">Checking it off</option><option value="evidence">Photo / video evidence</option></select></label>
            <label class="f" style="flex:1;min-width:160px"><span>Due date <span class="tiny">(optional)</span></span>
              <input type="date" name="due_date"></label>
          </div>
          <label class="f"><span>Auto-punishment on missed deadline <span class="tiny">(optional — assigned automatically, due in 24h)</span></span>
            <input type="text" name="auto_punish_title" maxlength="120" placeholder="e.g. No dessert, early bedtime, corner time"></label>
          <div class="tiny" style="margin:-6px 0 12px">Daily tasks close at midnight ${esc(d.sub.timezone)}; weekly at Sunday midnight; monthly at the end of the month. An optional due date overrides all of that — the task closes at the end of that day (midnight ${esc(d.sub.timezone)} time), once.</div>
          <button class="primary" type="submit">Assign task</button>
        </form>
      </div>
      <div class="card"><h2>Tasks</h2>
        ${d.tasks.length ? d.tasks.map(taskRow).join('') : '<div class="empty">No tasks assigned yet.</div>'}
      </div>
      <div class="grid2">
        <div class="card"><h2>Recent completions</h2>
          ${d.completions.length ? `<table class="plain"><tbody>${d.completions.map(compRow).join('')}</tbody></table>` : '<div class="empty">Nothing yet.</div>'}
        </div>
        <div class="card"><h2>Missed deadlines</h2>
          ${d.missed.length ? `<table class="plain"><tbody>${d.missed.map(missedRow).join('')}</tbody></table>` : '<div class="empty">Nothing yet — good.</div>'}
        </div>
      </div>`;
  }

  if (tab === 'checkins') {
    let checks;
    try { checks = (await api(`/checkins/dom/${subId}`)).checkins; }
    catch (e) { checks = []; }
    const detailRows = checks;

    const row = (c) => `
      <tr><td>${esc(c.date)}</td><td>${c.mood} / 10</td><td>${c.day_rating} / 10</td></tr>`;
    const detail = (c) => `
      <div class="item">
        <div class="spread"><div class="title">${esc(fmtDate(c.date))}</div>
          <span class="chip">mood ${c.mood}/10</span> <span class="chip acc">day ${c.day_rating}/10</span></div>
        ${c.best_part ? `<div class="entry-body"><b>Best part:</b> ${esc(c.best_part)}</div>` : ''}
        ${c.worst_part ? `<div class="entry-body"><b>Worst part:</b> ${esc(c.worst_part)}</div>` : ''}
        ${c.sexual_notes ? `<div class="entry-body"><b>Sexual thoughts/activities:</b> ${esc(c.sexual_notes)}</div>` : ''}
        ${commentsBlock('checkin', c.id, c.comment_count)}
      </div>`;

    inner = `<div class="card"><h2>Check-in summary</h2>
        ${detailRows.length ? `<table class="plain"><thead><tr><th>Date</th><th>Mood</th><th>Day</th></tr></thead><tbody>${detailRows.map(row).join('')}</tbody></table>` : '<div class="empty">No check-ins yet.</div>'}
      </div>
      <div class="card"><h2>Check-in details</h2>${detailRows.length ? detailRows.map(detail).join('') : '<div class="empty">Nothing yet.</div>'}</div>`;
  }

  if (tab === 'punishments') {
    let pd = { open: [], history: [], weekly: { title: '', pct: null } };
    try { pd = await api(`/punishments/dom/sub/${subId}`); } catch (e) { /* fall through */ }
    const wk = pd.weekly || { title: '', pct: null };

    const punRow = (p) => `
      <div class="item">
        <div class="spread">
          <div><div class="title">${esc(p.title)}</div>
            ${p.description ? `<div class="muted">${esc(p.description)}</div>` : ''}
            <div class="tiny">${p.source === 'auto' ? 'auto-assigned for a missed task · ' : ''}assigned ${esc(fmtDT(p.created_at))} · needs ${esc(p.completion_mode === 'evidence' ? 'evidence' : 'checkbox')}</div>
          </div>
          <div class="row">
            <span class="chip ${p.status === 'completed' ? 'good' : p.status === 'cancelled' ? '' : 'bad'}">${esc(p.status)}</span>
            ${p.status === 'open' ? `<button class="small" data-action="cancel-punish" data-id="${esc(p.id)}">Cancel</button>` : ''}
          </div>
        </div>
        ${p.note ? `<div class="entry-body"><b>Note:</b> ${esc(p.note)}</div>` : ''}
        ${p.evidence_path ? `<div class="evid-links" style="margin-top:8px"><a href="/uploads/${esc(p.evidence_path)}" target="_blank">view evidence</a></div>` : ''}
        ${p.completed_at ? `<div class="tiny" style="margin-top:6px">completed ${esc(fmtDT(p.completed_at))}</div>` : ''}
        ${commentsBlock('punishment', p.id, p.comment_count)}
      </div>`;

    inner = `
      <div class="card"><h2>Assign punishment</h2>
        <form data-form="assign-punish" data-sub="${esc(subId)}">
          <label class="f"><span>Punishment</span><input type="text" name="title" required maxlength="120" placeholder="e.g. Corner time — 15 minutes"></label>
          <label class="f"><span>Details (optional)</span><textarea name="description" maxlength="1000"></textarea></label>
          <label class="f" style="max-width:260px"><span>Completed by</span>
            <select name="completion_mode"><option value="checkoff">Checking it off</option><option value="evidence">Photo / video evidence</option></select></label>
          <button class="primary small" type="submit">Assign punishment</button>
        </form>
        <p class="tiny" style="margin-top:10px">Tip: to punish a submissive automatically when they miss a task, set an auto-punishment on the task itself (Tasks tab). Punishments are due within 24 hours of assignment; you're notified if one sits uncompleted.</p>
      </div>
      <div class="card"><h2>Weekly compliance punish</h2>
        <p class="hint">When the week closes at Sunday midnight, their daily-task completion rate for that week is checked. If it is under your threshold, this punishment is auto-assigned once. ${wk.title ? `Currently: <span class="pun-text">${esc(wk.title)}</span> under ${esc(String(wk.pct))}%.` : 'Currently off.'}</p>
        <form data-form="weekly-punish" data-sub="${esc(subId)}">
          <label class="f"><span>Punishment (leave empty and save to disable)</span>
            <input type="text" name="title" maxlength="120" value="${esc(wk.title)}" placeholder="e.g. Early bedtime all week"></label>
          <label class="f" style="max-width:260px"><span>Minimum required daily-task completion %</span>
            <input type="number" name="pct" min="1" max="100" step="1" value="${wk.pct == null ? 70 : esc(String(wk.pct))}"></label>
          <button class="primary small" type="submit">Save weekly rule</button>
        </form>
      </div>
      <div class="card"><h2>Open punishments</h2>
        ${pd.open.length ? pd.open.map(punRow).join('') : '<div class="empty">None open.</div>'}
      </div>
      <div class="card"><h2>History</h2>
        ${pd.history.length ? pd.history.map(punRow).join('') : '<div class="empty">No closed punishments yet.</div>'}
      </div>`;
  }

  if (tab === 'profile') {
    let p;
    try { p = await api(`/profile/sub/${subId}`); } catch (e) { p = { fields: [] }; }

    // One row per field (fields are global): edit name + value for THIS sub,
    // flip this sub's visibility, or delete the field everywhere.
    const fieldRow = (f) => `
      <div class="item">
        <div class="prof-row">
          <label class="f" style="margin:0;flex:1;min-width:170px"><span>Field name</span>
            <input type="text" data-pf-label="${esc(f.id)}" maxlength="120" value="${esc(f.label)}"></label>
          <label class="f" style="margin:0;flex:2;min-width:220px"><span>Value <span class="tiny">(only you can edit)</span></span>
            ${f.multiline
              ? `<textarea data-pf-val="${esc(f.id)}" maxlength="4000" style="min-height:60px">${esc(f.value)}</textarea>`
              : `<input type="text" data-pf-val="${esc(f.id)}" maxlength="4000" value="${esc(f.value)}">`}
          </label>
          <div class="prof-actions">
            <button class="small primary" data-action="pf-save" data-id="${esc(f.id)}" data-sub="${esc(subId)}">Save</button>
            <button class="small ${f.visible_to_sub ? 'good' : 'ghost'}" data-action="pf-expose" data-id="${esc(f.id)}" data-sub="${esc(subId)}" data-visible="${f.visible_to_sub ? '1' : '0'}"
              title="${f.visible_to_sub ? `${esc(d.sub.name)} can read this field` : `${esc(d.sub.name)} cannot see this field`}">
              👁 ${f.visible_to_sub ? 'Shown' : 'Hidden'}</button>
            <button class="small danger" data-action="pf-del" data-id="${esc(f.id)}">Delete</button>
          </div>
        </div>
      </div>`;

    inner = `
      <div class="card"><h2>About ${esc(d.sub.name)}</h2>
        <p class="hint">Fields you create here are added to <b>every</b> submissive's profile automatically. Values and the 👁 visibility toggle are set per submissive here. A submissive can read — never edit — only the fields you have marked as shown.</p>
        <form data-form="pf-add">
          <div class="row">
            <label class="f" style="margin:0;flex:1;min-width:200px"><span>New field</span>
              <input type="text" name="label" required maxlength="120" placeholder="e.g. Shoe size"></label>
            <label class="f" style="margin:0;width:170px"><span>Input type</span>
              <select name="multiline"><option value="">Single line</option><option value="1">Multi-line text</option></select></label>
            <button class="primary small" style="margin-top:22px" type="submit">Add field</button>
          </div>
        </form>
      </div>
      <div class="card"><h2>Profile fields</h2>
        ${p.fields.length ? p.fields.map(fieldRow).join('') : '<div class="empty">No fields yet — add one above.</div>'}
      </div>`;
  }

  if (tab === 'stats') {
    statsCtx = { subId };
    let s = { checkins: [], taskRates: [], tiles: {}, range_days: 30, streak: 0 };
    try { s = await api(`/stats/sub/${subId}`); } catch (e) { /* fall through */ }
    inner = statsBody(s);
  }

  if (tab === 'journal') {
    let prompts, entries;
    try { [prompts, entries] = await Promise.all([api(`/prompts?sub_id=${encodeURIComponent(subId)}`), api(`/entries/sub/${subId}`)]); }
    catch (e) { /* fall through */ }
    prompts = (prompts && prompts.prompts) || [];
    entries = (entries && entries.entries) || [];

    const promptRow = (p) => `
      <div class="item" style="${p.active ? '' : 'opacity:.55'}">
        <div class="spread"><div><span class="chip acc">${esc(p.kind)}</span> ${esc(p.text)}</div>
          <div class="row">
            <button class="small" data-action="toggle-prompt" data-id="${esc(p.id)}" data-active="${p.active}">${p.active ? 'Deactivate' : 'Activate'}</button>
            <button class="small danger" data-action="del-prompt" data-id="${esc(p.id)}">Delete</button>
          </div></div>
      </div>`;
    const entryRow = (e) => `
      <div class="item">
        ${e.prompt_text ? `<div class="muted">Prompt: ${esc(e.prompt_text)} <span class="tiny">(${esc(e.prompt_kind || '')})</span></div>` : ''}
        <div class="entry-body">${esc(e.body)}</div>
        <div class="entry-meta">${esc(fmtDT(e.created_at))}</div>
        ${commentsBlock('entry', e.id, e.comment_count)}
      </div>`;

    inner = `
      <div class="card"><h2>Give a journal prompt</h2>
        <form data-form="prompt" data-sub="${esc(subId)}">
          <div class="row">
            <label class="f" style="width:130px"><span>Type</span>
              <select name="kind"><option value="daily">Daily</option><option value="weekly">Weekly</option></select></label>
            <label class="f" style="flex:1;min-width:200px"><span>Prompt</span>
              <input type="text" name="text" required maxlength="2000" placeholder="e.g. What made you feel taken care of today?"></label>
          </div>
          <button class="primary small" type="submit">Add prompt</button>
        </form>
      </div>
      <div class="card"><h2>My prompts for ${esc(d.sub.name)}</h2>${prompts.length ? prompts.map(promptRow).join('') : '<div class="empty">No prompts yet.</div>'}</div>
      <div class="card"><h2>${esc(d.sub.name)}'s entries</h2>${entries.length ? entries.map(entryRow).join('') : '<div class="empty">No entries yet.</div>'}</div>`;
  }

  shell(`#/sub/${esc(subId)}/${tab}`, `
    <a href="#/dash" class="muted">← Back to dashboard</a>
    <div><span class="page-title">${esc(d.sub.name)}</span>
      <span class="page-sub">${esc(d.sub.title || '')} · ${esc(d.sub.timezone)}</span></div>
    <nav class="tabs" style="margin:6px 0">${tabs}</nav>
    ${inner}`);
  if (tab === 'stats') bindViz();
}

/* ---------- dom: own journal ---------- */
async function renderDomJournal() {
  let mine, pair;
  try { [mine, pair] = await Promise.all([api('/entries'), api('/pair')]); }
  catch (e) { return shell('#/journal', `<div class="empty">${esc(e.message)}</div>`); }
  const subs = pair.subs || [];

  // Per-submissive sharing: each entry is shared to one sub at a time.
  const shareRow = (e) => {
    if (!subs.length) return '';
    const sharedChips = (e.shared_with || []).map(s =>
      `<button class="small" data-action="unshare-sub" data-id="${esc(e.id)}" data-sub="${esc(s.sub_id)}" title="Stop sharing with ${esc(s.sub_name)}">✓ ${esc(s.sub_name)} ✕</button>`).join('');
    const sharedIds = (e.shared_with || []).map(s => s.sub_id);
    const options = subs.filter(s => !sharedIds.includes(s.id)).map(s =>
      `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
    return `<div class="row" style="margin-top:10px;flex-wrap:wrap;gap:8px">
      ${sharedChips}
      ${options ? `<select data-share-select="${esc(e.id)}" style="max-width:200px">
          <option value="">Share with…</option>${options}</select>
        <button class="small" data-action="share-sub" data-id="${esc(e.id)}">Share</button>` : ''}
    </div>`;
  };

  const entryCard = (e) => `
    <div class="item">
      ${e.prompt_text ? `<div class="muted">Re: ${esc(e.prompt_text)}</div>` : ''}
      <div class="entry-body">${esc(e.body)}</div>
      <div class="entry-meta">${esc(fmtDT(e.created_at))}</div>
      <div class="row" style="margin-top:10px">
        <button class="small danger" data-action="del-entry" data-id="${esc(e.id)}">Delete</button>
      </div>
      ${shareRow(e)}
      ${commentsBlock('entry', e.id, e.comment_count)}
    </div>`;

  shell('#/journal', `
    <div class="card"><h2>Write a journal entry</h2>
      <p class="hint">Entries start private. Share each one with the submissive of your choice — no other submissive can see it.</p>
      <form data-form="entry" data-dom-entry>
        <label class="f"><textarea name="body" maxlength="8000" placeholder="Your private thoughts, instructions, reflections…" required></textarea></label>
        <button class="primary small" type="submit">Save entry</button>
      </form>
    </div>
    <div class="card"><h2>My entries</h2>
      ${mine.entries.length ? mine.entries.map(entryCard).join('') : '<div class="empty">No entries yet.</div>'}
    </div>`);
}

/* ---------- settings ---------- */
async function renderSettings() {
  let pair;
  try { pair = await api('/pair'); }
  catch (e) { return shell('#/settings', `<div class="empty">${esc(e.message)}</div>`); }

  const titleSel = (role, current) =>
    (role === 'dom' ? DOM_TITLES : SUB_TITLES).map(t =>
      `<option value="${esc(t)}"${t === current ? ' selected' : ''}>${esc(t)}</option>`).join('') +
    `<option value="__custom"${current && !(role === 'dom' ? DOM_TITLES : SUB_TITLES).includes(current) ? ' selected' : ''}>Custom…</option>`;

  let pairing = '';
  if (user.role === 'dom') {
    pairing = `
      <div class="card"><h2>Invite code</h2>
        <div class="code-box"><code>${esc(pair.invite_code || '—')}</code><button class="small" data-action="copy-code">Copy</button></div>
      </div>
      <div class="card"><h2>My submissives</h2>
        ${pair.subs.length ? pair.subs.map(s => `
          <div class="item spread"><div><div class="title">${esc(s.name)}</div><div class="tiny">${esc(s.title || '')} · ${esc(s.email)}</div></div>
            <button class="small danger" data-action="unpair-dom" data-id="${esc(s.id)}">Unpair</button></div>`).join('')
        : '<div class="empty">None paired yet.</div>'}
      </div>`;
  } else {
    pairing = `
      <div class="card"><h2>My Dominant</h2>
        ${pair.dom ? `
          <div class="item spread"><div><div class="title">${esc(pair.dom.title || '')} ${esc(pair.dom.name)}</div></div>
            <button class="small danger" data-action="unpair-self">Unpair from ${esc(pair.dom.name)}</button></div>`
        : `<p class="hint">Not paired yet. Enter the invite code your Dom gave you:</p>
           <form data-form="pair" class="row"><input type="text" name="code" placeholder="CTRL-…" required style="max-width:240px"><button class="primary small" type="submit">Pair</button></form>`}
      </div>`;
  }

  shell('#/settings', `
    <div class="card"><h2>Profile</h2>
      <form data-form="profile">
        <label class="f"><span>Display name</span><input type="text" name="name" required maxlength="80" value="${esc(user.name)}"></label>
        <label class="f"><span>Title</span>
          <select name="title" id="setTitle">${titleSel(user.role, user.title)}</select></label>
        <label class="f" id="setTitleCustom" ${user.title && !(user.role === 'dom' ? DOM_TITLES : SUB_TITLES).includes(user.title) ? '' : 'hidden'}>
          <span>Custom title</span><input type="text" name="customTitle" maxlength="60" value="${user.title && !(user.role === 'dom' ? DOM_TITLES : SUB_TITLES).includes(user.title) ? esc(user.title) : ''}"></label>
        <label class="f"><span>Timezone <span class="tiny">(drives all deadlines)</span></span>
          <input type="text" name="timezone" value="${esc(user.timezone)}" required aria-label="IANA timezone" placeholder="America/Chicago"></label>
        <label class="f row"><input type="checkbox" name="email_notifications" ${user.email_notifications ? 'checked' : ''} style="width:auto;margin-right:8px"><span style="margin:0">Email me notifications</span></label>
        <button class="primary" type="submit">Save</button>
      </form>
    </div>
    ${pairing}`);
}

/* ---------- forms ---------- */
const forms = {
  async login(f) {
    try {
      const d = await api('/auth/login', { method: 'POST', body: { email: f.email.value, password: f.password.value } });
      user = d.user; go('#/'); route();
    } catch (e) { toast(e.message, true); }
  },

  async forgot(f) {
    try {
      await api('/auth/forgot', { method: 'POST', body: { email: f.email.value } });
      toast('If that email is registered, a reset link is on its way.');
      go('#/login'); route();
    } catch (e) { toast(e.message, true); }
  },

  async reset(f) {
    if (f.password.value !== f.confirm.value) return toast('Passwords do not match', true);
    try {
      await api('/auth/reset', { method: 'POST', body: { token: f.dataset.token, password: f.password.value } });
      toast('Password updated — sign in with it now');
      go('#/login'); route();
    } catch (e) { toast(e.message, true); }
  },

  async register(f) {
    try {
      const role = f.role.value;
      const title = f.title.value === '__custom' ? (f.customTitle ? f.customTitle.value : '') : f.title.value;
      const d = await api('/auth/register', { method: 'POST', body: {
        email: f.email.value, password: f.password.value, name: f.name.value,
        role, title, timezone: tz, inviteCode: f.inviteCode ? f.inviteCode.value : ''
      }});
      user = d.user;
      toast(`Welcome, ${d.user.name}`);
      go('#/'); route();
    } catch (e) { toast(e.message, true); }
  },

  async checkin(f) {
    try {
      await api('/checkins', { method: 'POST', body: {
        mood: Number(f.mood.value), day_rating: Number(f.day_rating.value),
        best_part: f.best_part.value, worst_part: f.worst_part.value, sexual_notes: f.sexual_notes.value
      }});
      toast('Check-in saved — your Dominant can see it');
      route();
    } catch (e) { toast(e.message, true); }
  },

  async evidence(f) {
    const taskId = f.dataset.task;
    const input = f.querySelector('input[type="file"]');
    if (!input.files.length) return toast('Choose a photo or video first', true);
    const fd = new FormData();
    fd.append('evidence', input.files[0]);
    fd.append('note', f.note ? f.note.value : '');
    fd.append('method', 'evidence');
    try {
      const res = await fetch(`/api/tasks/${taskId}/complete`, { method: 'POST', body: fd, credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      toast('Task completed with evidence — your Dominant has been notified');
      route();
    } catch (e) { toast(e.message, true); }
  },

  async punishEvidence(f) {
    const input = f.querySelector('input[type="file"]');
    if (!input.files.length) return toast('Choose a photo or video first', true);
    const fd = new FormData();
    fd.append('evidence', input.files[0]);
    fd.append('note', f.note ? f.note.value : '');
    fd.append('method', 'evidence');
    try {
      const res = await fetch(`/api/punishments/${f.dataset.id}/complete`, { method: 'POST', body: fd, credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      toast('Punishment completed — your Dominant has been notified');
      route();
    } catch (e) { toast(e.message, true); }
  },

  async entry(f) {
    try {
      await api('/entries', { method: 'POST', body: {
        prompt_id: f.dataset.prompt || null, body: f.body.value
      }});
      toast('Entry saved');
      route();
    } catch (e) { toast(e.message, true); }
  },

  async assign(f) {
    try {
      await api('/tasks', { method: 'POST', body: {
        sub_id: f.dataset.sub, title: f.title.value, description: f.description.value,
        frequency: f.frequency.value, completion_mode: f.completion_mode.value,
        due_date: f.due_date ? f.due_date.value : '',
        auto_punish_title: f.auto_punish_title ? f.auto_punish_title.value : ''
      }});
      toast('Task assigned');
      route();
    } catch (e) { toast(e.message, true); }
  },

  async prompt(f) {
    try {
      await api('/prompts', { method: 'POST', body: { sub_id: f.dataset.sub, kind: f.kind.value, text: f.text.value } });
      toast('Prompt added');
      route();
    } catch (e) { toast(e.message, true); }
  },

  async assignPunish(f) {
    try {
      await api('/punishments', { method: 'POST', body: {
        sub_id: f.dataset.sub, title: f.title.value, description: f.description.value,
        completion_mode: f.completion_mode.value
      }});
      toast('Punishment assigned');
      route();
    } catch (e) { toast(e.message, true); }
  },

  async weeklyPunish(f) {
    try {
      const res = await api(`/punishments/dom/sub/${f.dataset.sub}/weekly`, {
        method: 'PUT', body: { title: f.title.value, pct: f.pct.value }
      });
      toast(res.weekly && res.weekly.title ? 'Weekly compliance rule saved' : 'Weekly compliance rule disabled');
      route();
    } catch (e) { toast(e.message, true); }
  },

  async pair(f) {
    try {
      await api('/pair', { method: 'POST', body: { code: f.code.value } });
      toast('Paired');
      go('#/today'); route();
    } catch (e) { toast(e.message, true); }
  },

  async profile(f) {
    try {
      const titleVal = f.title.value === '__custom' ? (f.customTitle ? f.customTitle.value : '') : f.title.value;
      const d = await api('/auth/me', { method: 'PATCH', body: {
        name: f.name.value, title: titleVal, timezone: f.timezone.value,
        email_notifications: f.email_notifications.checked
      }});
      user = d.user;
      toast('Profile saved');
      route();
    } catch (e) { toast(e.message, true); }
  },

  async pfAdd(f) {
    try {
      await api('/profile/fields', { method: 'POST', body: {
        label: f.label.value, multiline: f.multiline.value === '1'
      }});
      toast("Field added — it's now on every submissive's profile");
      route();
    } catch (e) { toast(e.message, true); }
  },

  async comment(f) {
    const box = f.closest('.comments');
    try {
      await api(`/comments/${box.dataset.commentSubject}/${box.dataset.commentId}`,
                { method: 'POST', body: { body: f.body.value } });
      f.body.value = '';
      const list = box.querySelector('.comment-list');
      await loadComments(box);
      list.hidden = false; f.hidden = false;
      const btn = box.querySelector('[data-action="toggle-comments"]');
      const m = btn.textContent.match(/·\s*(\d+)/);
      btn.innerHTML = `💬 Comments · ${(m ? Number(m[1]) : 0) + 1}`;
    } catch (e) { toast(e.message, true); }
  }
};

/* ---------- actions ---------- */
const actions = {
  'logout': async () => { try { await api('/auth/logout', { method: 'POST' }); } catch { /* ignore */ } user = null; go('#/login'); route(); },
  'checkoff': async (btn) => {
    try {
      await api(`/tasks/${btn.dataset.task}/complete`, { method: 'POST', body: { method: 'checkoff' } });
      toast('Completed — your Dominant has been notified');
      route();
    } catch (e) { toast(e.message, true); }
  },
  'punish-checkoff': async (btn) => {
    try {
      await api(`/punishments/${btn.dataset.id}/complete`, { method: 'POST', body: { method: 'checkoff' } });
      toast('Punishment completed — your Dominant has been notified');
      route();
    } catch (e) { toast(e.message, true); }
  },
  'cancel-punish': async (btn) => {
    if (!confirm('Cancel this punishment?')) return;
    try { await api(`/punishments/${btn.dataset.id}`, { method: 'DELETE' }); toast('Punishment cancelled'); route(); }
    catch (e) { toast(e.message, true); }
  },
  'copy-code': (btn) => {
    const code = document.getElementById('inviteCode') || btn.closest('.code-box').querySelector('code');
    navigator.clipboard && navigator.clipboard.writeText(code.textContent).then(() => toast('Copied')).catch(() => toast('Copy failed', true));
  },
  'toggle-task': async (btn) => {
    try { await api(`/tasks/${btn.dataset.id}`, { method: 'PATCH', body: { active: btn.dataset.active !== '1' } }); route(); }
    catch (e) { toast(e.message, true); }
  },
  'del-task': async (btn) => {
    if (!confirm('Delete this task and its history?')) return;
    try { await api(`/tasks/${btn.dataset.id}`, { method: 'DELETE' }); toast('Task deleted'); route(); }
    catch (e) { toast(e.message, true); }
  },
  'toggle-prompt': async (btn) => {
    try { await api(`/prompts/${btn.dataset.id}`, { method: 'PATCH', body: { active: btn.dataset.active !== '1' } }); route(); }
    catch (e) { toast(e.message, true); }
  },
  'del-prompt': async (btn) => {
    if (!confirm('Delete this prompt? Entries already written are kept.')) return;
    try { await api(`/prompts/${btn.dataset.id}`, { method: 'DELETE' }); toast('Prompt deleted'); route(); }
    catch (e) { toast(e.message, true); }
  },
  'share-sub': async (btn) => {
    const sel = app.querySelector(`select[data-share-select="${btn.dataset.id}"]`);
    if (!sel || !sel.value) return toast('Choose a submissive to share with', true);
    try {
      await api(`/entries/${btn.dataset.id}`, { method: 'PATCH', body: { share_sub_id: sel.value } });
      toast('Shared with 1 submissive');
      route();
    } catch (e) { toast(e.message, true); }
  },
  'unshare-sub': async (btn) => {
    try {
      await api(`/entries/${btn.dataset.id}`, { method: 'PATCH', body: { unshare_sub_id: btn.dataset.sub } });
      toast('Sharing stopped');
      route();
    } catch (e) { toast(e.message, true); }
  },
  'del-entry': async (btn) => {
    if (!confirm('Delete this entry?')) return;
    try { await api(`/entries/${btn.dataset.id}`, { method: 'DELETE' }); toast('Entry deleted'); route(); }
    catch (e) { toast(e.message, true); }
  },
  'unpair-self': async () => {
    if (!confirm('Leave your Dom? Your tasks and prompts will be deactivated.')) return;
    try { await api('/pair', { method: 'DELETE' }); toast('Unpaired'); route(); }
    catch (e) { toast(e.message, true); }
  },
  'unpair-dom': async (btn) => {
    if (!confirm('Unpair this submissive? Their tasks and prompts will be deactivated.')) return;
    try { await api('/pair', { method: 'DELETE', body: { sub_id: btn.dataset.id } }); toast('Unpaired'); route(); }
    catch (e) { toast(e.message, true); }
  },
  'pf-save': async (btn) => {
    const id = btn.dataset.id, subId = btn.dataset.sub;
    const label = app.querySelector(`[data-pf-label="${id}"]`);
    const val = app.querySelector(`[data-pf-val="${id}"]`);
    try {
      await api(`/profile/fields/${id}`, { method: 'PATCH', body: { label: label.value } });
      await api(`/profile/sub/${subId}/value`, { method: 'PUT', body: { field_id: id, value: val.value } });
      toast('Field saved');
      route();
    } catch (e) { toast(e.message, true); }
  },
  'pf-expose': async (btn) => {
    try {
      await api('/profile/expose', { method: 'PATCH', body: {
        field_id: btn.dataset.id, sub_id: btn.dataset.sub, visible: btn.dataset.visible !== '1'
      }});
      toast(btn.dataset.visible === '1' ? 'Hidden from this submissive' : 'Now visible to this submissive');
      route();
    } catch (e) { toast(e.message, true); }
  },
  'pf-del': async (btn) => {
    if (!confirm("Delete this field from every submissive's profile? Its values are lost.")) return;
    try { await api(`/profile/fields/${btn.dataset.id}`, { method: 'DELETE' }); toast('Field deleted'); route(); }
    catch (e) { toast(e.message, true); }
  },
  'toggle-comments': async (btn) => {
    const box = btn.closest('.comments');
    const list = box.querySelector('.comment-list');
    const form = box.querySelector('form');
    if (list.hidden) {
      await loadComments(box);
      list.hidden = false; form.hidden = false;
    } else { list.hidden = true; form.hidden = true; }
  },
  'del-comment': async (btn) => {
    const box = btn.closest('.comments');
    try { await api(`/comments/${btn.dataset.comment}`, { method: 'DELETE' }); await loadComments(box); }
    catch (e) { toast(e.message, true); }
  }
};

/* ---------- events ---------- */
app.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (btn && actions[btn.dataset.action]) { e.preventDefault(); actions[btn.dataset.action](btn, e); }
});

app.addEventListener('submit', (e) => {
  const f = e.target.closest('form[data-form]');
  if (!f) return;
  e.preventDefault();
  // data-form uses kebab-case ("punish-evidence"); handler keys are camelCase.
  const key = String(f.dataset.form || '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  if (forms[key]) forms[key](f);
});

app.addEventListener('input', (e) => {
  if (e.target.matches('input[type="range"]')) updateScales();
});

// Stats time-range filter — one filter row scoping everything below it (dataviz spec).
app.addEventListener('change', async (e) => {
  if (e.target.id !== 'statsRange' || !statsCtx) return;
  const url = statsCtx.subId ? `/stats/sub/${statsCtx.subId}?days=` : `/stats/me?days=`;
  const zone = app.querySelector('.chart-zone');
  if (zone) zone.style.opacity = '0.55'; // hold the frame while refetching
  try {
    const s = await api(url + e.target.value);
    if (statsCtx.subId) { shell(`#/sub/${esc(statsCtx.subId)}/stats`, statsBody(s)); }
    else { shell('#/stats', statsBody(s)); }
    if (zone) zone.style.opacity = '1';
    bindViz();
  } catch (err) {
    if (zone) zone.style.opacity = '1';
    toast(err.message, true);
  }
});

window.addEventListener('hashchange', route);
route();