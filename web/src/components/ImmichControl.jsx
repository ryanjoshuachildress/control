import { useState, useRef, useEffect } from 'react';
import { api } from '../api';
import { fmtDate } from '../format';
import { getImmichOrigin } from '../user';

// Link-from-Immich control: paste asset URLs/ids, or browse the library around
// a date. Selected ids surface via getIds() for the parent form to submit in
// the `immich` field. Hidden when no Immich integration is configured.
const immichIdsFromText = (text) => String(text || '').match(/[0-9a-fA-F-]{20,}/g) || [];

// Shifts a YYYY-MM-DD key by whole days.
export const fmtDateShortShift = (dateStr, days) => {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export default function ImmichControl({ max = 0, value = '', onChange, dateRef, fixedDate }) {
  const immichOrigin = getImmichOrigin();
  const ctlRef = useRef(null);
  const [selected, setSelected] = useState(() => new Set(String(value || '').split(',').filter(Boolean)));
  const [gridOpen, setGridOpen] = useState(false);
  const [grid, setGrid] = useState(null); // { items, center, err }
  const pasteRef = useRef(null);

  // keep parent's hidden value in sync the way the vanilla hidden input did
  useEffect(() => {
    onChange && onChange([...selected].join(','));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  if (!immichOrigin) return null;

  async function load(centerDate) {
    setGridOpen(true);
    setGrid({ loading: true });
    const base = new Date(`${centerDate}T00:00:00`);
    const start = new Date(base.getTime() - 24 * 3600 * 1000).toISOString();
    const end = new Date(base.getTime() + 2 * 24 * 3600 * 1000).toISOString();
    try {
      const d = await api(`/immich/search?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&size=120`);
      setGrid({ items: d.items, center: centerDate });
    } catch (e) {
      setGrid({ err: e.message });
    }
  }

  function browse() {
    if (gridOpen) { setGridOpen(false); return; }
    const dateInput = dateRef ? dateRef.current : null;
    const base = fixedDate || (dateInput && dateInput.value) || new Date().toISOString().slice(0, 10);
    load(base);
  }

  function toggle(id, el) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else {
        if (max === 1) next.clear();
        next.add(id);
      }
      return next;
    });
  }

  function del(id) {
    setSelected(prev => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  return (
    <div className="f immich-ctl" data-immich-ctl ref={ctlRef}>
      <span>From Immich <span className="tiny">(paste an Immich photo URL, or Browse{max ? ' — one' : ''})</span></span>
      <input type="text" ref={pasteRef} className="immich-paste"
        placeholder={`${immichOrigin}/photos/<asset id>`}
        onBlur={(e) => {
          const ids = immichIdsFromText(e.target.value);
          if (ids.length) setSelected(prev => max === 1 ? new Set(ids.slice(-1)) : new Set([...prev, ...ids]));
          e.target.value = '';
        }} />
      <div className="immich-chips">
        {[...selected].length
          ? [...selected].map(id => (
            <span className="att chip-immich" key={id}>
              <img src={`/api/immich/pick/${id}/thumb`} alt="" />
              <button className="xsmall ghost" onClick={() => del(id)} title="Remove">✕</button>
            </span>
          ))
          : <span className="tiny">No Immich assets selected.</span>}
      </div>
      <div className="row">
        <button className="small" type="button" onClick={browse}>Browse library</button>
        <span className="tiny">Files stay in Immich — Control links them, keys stay server-side.</span>
      </div>
      {gridOpen && (
        <div className="immich-grid">
          {grid && grid.loading && <div className="tiny" style={{ gridColumn: '1/-1' }}>Loading Immich…</div>}
          {grid && grid.err && <div className="tiny" style={{ gridColumn: '1/-1' }}>{grid.err}</div>}
          {grid && grid.items !== undefined && (
            <div className="row" style={{ gridColumn: '1/-1', marginBottom: 4 }}>
              <button className="small ghost" type="button"
                onClick={() => load(fmtDateShortShift(grid.center, -7))}>‹ 7 days earlier</button>
              <span className="tiny">{fmtDate(grid.center)} · {grid.items.length} assets near this date</span>
              <button className="small ghost" type="button"
                onClick={() => load(fmtDateShortShift(grid.center, 7))}>7 days later ›</button>
            </div>
          )}
          {grid && grid.items !== undefined && (grid.items.length
            ? grid.items.map(a => (
              <button type="button" key={a.id}
                className={'immich-item' + (selected.has(a.id) ? ' on' : '')}
                onClick={(e) => toggle(a.id, e.currentTarget)}>
                <img src={`/api/immich/pick/${a.id}/thumb`} alt="" loading="lazy" />
                {a.media === 'video' && <span className="immich-vid">▶</span>}
              </button>
            ))
            : <div className="tiny" style={{ gridColumn: '1/-1' }}>No Immich assets in this window.</div>)}
        </div>
      )}
    </div>
  );
}