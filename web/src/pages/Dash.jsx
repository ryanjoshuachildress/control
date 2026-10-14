import { useEffect, useState } from 'react';
import { api } from '../api';
import { toast } from '../toast';
import { fmtDT } from '../format';

// Dom dashboard: invite code, submissives grid, recent completions/missed.
export default function Dash() {
  const [pair, setPair] = useState(null);
  const [events, setEvents] = useState(null);
  const [err, setErr] = useState('');
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    Promise.all([api('/pair'), api('/tasks/dom/events')])
      .then(([p, e]) => alive && (setPair(p), setEvents(e)))
      .catch(e => alive && setErr(e.message));
    return () => { alive = false; };
  }, [tick]);

  if (err) return <div className="empty">{err}</div>;
  if (!pair || !events) return null;
  const reload = () => setTick(t => t + 1);

  return (
    <>
      <div className="card">
        <h2>Invite code</h2>
        <p className="hint">Share this with a submissive — they enter it at registration or in Settings to pair with you.</p>
        <div className="code-box">
          <code id="inviteCode">{pair.invite_code || '—'}</code>
          <button className="small" onClick={(e) => {
            const code = e.target.closest('.code-box').querySelector('code');
            navigator.clipboard && navigator.clipboard.writeText(code.textContent)
              .then(() => toast('Copied')).catch(() => toast('Copy failed', true));
          }}>Copy</button>
        </div>
      </div>
      <div className="card">
        <h2>My submissives</h2>
        {pair.subs.length ? (
          <div className="subs-grid">
            {pair.subs.map(s => (
              <a className="sub-card" key={s.id} href={`#/sub/${s.id}/tasks`}>
                <div className="name">{s.name}</div>
                <div className="muted">{s.title || '—'} · {s.timezone}</div>
              </a>
            ))}
          </div>
        ) : <div className="empty">No submissives paired yet.</div>}
      </div>
      <div className="grid2">
        <div className="card">
          <h2>Recent completions</h2>
          {events.completions.length ? (
            <table className="plain"><tbody>
              {events.completions.map(c => (
                <tr key={c.id}>
                  <td>{c.completed_at ? fmtDT(c.completed_at) : ''}</td>
                  <td><a href={`#/sub/${c.sub_id}/tasks`}>{c.sub_name}</a></td>
                  <td><span className="chip good">completed</span> {c.task_title} <span className="tiny">({c.period_key})</span></td>
                </tr>
              ))}
            </tbody></table>
          ) : <div className="empty">Nothing yet.</div>}
        </div>
        <div className="card">
          <h2>Missed deadlines</h2>
          {events.missed.length ? (
            <table className="plain"><tbody>
              {events.missed.map(m => (
                <tr key={m.id}>
                  <td>{m.sent_at ? fmtDT(m.sent_at) : ''}</td>
                  <td><a href={`#/sub/${m.sub_id}/tasks`}>{m.sub_name}</a></td>
                  <td><span className="chip bad">missed</span> {m.task_title} <span className="tiny">({m.period_key})</span></td>
                </tr>
              ))}
            </tbody></table>
          ) : <div className="empty">Nothing yet — good.</div>}
        </div>
      </div>
    </>
  );
}