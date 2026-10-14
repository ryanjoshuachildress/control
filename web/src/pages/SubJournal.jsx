import { useEffect, useState } from 'react';
import { api } from '../api';
import { toast } from '../toast';
import Comments from '../components/Comments';
import { fmtDT } from '../format';

// submissive journal: prompts to answer, entries from the Dom, own entries.
export default function SubJournal() {
  const [state, setState] = useState(null);
  const [err, setErr] = useState('');
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    Promise.all([api('/prompts'), api('/entries'), api('/entries/from-dom')])
      .then(([promptsData, mine, fromDom]) => alive && setState({ promptsData, mine, fromDom }))
      .catch(e => alive && setErr(e.message));
    return () => { alive = false; };
  }, [tick]);

  if (err) return <div className="empty">{err}</div>;
  if (!state) return null;
  const { promptsData, mine, fromDom } = state;
  const daily = promptsData.prompts.filter(p => p.kind === 'daily');
  const weekly = promptsData.prompts.filter(p => p.kind === 'weekly');
  const reload = () => setTick(t => t + 1);

  const entryForm = (promptId, placeholder) => (
    <EntryForm promptId={promptId} placeholder={placeholder} onSaved={reload} />
  );

  return (
    <>
      {!promptsData.dom && (
        <div className="card"><h2>Journal</h2>
          <p className="hint">Pair with a Dominant to receive daily and weekly journal prompts.</p>
        </div>
      )}
      {!!daily.length && <div className="card"><h2>Today's prompts</h2>{daily.map(p => <PromptCard key={p.id} p={p} onSaved={reload} />)}</div>}
      {!!weekly.length && <div className="card"><h2>This week's prompts</h2>{weekly.map(p => <PromptCard key={p.id} p={p} onSaved={reload} />)}</div>}
      {!!fromDom.entries.length && (
        <div className="card"><h2>From your Dominant</h2>{fromDom.entries.map(e => <EntryCard key={e.id} e={e} />)}</div>
      )}
      <div className="card">
        <h2>My entries</h2>
        <div style={{ marginBottom: 16 }}>{entryForm(null, 'Free-write — anything on your mind…')}</div>
        {mine.entries.length
          ? mine.entries.map(e => <EntryCard key={e.id} e={e} />)
          : <div className="empty">No entries yet.</div>}
      </div>
    </>
  );
}

function EntryForm({ promptId, placeholder, onSaved, domEntry, children }) {
  const [body, setBody] = useState('');
  return (
    <form data-form="entry" onSubmit={(e) => {
      e.preventDefault();
      api('/entries', { method: 'POST', body: { prompt_id: promptId || null, body } })
        .then(() => { toast('Entry saved'); setBody(''); onSaved && onSaved(); })
        .catch(err => toast(err.message, true));
    }}>
      <label className="f">
        <textarea maxLength={8000} placeholder={placeholder || 'Write your entry…'} required
          value={body} onChange={e => setBody(e.target.value)} />
      </label>
      <button className="primary small" type="submit">Save entry</button>
      {children}
    </form>
  );
}

function PromptCard({ p, onSaved }) {
  return (
    <div className="item">
      <div className="spread">
        <div className="title">{p.text}</div>
        <span className="chip acc">{p.kind}</span>
      </div>
      <div style={{ marginTop: 12 }}>
        <EntryForm promptId={p.id} onSaved={onSaved} />
      </div>
    </div>
  );
}

export function EntryCard({ e }) {
  return (
    <div className="item">
      {e.prompt_text ? <div className="muted">Prompt: {e.prompt_text}</div> : null}
      <div className="entry-body">{e.body}</div>
      <div className="entry-meta">{fmtDT(e.created_at)}</div>
      <Comments subject="entry" id={e.id} count={e.comment_count} />
    </div>
  );
}

export { EntryForm };