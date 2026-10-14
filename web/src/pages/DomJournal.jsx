import { useEffect, useState, useRef } from 'react';
import { api } from '../api';
import { toast } from '../toast';
import Comments from '../components/Comments';
import { fmtDT } from '../format';
import { EntryForm, EntryCard } from './SubJournal';

// Dom's own journal: private entries, shared one submissive at a time.
export default function DomJournal() {
  const [mine, setMine] = useState(null);
  const [subs, setSubs] = useState([]);
  const [err, setErr] = useState('');
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    Promise.all([api('/entries'), api('/pair')])
      .then(([m, p]) => {
        if (!alive) return;
        setMine(m);
        setSubs((p && p.subs) || []);
      })
      .catch(e => alive && setErr(e.message));
    return () => { alive = false; };
  }, [tick]);

  if (err) return <div className="empty">{err}</div>;
  if (!mine) return null;
  const reload = () => setTick(t => t + 1);

  return (
    <>
      <div className="card">
        <h2>Write a journal entry</h2>
        <p className="hint">Entries start private. Share each one with the submissive of your choice — no other submissive can see it.</p>
        <EntryForm placeholder="Your private thoughts, instructions, reflections…" onSaved={reload} />
      </div>
      <div className="card">
        <h2>My entries</h2>
        {mine.entries.length
          ? mine.entries.map(e => <DomEntryCard key={e.id} e={e} subs={subs} reload={reload} />)
          : <div className="empty">No entries yet.</div>}
      </div>
    </>
  );
}

function DomEntryCard({ e, subs, reload }) {
  const selRef = useRef(null);
  return (
    <div className="item">
      {e.prompt_text ? <div className="muted">Re: {e.prompt_text}</div> : null}
      <div className="entry-body">{e.body}</div>
      <div className="entry-meta">{fmtDT(e.created_at)}</div>
      <div className="row" style={{ marginTop: 10 }}>
        <button className="small danger" onClick={() => {
          if (!confirm('Delete this entry?')) return;
          api(`/entries/${e.id}`, { method: 'DELETE' })
            .then(() => { toast('Entry deleted'); reload(); })
            .catch(err => toast(err.message, true));
        }}>Delete</button>
      </div>
      {subs.length ? <ShareRow e={e} subs={subs} reload={reload} selRef={selRef} /> : null}
      <Comments subject="entry" id={e.id} count={e.comment_count} />
    </div>
  );
}

function ShareRow({ e, subs, reload, selRef }) {
  const shared = e.shared_with || [];
  const sharedIds = shared.map(s => s.sub_id);
  const options = subs.filter(s => !sharedIds.includes(s.id));
  const share = () => {
    const sel = selRef.current;
    if (!sel || !sel.value) return toast('Choose a submissive to share with', true);
    api(`/entries/${e.id}`, { method: 'PATCH', body: { share_sub_id: sel.value } })
      .then(() => { toast('Shared with 1 submissive'); reload(); })
      .catch(err => toast(err.message, true));
  };
  return (
    <div className="row" style={{ marginTop: 10, flexWrap: 'wrap', gap: 8 }}>
      {shared.map(s => (
        <button key={s.sub_id} className="small" title={`Stop sharing with ${s.sub_name}`}
          onClick={() => {
            api(`/entries/${e.id}`, { method: 'PATCH', body: { unshare_sub_id: s.sub_id } })
              .then(() => { toast('Sharing stopped'); reload(); })
              .catch(err => toast(err.message, true));
          }}>✓ {s.sub_name} ✕</button>
      ))}
      {options.length ? (
        <>
          <select ref={selRef} style={{ maxWidth: 200 }} defaultValue="0">
            <option value="" disabled hidden>Share with…</option>
            {options.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <button className="small" onClick={share}>Share</button>
        </>
      ) : null}
    </div>
  );
}