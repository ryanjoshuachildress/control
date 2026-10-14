import { useEffect, useState } from 'react';
import { api, upload } from '../api';
import { toast } from '../toast';
import { FREQ_LABEL, fmtDate, fmtDT, peopleLabel } from '../format';
import Comments from '../components/Comments';
import ImmichControl from '../components/ImmichControl';
import { Media } from '../components/Media';
import { StatsBody } from './Stats';
import { EntryCard } from './SubJournal';

// Dom's per-submissive detail: tasks / punishments / check-ins / stats /
// journal / profile tabs.
export default function DomSub({ subId, tab, focusSpec }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    api(`/tasks/dom/sub/${subId}`)
      .then(x => alive && setD(x))
      .catch(e => alive && setErr(e.message));
    return () => { alive = false; };
  }, [subId, tick]);

  if (err) return <div className="empty">{err}</div>;
  if (!d) return null;
  const reload = () => setTick(t => t + 1);

  const tabs = [
    ['tasks', 'Tasks'], ['punishments', 'Punishments'], ['checkins', 'Check-ins'],
    ['stats', 'Stats'], ['journal', 'Journal'], ['profile', 'About']
  ].map(([k, l]) => (
    <a key={k} href={`#/sub/${subId}/${k}`} className={tab === k ? 'on' : ''}>{l}</a>
  ));

  let inner = null;
  if (tab === 'tasks') inner = <TasksTab d={d} subId={subId} reload={reload} />;
  else if (tab === 'checkins') inner = <CheckinsTab subId={subId} />;
  else if (tab === 'punishments') inner = <PunishmentsTab subId={subId} subName={d.sub.name} reload={reload} />;
  else if (tab === 'profile') inner = <ProfileTab subId={subId} subName={d.sub.name} reload={reload} />;
  else if (tab === 'stats') inner = <StatsTab subId={subId} />;
  else if (tab === 'journal') inner = <JournalTab subId={subId} subName={d.sub.name} reload={reload} />;
  else inner = <TasksTab d={d} subId={subId} reload={reload} />;

  return (
    <>
      <a href="#/dash" className="muted">← Back to dashboard</a>
      <div>
        <span className="page-title">{d.sub.name}</span>
        <span className="page-sub">{d.sub.title || ''} · {d.sub.timezone}</span>
      </div>
      <nav className="tabs" style={{ margin: '6px 0' }}>{tabs}</nav>
      {inner}
    </>
  );
}

function TasksTab({ d, subId, reload }) {
  const toastE = (e) => toast(e.message, true);

  return (
    <>
      <div className="card">
        <h2>Assign new task</h2>
        <form data-form="assign" onSubmit={(e) => {
          e.preventDefault();
          const f = e.target;
          api('/tasks', { method: 'POST', body: {
            sub_id: subId, title: f.title.value, description: f.description.value,
            frequency: f.frequency.value, completion_mode: f.completion_mode.value,
            due_date: f.due_date ? f.due_date.value : '',
            auto_punish_title: f.auto_punish_title ? f.auto_punish_title.value : ''
          } })
            .then(() => import('../toast').then(m => { m.toast('Task assigned'); reload(); }))
            .catch(toastE);
        }}>
          <label className="f"><span>Task</span>
            <input type="text" name="title" required maxLength={120} placeholder="e.g. Write in journal every evening" /></label>
          <label className="f"><span>Details (optional)</span><textarea name="description" maxLength={1000} /></label>
          <div className="row">
            <label className="f" style={{ flex: 1, minWidth: 150 }}><span>Frequency</span>
              <select name="frequency"><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></label>
            <label className="f" style={{ flex: 1, minWidth: 150 }}><span>Completed by</span>
              <select name="completion_mode"><option value="checkoff">Checking it off</option><option value="evidence">Photo / video evidence</option></select></label>
            <label className="f" style={{ flex: 1, minWidth: 160 }}><span>Due date <span className="tiny">(optional)</span></span>
              <input type="date" name="due_date" /></label>
          </div>
          <label className="f"><span>Auto-punishment on missed deadline <span className="tiny">(optional — assigned automatically, due in 24h)</span></span>
            <input type="text" name="auto_punish_title" maxLength={120} placeholder="e.g. No dessert, early bedtime, corner time" /></label>
          <div className="tiny" style={{ margin: '-6px 0 12px' }}>
            Daily tasks close at midnight {d.sub.timezone}; weekly at Sunday midnight; monthly at the end of the month. An optional due date overrides all of that — the task closes at the end of that day (midnight {d.sub.timezone} time), once.
          </div>
          <button className="primary" type="submit">Assign task</button>
        </form>
      </div>
      <div className="card">
        <h2>Tasks</h2>
        {d.tasks.length ? d.tasks.map(t => <TaskRow key={t.id} t={t} reload={reload} toastE={toastE} />) : <div className="empty">No tasks assigned yet.</div>}
      </div>
      <div className="grid2">
        <div className="card">
          <h2>Recent completions</h2>
          {d.completions.length ? (
            <table className="plain"><tbody>
              {d.completions.map(c => (
                <tr key={c.id}>
                  <td>{fmtDT(c.completed_at)}</td><td>{c.task_title}</td><td>{c.period_key}</td>
                  <td className="evid-links">
                    {c.method === 'evidence'
                      ? (c.evidence_path
                        ? <a href={`/uploads/${c.evidence_path}`} target="_blank">view</a>
                        : c.immich_asset_id
                          ? <a href={`/api/immich/asset/${c.immich_asset_id}/original`} target="_blank">Immich</a>
                          : <span className="tiny">evidence missing</span>)
                      : <span className="tiny">checked off</span>}
                    {c.note ? <span className="tiny"> “{c.note}”</span> : null}
                  </td>
                </tr>
              ))}
            </tbody></table>
          ) : <div className="empty">Nothing yet.</div>}
        </div>
        <div className="card">
          <h2>Missed deadlines</h2>
          {d.missed.length ? (
            <table className="plain"><tbody>
              {d.missed.map(m => (
                <tr key={m.id}>
                  <td>{fmtDT(m.sent_at)}</td><td>{m.task_title}</td><td>{m.period_key}</td>
                </tr>
              ))}
            </tbody></table>
          ) : <div className="empty">Nothing yet — good.</div>}
        </div>
      </div>
    </>
  );
}

function TaskRow({ t, reload, toastE }) {
  return (
    <>
      <div className="item" style={t.active ? undefined : { opacity: .55 }}>
        <div className="spread">
          <div>
            <div className="title">{t.title}</div>
            {t.description ? <div className="muted">{t.description}</div> : null}
            <div className="tiny">
              {t.due_date
                ? <>One-off — due <span className="pun-text">{fmtDate(t.due_date)}</span> (end of day) · needs {t.completion_mode === 'evidence' ? 'photo/video evidence' : 'checkbox'}</>
                : <>{FREQ_LABEL[t.frequency] || t.frequency} · needs {t.completion_mode === 'evidence' ? 'photo/video evidence' : 'checkbox'}</>}
              {t.auto_punish_title && <> · auto-punish on miss: <span className="pun-text">{t.auto_punish_title}</span></>}
            </div>
          </div>
          <div className="row">
            {t.current_done
              ? (t.due_date ? <span className="chip good">done ✓</span> : <span className="chip good">this period ✓</span>)
              : (t.active
                ? (t.due_date ? <span className="chip acc">due date open</span> : <span className="chip acc">this period open</span>)
                : <span className="chip">inactive</span>)}
            <button className="small" onClick={async () => {
              try { await api(`/tasks/${t.id}`, { method: 'PATCH', body: { active: t.active !== 1 } }); reload(); }
              catch (e) { toastE(e); }
            }}>{t.active ? 'Pause' : 'Resume'}</button>
            <button className="small danger" onClick={async () => {
              if (!confirm('Delete this task and its history?')) return;
              try { await api(`/tasks/${t.id}`, { method: 'DELETE' }); toast('Task deleted'); reload(); }
              catch (e) { toastE(e); }
            }}>Delete</button>
          </div>
        </div>
      </div>
      <Comments subject="task" id={t.id} count={t.comment_count} />
    </>
  );
}

function CheckinsTab({ subId }) {
  const [checks, setChecks] = useState([]);
  useEffect(() => {
    api(`/checkins/dom/${subId}`).then(x => setChecks(x.checkins)).catch(() => {});
  }, [subId]);

  return (
    <>
      <div className="card">
        <h2>Check-in summary</h2>
        {checks.length ? (
          <table className="plain">
            <thead><tr><th>Date</th><th>Mood</th><th>Day</th></tr></thead>
            <tbody>{checks.map(c => <tr key={c.id}><td>{c.date}</td><td>{c.mood} / 10</td><td>{c.day_rating} / 10</td></tr>)}</tbody>
          </table>
        ) : <div className="empty">No check-ins yet.</div>}
      </div>
      <div className="card">
        <h2>Check-in details</h2>
        {checks.length ? checks.map(c => (
          <div className="item" key={c.id}>
            <div className="spread">
              <div className="title">{fmtDate(c.date)}</div>
              <span className="chip">mood {c.mood}/10</span> <span className="chip acc">day {c.day_rating}/10</span>
            </div>
            {c.best_part && <div className="entry-body"><b>Best part:</b> {c.best_part}</div>}
            {c.worst_part && <div className="entry-body"><b>Worst part:</b> {c.worst_part}</div>}
            {c.sexual_notes && <div className="entry-body"><b>Sexual thoughts/activities:</b> {c.sexual_notes}</div>}
            <Comments subject="checkin" id={c.id} count={c.comment_count} />
          </div>
        )) : <div className="empty">Nothing yet.</div>}
      </div>
    </>
  );
}

function PunishmentsTab({ subId, subName, reload }) {
  const [pd, setPd] = useState({ open: [], history: [], weekly: { title: '', pct: null } });
  useEffect(() => {
    api(`/punishments/dom/sub/${subId}`).then(setPd).catch(() => {});
  }, [subId, reload]);
  const wk = pd.weekly || { title: '', pct: null };
  const toastE = (e) => toast(e.message, true);

  const punRow = (p) => (
    <div className="item" key={p.id}>
      <div className="spread">
        <div>
          <div className="title">{p.title}</div>
          {p.description ? <div className="muted">{p.description}</div> : null}
          <div className="tiny">{p.source === 'auto' ? 'auto-assigned for a missed task · ' : ''}assigned {fmtDT(p.created_at)} · needs {p.completion_mode === 'evidence' ? 'evidence' : 'checkbox'}</div>
        </div>
        <div className="row">
          <span className={'chip ' + (p.status === 'completed' ? 'good' : p.status === 'cancelled' ? '' : 'bad')}>{p.status}</span>
          {p.status === 'open' && (
            <button className="small" onClick={async () => {
              if (!confirm('Cancel this punishment?')) return;
              try { await api(`/punishments/${p.id}`, { method: 'DELETE' }); toast('Punishment cancelled'); reload(); }
              catch (e) { toastE(e); }
            }}>Cancel</button>
          )}
        </div>
      </div>
      {p.note && <div className="entry-body"><b>Note:</b> {p.note}</div>}
      {p.evidence_path && (
        <div className="evid-links" style={{ marginTop: 8 }}>
          <a href={`/uploads/${p.evidence_path}`} target="_blank">view evidence</a>
        </div>
      )}
      {!p.evidence_path && p.immich_asset_id && (
        <div className="evid-links" style={{ marginTop: 8 }}>
          <a href={`/api/immich/asset/${p.immich_asset_id}/original`} target="_blank">Immich evidence</a>
        </div>
      )}
      {p.completed_at && <div className="tiny" style={{ marginTop: 6 }}>completed {fmtDT(p.completed_at)}</div>}
      <Comments subject="punishment" id={p.id} count={p.comment_count} />
    </div>
  );

  return (
    <>
      <div className="card">
        <h2>Assign punishment</h2>
        <form onSubmit={(e) => {
          e.preventDefault();
          const f = e.target;
          api('/punishments', { method: 'POST', body: {
            sub_id: subId, title: f.title.value, description: f.description.value,
            completion_mode: f.completion_mode.value
          } })
            .then(() => { toast('Punishment assigned'); reload(); })
            .catch(toastE);
        }}>
          <label className="f"><span>Punishment</span>
            <input type="text" name="title" required maxLength={120} placeholder="e.g. Corner time — 15 minutes" /></label>
          <label className="f"><span>Details (optional)</span><textarea name="description" maxLength={1000} /></label>
          <label className="f" style={{ maxWidth: 260 }}><span>Completed by</span>
            <select name="completion_mode"><option value="checkoff">Checking it off</option><option value="evidence">Photo / video evidence</option></select></label>
          <button className="primary small" type="submit">Assign punishment</button>
        </form>
        <p className="tiny" style={{ marginTop: 10 }}>Tip: to punish a submissive automatically when they miss a task, set an auto-punishment on the task itself (Tasks tab). Punishments are due within 24 hours of assignment; you're notified if one sits uncompleted.</p>
      </div>
      <div className="card">
        <h2>Weekly compliance punish</h2>
        <p className="hint">When the week closes at Sunday midnight, their daily-task completion rate for that week is checked. If it is under your threshold, this punishment is auto-assigned once. {wk.title ? <>Currently: <span className="pun-text">{wk.title}</span> under {String(wk.pct)}%.</> : 'Currently off.'}</p>
        <form onSubmit={(e) => {
          e.preventDefault();
          const f = e.target;
          api(`/punishments/dom/sub/${subId}/weekly`, { method: 'PUT', body: { title: f.title.value, pct: f.pct.value } })
            .then((res) => {
              toast(res.weekly && res.weekly.title ? 'Weekly compliance rule saved' : 'Weekly compliance rule disabled');
              reload();
            })
            .catch(toastE);
        }}>
          <label className="f"><span>Punishment (leave empty and save to disable)</span>
            <input type="text" name="title" maxLength={120} defaultValue={wk.title} placeholder="e.g. Early bedtime all week" /></label>
          <label className="f" style={{ maxWidth: 260 }}><span>Minimum required daily-task completion %</span>
            <input type="number" name="pct" min={1} max={100} step={1} defaultValue={wk.pct == null ? 70 : String(wk.pct)} /></label>
          <button className="primary small" type="submit">Save weekly rule</button>
        </form>
      </div>
      <div className="card">
        <h2>Open punishments</h2>
        {pd.open.length ? pd.open.map(punRow) : <div className="empty">None open.</div>}
      </div>
      <div className="card">
        <h2>History</h2>
        {pd.history.length ? pd.history.map(punRow) : <div className="empty">No closed punishments yet.</div>}
      </div>
    </>
  );
}

function StatsTab({ subId }) {
  const [s, setS] = useState({ checkins: [], taskRates: [], tiles: {}, range_days: 30, streak: 0 });
  useEffect(() => {
    api(`/stats/sub/${subId}`).then(setS).catch(() => {});
  }, [subId]);
  return <StatsBody s={s} onRange={days => api(`/stats/sub/${subId}?days=${days}`).then(setS).catch(e => toast(e.message, true))} />;
}

function JournalTab({ subId, subName, reload }) {
  const [prompts, setPrompts] = useState([]);
  const [entries, setEntries] = useState([]);
  useEffect(() => {
    Promise.all([api(`/prompts?sub_id=${encodeURIComponent(subId)}`), api(`/entries/sub/${subId}`)])
      .then(([p, en]) => { setPrompts(p.prompts || []); setEntries(en.entries || []); })
      .catch(() => {});
  }, [subId, reload]);
  const toastE = (e) => toast(e.message, true);

  return (
    <>
      <div className="card">
        <h2>Give a journal prompt</h2>
        <EntryFormDom subId={subId} reload={reload} />
      </div>
      <div className="card">
        <h2>My prompts for {subName}</h2>
        {prompts.length ? prompts.map(p => (
          <div className="item" key={p.id} style={p.active ? undefined : { opacity: .55 }}>
            <div className="spread">
              <div><span className="chip acc">{p.kind}</span> {p.text}</div>
              <div className="row">
                <button className="small" onClick={async () => {
                  try { await api(`/prompts/${p.id}`, { method: 'PATCH', body: { active: p.active !== 1 } }); reload(); }
                  catch (e) { toastE(e); }
                }}>{p.active ? 'Deactivate' : 'Activate'}</button>
                <button className="small danger" onClick={async () => {
                  if (!confirm('Delete this prompt? Entries already written are kept.')) return;
                  try { await api(`/prompts/${p.id}`, { method: 'DELETE' }); toast('Prompt deleted'); reload(); }
                  catch (e) { toastE(e); }
                }}>Delete</button>
              </div>
            </div>
          </div>
        )) : <div className="empty">No prompts yet.</div>}
      </div>
      <div className="card">
        <h2>{subName}'s entries</h2>
        {entries.length ? entries.map(e => <EntryCard key={e.id} e={e} />) : <div className="empty">No entries yet.</div>}
      </div>
    </>
  );
}

function EntryFormDom({ subId, reload }) {
  const [kind, setKind] = useState('daily');
  const [text, setText] = useState('');
  return (
    <form onSubmit={(e) => {
      e.preventDefault();
      api('/prompts', { method: 'POST', body: { sub_id: subId, kind, text } })
        .then(() => { toast('Prompt added'); setText(''); reload(); })
        .catch(e => import('../toast').then(m => m.toast(e.message, true)));
    }}>
      <div className="row">
        <label className="f" style={{ width: 130 }}><span>Type</span>
          <select value={kind} onChange={e => setKind(e.target.value)}>
            <option value="daily">Daily</option><option value="weekly">Weekly</option>
          </select></label>
        <label className="f" style={{ flex: 1, minWidth: 200 }}><span>Prompt</span>
          <input type="text" value={text} onChange={e => setText(e.target.value)} required maxLength={2000}
            placeholder="e.g. What made you feel taken care of today?" /></label>
      </div>
      <button className="primary small" type="submit">Add prompt</button>
    </form>
  );
}

function ProfileTab({ subId, subName, reload }) {
  const [p, setP] = useState({ fields: [] });
  const [immichVals, setImmichVals] = useState({});
  useEffect(() => {
    api(`/profile/sub/${subId}`).then(setP).catch(() => {});
  }, [subId, reload]);
  const toastE = (e) => toast(e.message, true);

  const fieldRow = (f) => {
    const kind = f.kind || (f.multiline ? 'multiline' : 'text');
    return (
      <div className="item" key={f.id}>
        <div className="prof-row">
          <label className="f" style={{ margin: 0, flex: 1, minWidth: 170 }}>
            <span>Field name</span>
            <input type="text" data-pf-label={f.id} maxLength={120} defaultValue={f.label} />
          </label>
          <label className="f" style={{ margin: 0, flex: 2, minWidth: 220 }}>
            <span>Value <span className="tiny">(only you can edit)</span></span>
            {kind === 'photo' ? (
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                {f.value
                  ? <a href={`/uploads/${f.value}`} target="_blank" rel="noopener" title="View full size">
                      <img className="pf-thumb" src={`/uploads/${f.value}`} alt={f.label} />
                    </a>
                  : f.im_asset_id
                    ? <Media a={{ immich: true, asset_id: f.im_asset_id, media: f.im_media || 'image' }} alt={f.label} />
                    : <div className="tiny" style={{ marginTop: 10 }}>No photo yet</div>}
                <label className="f" style={{ margin: 0, flex: 1, minWidth: 180 }}>
                  <span>Replace photo <span className="tiny">(jpg, png, gif, webp)</span></span>
                  <input type="file" data-pf-photo={f.id} accept=".jpg,.jpeg,.png,.gif,.webp,image/*" />
                </label>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <ImmichControl max={1} value={f.im_asset_id || ''}
                    onChange={(v) => setImmichVals(prev => ({ ...prev, [f.id]: v }))} />
                </div>
              </div>
            ) : kind === 'multiline' ? (
              <textarea data-pf-val={f.id} maxLength={4000} defaultValue={f.value} style={{ minHeight: 60 }} />
            ) : (
              <input type="text" data-pf-val={f.id} maxLength={4000} defaultValue={f.value} />
            )}
          </label>
          <div className="prof-actions">
            <button className="small primary" onClick={async (e) => {
              const btn = e.currentTarget;
              const rowEl = btn.closest('.item');
              try {
                await api(`/profile/fields/${f.id}`, { method: 'PATCH', body: { label: rowEl.querySelector(`[data-pf-label="${f.id}"]`).value } });
                if (kind === 'photo') {
                  const imId = (immichVals[f.id] ?? '').trim();
                  if (!imId) {
                    const inp = rowEl.querySelector(`[data-pf-photo="${f.id}"]`);
                    if (!inp || !inp.files.length) {
                      toast('Pick a new image or link one from Immich (or nothing changed and it is saved as-is)', true);
                      return;
                    }
                    const fd = new FormData();
                    fd.append('photo', inp.files[0]);
                    fd.append('field_id', f.id);
                    const res = await fetch(`/api/profile/sub/${subId}/photo`, { method: 'POST', body: fd, credentials: 'same-origin' });
                    const data = await res.json().catch(() => ({}));
                    if (!res.ok) throw new Error(data.error || 'Upload failed');
                  } else {
                    const fd = new FormData();
                    fd.append('field_id', f.id);
                    fd.append('asset_id', imId);
                    const res = await fetch(`/api/profile/sub/${subId}/photo`, { method: 'POST', body: fd, credentials: 'same-origin' });
                    const data = await res.json().catch(() => ({}));
                    if (!res.ok) throw new Error(data.error || 'Link failed');
                  }
                } else {
                  const val = rowEl.querySelector(`[data-pf-val="${f.id}"]`);
                  await api(`/profile/sub/${subId}/value`, { method: 'PUT', body: { field_id: f.id, value: val.value } });
                }
                toast('Field saved');
                reload();
              } catch (err) { toastE(err); }
            }}>Save</button>
            <button className={'small ' + (f.visible_to_sub ? 'good' : 'ghost')}
              title={f.visible_to_sub ? `${subName} can read this field` : `${subName} cannot see this field`}
              onClick={async () => {
                try {
                  await api('/profile/expose', { method: 'PATCH', body: { field_id: f.id, sub_id: subId, visible: !f.visible_to_sub } });
                  toast(f.visible_to_sub ? 'Hidden from this submissive' : 'Now visible to this submissive');
                  reload();
                } catch (err) { toastE(err); }
              }}>👁 {f.visible_to_sub ? 'Shown' : 'Hidden'}</button>
            <button className="small danger" onClick={async () => {
              if (!confirm("Delete this field from every submissive's profile? Its values are lost.")) return;
              try { await api(`/profile/fields/${f.id}`, { method: 'DELETE' }); toast('Field deleted'); reload(); }
              catch (err) { toastE(err); }
            }}>Delete</button>
          </div>
        </div>
      </div>
    );
  };

  return (
    <>
      <div className="card">
        <h2>About {subName}</h2>
        <p className="hint">Fields you create here are added to <b>every</b> submissive's profile automatically. Values and the 👁 visibility toggle are set per submissive here. A submissive can read — never edit — only the fields you have marked as shown.</p>
        <form onSubmit={(e) => {
          e.preventDefault();
          const f = e.target;
          api('/profile/fields', { method: 'POST', body: { label: f.label.value, kind: f.kind.value } })
            .then(() => { toast("Field added — it's now on every submissive's profile"); reload(); })
            .catch(toastE);
        }}>
          <div className="row">
            <label className="f" style={{ margin: 0, flex: 1, minWidth: 200 }}><span>New field</span>
              <input type="text" name="label" required maxLength={120} placeholder="e.g. Shoe size" /></label>
            <label className="f" style={{ margin: 0, width: 170 }}><span>Input type</span>
              <select name="kind"><option value="text">Single line</option><option value="multiline">Multi-line text</option><option value="photo">Photo</option></select></label>
            <button className="primary small" style={{ marginTop: 22 }} type="submit">Add field</button>
          </div>
        </form>
      </div>
      <div className="card">
        <h2>Profile fields</h2>
        {p.fields.length ? p.fields.map(fieldRow) : <div className="empty">No fields yet — add one above.</div>}
      </div>
    </>
  );
}