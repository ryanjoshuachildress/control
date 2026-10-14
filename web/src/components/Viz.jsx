import { useEffect, useMemo, useRef, useState } from 'react';
import { fmtDateShort } from '../format';

// Palette validated against the app's dark surface #1d1d29.
export const VIZ = {
  s1: '#3987e5',     // Mood
  s2: '#d95926',     // Rate your day
  grid: '#2c2c2a',
  axis: '#383835',
  muted: '#898781'
};
export const VIZ_NAMES = { s1: 'Mood', s2: 'Day rating' };
const GEO = { W: 640, H: 260, L: 38, R: 52, T: 16, B: 30 };

export const tile = (label, value) => (
  <div className="tile">
    <div className="tile-label">{label}</div>
    <div className="tile-value">{value}</div>
  </div>
);

// Multi-series line chart with hover crosshair + tooltip, faithful port of the
// vanilla vizLine()/bindViz(): gridlines 2..10, sparse date ticks, end labels
// nudged apart when the last two points collide, tooltip listing every series.
export default function LineChart({ checkins }) {
  const n = checkins.length;
  const { W, H, L, R, T, B } = GEO;
  const pw = W - L - R;
  const ph = H - T - B;
  const x = (i) => L + (n === 1 ? pw / 2 : (i / (n - 1)) * pw);
  const y = (v) => T + (10 - v) / 9 * ph;

  const svgRef = useRef(null);
  const tipRef = useRef(null);
  const xhairRef = useRef(null);
  const [tip, setTip] = useState(null); // { left, date, mood, day_rating }

  const last = checkins[n - 1];
  const prev = checkins[n - 2];
  let ly1 = y(last.mood), ly2 = y(last.day_rating);
  if (Math.abs(ly1 - ly2) < 14) { const mid = (ly1 + ly2) / 2; ly1 = mid - 8; ly2 = mid + 8; }

  const path = (f) => checkins.map((c, i) => `${x(i).toFixed(1)},${y(f(c)).toFixed(1)}`).join(' ');

  function onMove(e) {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const vx = (e.clientX - rect.left) * (W / rect.width);
    let best = 0, bd = Infinity;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(x(i) - vx);
      if (d < bd) { bd = d; best = i; }
    }
    const px = x(best);
    if (xhairRef.current) {
      xhairRef.current.setAttribute('x1', px);
      xhairRef.current.setAttribute('x2', px);
      xhairRef.current.setAttribute('visibility', 'visible');
    }
    const vr = svg.getBoundingClientRect();
    let left = (px / W) * vr.width + 14;
    const tipW = tipRef.current ? tipRef.current.getBoundingClientRect().width : 110;
    if (left + tipW > vr.width - 8) left = (px / W) * vr.width - tipW - 14;
    setTip({ left: Math.max(4, left), ...checkins[best] });
  }
  function onLeave() {
    setTip(null);
    if (xhairRef.current) xhairRef.current.setAttribute('visibility', 'hidden');
  }

  return (
    <div className="viz">
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }}
        onPointerMove={onMove} onPointerLeave={onLeave}>
        {[2, 4, 6, 8, 10].map(v => (
          <line key={v} x1={L} y1={y(v)} x2={W - R} y2={y(v)} stroke={VIZ.grid} strokeWidth={1} />
        ))}
        <line x1={L} y1={y(1)} x2={W - R} y2={y(1)} stroke={VIZ.axis} strokeWidth={1} />
        {[2, 4, 6, 8, 10].map(v => (
          <text key={v} x={L - 8} y={y(v) + 4} textAnchor="end" fontSize={11} fill={VIZ.muted}>{v}</text>
        ))}
        {n >= 2 && (
          <>
            <text x={x(0)} y={H - 8} textAnchor="start" fontSize={11} fill={VIZ.muted}>{fmtDateShort(checkins[0].date)}</text>
            <text x={x(Math.floor((n - 1) / 2))} y={H - 8} textAnchor="middle" fontSize={11} fill={VIZ.muted}>{fmtDateShort(checkins[Math.floor((n - 1) / 2)].date)}</text>
            <text x={x(n - 1)} y={H - 8} textAnchor="end" fontSize={11} fill={VIZ.muted}>{fmtDateShort(checkins[n - 1].date)}</text>
          </>
        )}
        <polyline points={path(c => c.mood)} fill="none" stroke={VIZ.s1} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        <polyline points={path(c => c.day_rating)} fill="none" stroke={VIZ.s2} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {n >= 2 && (
          <>
            <circle cx={x(n - 1)} cy={y(last.mood)} r={4} fill={VIZ.s1} stroke="var(--bg-card)" strokeWidth={2} />
            <circle cx={x(n - 1)} cy={y(last.day_rating)} r={4} fill={VIZ.s2} stroke="var(--bg-card)" strokeWidth={2} />
            <circle cx={x(n - 2)} cy={y(prev.mood)} r={4} fill={VIZ.s1} stroke="var(--bg-card)" strokeWidth={2} />
            <circle cx={x(n - 2)} cy={y(prev.day_rating)} r={4} fill={VIZ.s2} stroke="var(--bg-card)" strokeWidth={2} />
          </>
        )}
        <text x={W - R + 7} y={ly1 + 4} fontSize={11} fill="var(--text-dim)">{last.mood}</text>
        <text x={W - R + 7} y={ly2 + 4} fontSize={11} fill="var(--text-dim)">{last.day_rating}</text>
        <line ref={xhairRef} x1={0} y1={T} x2={0} y2={H - B} stroke={VIZ.axis} strokeWidth={1} visibility="hidden" />
      </svg>
      {tip && (
        <div className="viz-tip" ref={tipRef} style={{ left: tip.left + 'px', top: 14 }} hidden={false}>
          <div className="viz-tip-date">{tip.date}</div>
          <div className="viz-tip-row">
            <span className="lkey s1" /><b>{tip.mood}</b><span>{VIZ_NAMES.s1}</span>
          </div>
          <div className="viz-tip-row">
            <span className="lkey s2" /><b>{tip.day_rating}</b><span>{VIZ_NAMES.s2}</span>
          </div>
        </div>
      )}
    </div>
  );
}

export function LineLegend() {
  return (
    <div className="viz-legend">
      <span className="lkey s1" />{VIZ_NAMES.s1}<span className="lkey s2" />{VIZ_NAMES.s2}
    </div>
  );
}