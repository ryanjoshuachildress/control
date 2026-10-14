import { useState } from 'react';

// Editable 1–5 star row: click to set, click again to clear, everything up to
// the chosen star lights up. Unrated rows flagged red in place by the save
// handler (stars.miss class).
export function StarsInput({ name, label, initial }) {
  const [value, setValue] = useState(Number(initial) || null);
  const [miss, setMiss] = useState(false);
  const out = value ? `${value} / 5` : '—';
  return (
    <div className="star-field" style={{ minWidth: 150, flex: 1 }}>
      <span className="tiny">{label}</span>
      <span
        className={'stars' + (miss ? ' miss' : '')}
        data-stars={name}
        data-value={value || ''}
        title="Click to rate"
        onClick={() => setMiss(false)}
      >
        {[1, 2, 3, 4, 5].map(n => (
          <span key={n} className={'star' + (value && n <= value ? ' on' : '')} data-v={n}
            onClick={(e) => {
              e.preventDefault();
              setValue(v => (n === v ? null : n));
            }} title={`${n} of 5`}>★</span>
        ))}
        <span className="star-out tiny">{out}</span>
      </span>
    </div>
  );
}

// Read-only display: filled vs empty stars.
export function starsDisp(v) {
  const n = Number(v);
  if (!n) return <span className="stars-ro off">—</span>;
  return <span className="stars-ro">{'★'.repeat(n)}{'☆'.repeat(5 - n)}</span>;
}

// Reads the four rating values from a StarsInput group rendered inside `form`.
export function collectStars(form, names) {
  const out = {};
  let missing = 0;
  for (const k of names) {
    const w = form.querySelector(`.stars[data-stars="${k}"]`);
    if (!w || !w.dataset.value) { if (w) w.classList.add('miss'); missing++; }
    else out[k] = w.dataset.value;
  }
  return { out, missing };
}