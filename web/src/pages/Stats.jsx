import { useEffect, useState } from 'react';
import { api } from '../api';
import { toast } from '../toast';
import LineChart, { LineLegend, tile } from '../components/Viz';

// Stats body shared by the submissive's own page and the Dom's sub detail tab.
// `rangeChange` refetches with the picket number of days.
export function StatsBody({ s, onRange, rangeDays }) {
  const t = s.tiles;
  return (
    <>
      <div className="filter-row">
        <label className="f" style={{ margin: 0 }}>
          <span>Time range</span>
          <select value={s.range_days} onChange={e => onRange && onRange(e.target.value)}>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="60">Last 60 days</option>
          </select>
        </label>
      </div>
      <div className="tiles">
        {tile('Check-in streak', s.streak === 1 ? '1 day' : `${s.streak} days`)}
        {tile('Avg mood · 7d', t.avg_mood_7d == null ? '—' : `${t.avg_mood_7d}/10`)}
        {tile('Avg day rating · 7d', t.avg_day_7d == null ? '—' : `${t.avg_day_7d}/10`)}
        {tile('Punishments', t.punishments_open ? `${t.punishments_open} open` : `${t.punishments_done} completed`)}
      </div>
      <div className="chart-zone">
        <div className="card">
          <h2>Mood &amp; day rating · last {s.range_days} days</h2>
          {s.checkins.length >= 2
            ? (<><LineChart checkins={s.checkins} /><LineLegend /></>)
            : <div className="empty">Need at least two check-ins to draw the chart.</div>}
        </div>
        <div className="card">
          <h2>Daily task completion · % of days in range</h2>
          <p className="hint">Only daily-frequency tasks count day by day. {s.taskRates.length ? '' : 'No daily tasks yet.'}</p>
          {s.taskRates.map(r => (
            <div className="hbar" key={r.id}>
              <div className="hbar-label">{r.title}</div>
              <div className="hbar-track"><div className="hbar-fill" style={{ width: `${Math.max(0, Math.min(100, r.pct))}%` }} /></div>
              <div className="hbar-val">{r.done} day{r.done === 1 ? '' : 's'} · {r.pct}%</div>
            </div>
          ))}
        </div>
      </div>
      <details className="viz-table">
        <summary>View check-in data as a table</summary>
        <table className="plain">
          <thead><tr><th>Date</th><th>Mood</th><th>Day rating</th></tr></thead>
          <tbody>
            {[...s.checkins].reverse().map(c => (
              <tr key={c.date}><td>{c.date}</td><td>{c.mood}/10</td><td>{c.day_rating}/10</td></tr>
            ))}
          </tbody>
        </table>
      </details>
    </>
  );
}

// submissive's own stats page.
export default function Stats() {
  const [s, setS] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api('/stats/me').then(setS).catch(e => setErr(e.message));
  }, []);
  if (err) return <div className="empty">{err}</div>;
  if (!s) return null;

  return <StatsBody s={s} onRange={(days) => api(`/stats/me?days=${days}`).then(setS).catch(e => toast(e.message, true))} />;
}
