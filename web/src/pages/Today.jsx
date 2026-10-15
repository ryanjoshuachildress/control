import { useEffect, useState, useRef } from 'react';
import { api, upload } from '../api';
import { toast } from '../toast';
import Comments from '../components/Comments';
import ImmichControl from '../components/ImmichControl';
import { fmtDate, fmtDT, FREQ_LABEL, MOOD_WORDS } from '../format';

let routeRef = null;

// Submissive "Today" screen: pair card, open punishments, tasks, check-in.
export default function Today() {
  const [state, setState] = useState(null);
  const [err, setErr] = useState('');
  const [tick, setTick] = useState(0); // re-fetch after any action

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [data, checkin] = await Promise.all([api('/tasks/today'), api('/checkins/today')]);
        let pun = { open: [], recent: [] };
        if (data.paired) pun = await api('/punishments/mine');
        if (alive) setState({ data, checkin, pun });
      } catch (e) { if (alive) setErr(e.message); }
    })();
    return () => { alive = false; };
  }, [tick]);

  if (err) return <div className="empty">{err}</div>;
  if (!state) return null;
  const { data, checkin, pun } = state;
  const reload = () => setTick(t => t + 1);

  return (
    <>
      {!data.paired && <PairCard onDone={reload} />}
      {!!pun.open.length && <Punishments pun={pun} reload={reload} />}
      <div className="card">
        <h2>Tasks</h2>
        <p className="hint">{data.tasks.length ? '' : 'No tasks assigned yet.'}</p>
        {data.tasks.filter(t => !t.done).map(t => <TaskCard key={t.id} t={t} reload={reload} />)}
        {data.tasks.some(t => t.done) && (
          <div style={{ marginTop: 18 }}>
            <div className="muted" style={{ marginBottom: 8 }}>Completed today</div>
            {data.tasks.filter(t => t.done).map(t => <TaskCard key={t.id} t={t} reload={reload} />)}
          </div>
        )}
      </div>
      <CheckinCard checkin={checkin} data={data} reload={reload} />
    </>
  );
}

function PairCard({ onDone }) {
  const [code, setCode] = useState('');
  return (
    <div className="card">
      <h2>Pair with your Dominant</h2>
      <p className="hint">Enter the invite code they gave you (or do it later in Settings).</p>
      <form className="row" onSubmit={(e) => {
        e.preventDefault();
        api('/pair', { method: 'POST', body: { code } })
          .then(() => { toast('Paired'); location.hash = '#/today'; onDone(); })
          .catch(err => toast(err.message, true));
      }}>
        <input type="text" placeholder="CTRL-…" style={{ maxWidth: 240 }} required
          value={code} onChange={e => setCode(e.target.value)} />
        <button className="primary" type="submit">Pair</button>
      </form>
    </div>
  );
}

function TaskCard({ t, reload }) {
  const [immichVal, setImmichVal] = useState('');
  const fileRef = useRef(null);
  const dateRef = useRef(null);

  const checkoff = () => {
    api(`/tasks/${t.id}/complete`, { method: 'POST', body: { method: 'checkoff' } })
      .then(() => { toast('Completed — your Dominant has been notified'); reload(); })
      .catch(e => toast(e.message, true));
  };

  const submitEvidence = async (e) => {
    e.preventDefault();
    const input = fileRef.current;
    if (!input.files.length && !immichVal.trim()) return toast('Choose a photo/video or link one from Immich', true);
    const fd = new FormData();
    if (input.files.length) fd.append('evidence', input.files[0]);
    if (immichVal.trim()) fd.append('immich', immichVal.trim());
    fd.append('note', e.target.note ? e.target.note.value : '');
    fd.append('method', 'evidence');
    try {
      await upload(`/tasks/${t.id}/complete`, fd);
      toast('Task completed with evidence — your Dominant has been notified');
      reload();
    } catch (err) { toast(err.message, true); }
  };

  return (
    <div className="item" data-task={t.id}>
      <div className="spread">
        <div>
          <div className="title">{t.title}</div>
          {t.description ? <div className="muted">{t.description}</div> : null}
        </div>
        <span className="chip">{t.due_date ? `Due ${fmtDate(t.due_date)}` : (FREQ_LABEL[t.frequency] || t.frequency)}</span>
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        {t.done ? (
          <>
            <span className="done-badge">✓ Completed</span>
            <span className="tiny">{t.method === 'evidence' ? 'with evidence' : 'checked off'}{t.completed_at ? ' · ' + fmtDT(t.completed_at) : ''}</span>
          </>
        ) : t.completion_mode === 'checkoff' ? (
          <button className="primary small" onClick={checkoff}>Mark complete</button>
        ) : (
          <form data-form="evidence" onSubmit={submitEvidence} className="row" style={{ alignItems: 'flex-start', gap: 14, width: '100%' }}>
            <label className="f fileinput" style={{ margin: 0, flex: 1, minWidth: 210 }}>
              <span>Photo / video evidence</span>
              <input type="file" name="evidence" accept="image/*,video/*" ref={fileRef} />
            </label>
            <div style={{ flex: 1, minWidth: 220 }}>
              <ImmichControl max={1} value="" onChange={setImmichVal} dateRef={dateRef} />
            </div>
            <label className="f" style={{ margin: 0, flex: 1, minWidth: 180 }}>
              <span>Note (optional)</span><input type="text" name="note" maxLength={500} />
            </label>
            <button className="primary small" type="submit" style={{ marginTop: 22 }}>Submit evidence</button>
          </form>
        )}
      </div>
      <Comments subject="task" id={t.id} count={t.comment_count} />
    </div>
  );
}

function Punishments({ pun, reload }) {
  return (
    <div className="card punish-card">
      <h2>Punishments</h2>
      <p className="hint">Open punishments from your Dominant — complete these first.</p>
      {pun.open.map(p => <PunishCard key={p.id} p={p} reload={reload} />)}
      {pun.recent.length ? (
        <div className="tiny" style={{ marginTop: 10 }}>
          Recently closed: {pun.recent.slice(0, 3).map(r => `${r.title} (${r.status})`).join(' · ')}
        </div>
      ) : null}
    </div>
  );
}

function PunishCard({ p, reload }) {
  const [immichVal, setImmichVal] = useState('');
  const fileRef = useRef(null);
  const dateRef = useRef(null);

  const checkoff = () => {
    api(`/punishments/${p.id}/complete`, { method: 'POST', body: { method: 'checkoff' } })
      .then(() => { toast('Punishment completed — your Dominant has been notified'); reload(); })
      .catch(e => toast(e.message, true));
  };

  const submitEvidence = async (e) => {
    e.preventDefault();
    const input = fileRef.current;
    if (!input.files.length && !immichVal.trim()) return toast('Choose a photo/video or link one from Immich', true);
    const fd = new FormData();
    if (input.files.length) fd.append('evidence', input.files[0]);
    if (immichVal.trim()) fd.append('immich', immichVal.trim());
    fd.append('note', e.target.note ? e.target.note.value : '');
    fd.append('method', 'evidence');
    try {
      await upload(`/punishments/${p.id}/complete`, fd);
      toast('Punishment completed — your Dominant has been notified');
      reload();
    } catch (err) { toast(err.message, true); }
  };

  return (
    <div className="item">
      <div className="spread">
        <div>
          <div className="title">{p.title}</div>
          {p.description ? <div className="muted">{p.description}</div> : null}
          <div className="tiny">Due within 24 hours of assignment{p.auto_task_id ? ' · auto-assigned for a missed task' : ''}</div>
        </div>
        <span className="chip bad">punishment</span>
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        {p.completion_mode === 'checkoff' ? (
          <button className="primary small" onClick={checkoff}>Mark complete</button>
        ) : (
          <form onSubmit={submitEvidence} className="row" style={{ alignItems: 'flex-start', gap: 14, width: '100%' }}>
            <label className="f fileinput" style={{ margin: 0, flex: 1, minWidth: 210 }}>
              <span>Photo / video evidence</span>
              <input type="file" name="evidence" accept="image/*,video/*" ref={fileRef} />
            </label>
            <div style={{ flex: 1, minWidth: 220 }}>
              <ImmichControl max={1} value="" onChange={setImmichVal} dateRef={dateRef} />
            </div>
            <label className="f" style={{ margin: 0, flex: 1, minWidth: 180 }}>
              <span>Note (optional)</span><input type="text" name="note" maxLength={500} />
            </label>
            <button className="primary small" type="submit" style={{ marginTop: 22 }}>Submit evidence</button>
          </form>
        )}
      </div>
      <Comments subject="punishment" id={p.id} count={p.comment_count} />
    </div>
  );
}

// Mood words shown live next to the range input (kept from vanilla updateScales)

function CheckinCard({ checkin, data, reload }) {
  const has = checkin.checkin;
  const [mood, setMood] = useState(has ? has.mood : 5);
  const [rating, setRating] = useState(has ? has.day_rating : 5);
  const [best, setBest] = useState(has ? has.best_part : '');
  const [worst, setWorst] = useState(has ? has.worst_part : '');
  const [notes, setNotes] = useState(has ? has.sexual_notes : '');

  const submit = (e) => {
    e.preventDefault();
    api('/checkins', { method: 'POST', body: {
      mood: Number(mood), day_rating: Number(rating),
      best_part: best, worst_part: worst, sexual_notes: notes
    } })
      .then(() => { toast('Check-in saved — your Dominant can see it'); reload(); })
      .catch(err => toast(err.message, true));
  };

  return (
    <div className="card" id="checkinCard">
      <h2>Daily check-in</h2>
      <p className="hint">{fmtDate(checkin.date || data.date)}{has ? ' — already submitted; you can update it' : ''}</p>
      <form onSubmit={submit}>
        <label className="f"><span>How is your mood today?</span>
          <input type="range" min={1} max={10} value={mood} onChange={e => setMood(e.target.value)} />
          <div className="scale-out">{mood} · {MOOD_WORDS[mood - 1]}</div>
          <div className="scale-vals"><span>1 Terrible</span><span>10 Blissful</span></div>
        </label>
        <label className="f"><span>Rate your day</span>
          <input type="range" min={1} max={10} value={rating} onChange={e => setRating(e.target.value)} />
          <div className="scale-out">{rating} · {MOOD_WORDS[rating - 1]}</div>
          <div className="scale-vals"><span>1 Rough</span><span>10 Wonderful</span></div>
        </label>
        <label className="f"><span>Best part of your day</span>
          <textarea maxLength={2000} value={best} onChange={e => setBest(e.target.value)} /></label>
        <label className="f"><span>Worst part of your day</span>
          <textarea maxLength={2000} value={worst} onChange={e => setWorst(e.target.value)} /></label>
        <label className="f"><span>Something sexual you thought about or did today</span>
          <textarea maxLength={4000} value={notes} onChange={e => setNotes(e.target.value)} /></label>
        <button className="primary" type="submit">{has ? 'Update check-in' : 'Submit check-in'}</button>
      </form>
      {has && <Comments subject="checkin" id={has.id} count={has.comment_count} />}
    </div>
  );
}