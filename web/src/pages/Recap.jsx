import { useEffect, useState } from 'react';
import { api } from '../api';
import { fmtDate, fmtDateShort, peopleLabel, MONTH_NAMES } from '../format';
import { useRoute } from '../router';
import { tile } from '../components/Viz';

// Yearly / monthly roll-up of the household's recorded moments.
export default function Recap() {
  const route = useRoute();
  const mode = route.query.get('mode') === 'month' ? 'month' : 'year';
  const year = /^\d{4}$/.test(route.query.get('year') || '') ? route.query.get('year') : String(new Date().getFullYear());
  const month = route.query.get('month') || String(new Date().getMonth() + 1);
  const [r, setR] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    api(`/moments/recap?year=${encodeURIComponent(year)}&mode=${encodeURIComponent(mode)}&month=${encodeURIComponent(month)}`)
      .then(setR)
      .catch(e => setErr(e.message));
  }, [year, mode, month]);

  if (err) return <div className="empty">{err}</div>;
  if (!r) return null;

  const maxN = r.buckets.length ? Math.max(...r.buckets.map(b => b.n)) : 0;
  const histLabel = (b) => mode === 'month'
    ? `${MONTH_NAMES[Number(month) - 1]} ${Number(b.bucket)}`
    : MONTH_NAMES[b.bucket - 1].slice(0, 3);
  const scopeLine = mode === 'month' ? `${MONTH_NAMES[Number(month) - 1]} ${year}` : `the year ${year}`;
  const setParam = (k, v) => {
    const p = new URLSearchParams(route.query.toString());
    p.set(k, v);
    location.hash = '#/recap?' + p.toString();
  };

  return (
    <>
      <div className="card">
        <h2>Moments recap</h2>
        <p className="hint">{r.total} moment{r.total === 1 ? '' : 's'} recorded in {scopeLine}{mode === 'year' ? ' — use the controls below for a single month' : ''}.</p>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <label className="f" style={{ margin: 0, width: 120 }}>
            <span>View</span>
            <select id="recapMode" value={mode} onChange={e => setParam('mode', e.target.value)}>
              <option value="year">Whole year</option>
              <option value="month">One month</option>
            </select>
          </label>
          <label className="f" style={{ margin: 0, width: 120 }}>
            <span>Year</span>
            <select id="recapYear" value={year} onChange={e => setParam('year', e.target.value)}>
              {(r.years || []).length
                ? r.years.map(y => <option key={y} value={y}>{y}</option>)
                : <option value={year}>{year}</option>}
            </select>
          </label>
          <label className="f" style={{ margin: 0, width: 170, visibility: mode === 'month' ? 'visible' : 'hidden' }}>
            <span>Month</span>
            <select id="recapMonth" value={String(Number(month))} disabled={mode !== 'month'}
              onChange={e => setParam('month', e.target.value)}>
              {MONTH_NAMES.map((n, i) => <option key={n} value={i + 1}>{n}</option>)}
            </select>
          </label>
        </div>
      </div>
      <div className="tiles">
        {tile('Moments recorded', r.total)}
        {tile('Would do again', r.again_pct == null ? '—' : `${r.again_pct}%`)}
        {tile('Avg originality', r.avg.originality == null ? '—' : `${r.avg.originality}/5`)}
        {tile('Avg hotness', r.avg.hotness == null ? '—' : `${r.avg.hotness}/5`)}
        {tile('Avg surprise', r.avg.surprise == null ? '—' : `${r.avg.surprise}/5`)}
        {tile('Avg connection', r.avg.connection == null ? '—' : `${r.avg.connection}/5`)}
      </div>
      <div className="card">
        <h2>{mode === 'month' ? 'Spread over the month' : 'Spread over the year'}</h2>
        {r.buckets.length ? r.buckets.map(b => (
          <div className="hbar" key={b.bucket}>
            <div className="hbar-label">{histLabel(b)}</div>
            <div className="hbar-track"><div className="hbar-fill" style={{ width: `${maxN ? Math.round(b.n / maxN * 100) : 0}%` }} /></div>
            <div className="hbar-val">{b.n} moment{b.n === 1 ? '' : 's'}</div>
          </div>
        )) : <div className="empty">No moments in {scopeLine} yet.</div>}
      </div>
      {!!((r.tags || []).length) && (
        <div className="card">
          <h2>Tags used</h2>
          <div className="row">{r.tags.map(t => <span className="tagchip" key={t.name}>{t.name} · {t.n}</span>)}</div>
        </div>
      )}
      {!!((r.people || []).length) && (
        <div className="card">
          <h2>Who was in them</h2>
          {r.people.map(p => (
            <div className="row spread" key={p.id} style={{ padding: '6px 0', borderBottom: '1px solid var(--line-soft)' }}>
              <div>{peopleLabel(p)}</div>
              <span className="tiny">{p.n} moment{p.n === 1 ? '' : 's'}</span>
            </div>
          ))}
        </div>
      )}
      {!!(r.top || []).length && (
        <div className="card">
          <h2>Top rated</h2>
          {r.top.map(t => (
            <div className="item spread" key={t.id}>
              <div><div className="title">{t.title}</div><div className="tiny">{fmtDate(t.date)}</div></div>
              <span className="rating">
                <span className="stars-ro">{'★'.repeat(Math.round(t.avg))}{'☆'.repeat(5 - Math.round(t.avg))}</span> <b>{t.avg}</b>
              </span>
            </div>
          ))}
          <div className="tiny" style={{ marginTop: 8 }}><a href="#/moments">Open the moments →</a></div>
        </div>
      )}
    </>
  );
}