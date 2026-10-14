import { useEffect, useState, useRef } from 'react';
import { api, upload } from '../api';
import { useUser } from '../user';
import { toast } from '../toast';
import Comments from '../components/Comments';
import ImmichControl from '../components/ImmichControl';
import { Media } from '../components/Media';
import { fmtDT, MOOD_WORDS, peopleLabel } from '../format';

const KIND_CHIP = {
  checkin: ['', 'Check-in'],
  task: ['acc', 'Task completed'],
  punishment: ['bad', 'Punishment completed'],
  entry: ['', 'Journal']
};

// Household feed for both roles: composer + merged stream.
export default function Feed() {
  const { user } = useUser();
  const [subs, setSubs] = useState([]);
  const [items, setItems] = useState(null);
  const [err, setErr] = useState('');
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const jobs = [api('/feed')];
        if (user.role === 'dom') jobs.push(api('/pair'));
        const [f, p] = await Promise.all(jobs);
        if (!alive) return;
        setItems(f.items);
        setSubs((p && p.subs) || []);
      } catch (e) { alive && setErr(e.message); }
    })();
    return () => { alive = false; };
  }, [tick, user.role]);

  if (err) return <div className="empty">{err}</div>;
  if (items === null) return null;
  const reload = () => setTick(t => t + 1);

  return (
    <>
      <Composer user={user} subs={subs} reload={reload} />
      <div className="card">
        <h2>Feed</h2>
        {items.length
          ? items.map(it => <FeedCard key={it.kind + it.id} it={it} user={user} reload={reload} />)
          : <div className="empty">No posts yet — write the first one.</div>}
      </div>
    </>
  );
}

function Composer({ user, subs, reload }) {
  const isDom = user.role === 'dom';
  const crossOk = !isDom && user.household_interaction;
  const fileRef = useRef(null);
  const [body, setBody] = useState('');
  const [immichVal, setImmichVal] = useState('');
  const [audience, setAudience] = useState(isDom ? 'all' : (crossOk ? 'household' : 'dom'));
  const [targets, setTargets] = useState({});

  const post = async (e) => {
    e.preventDefault();
    const files = [...fileRef.current.files];
    if (!body.trim() && !files.length && !immichVal.trim()) return toast('Write something or attach a photo/video', true);
    const fd = new FormData();
    fd.append('body', body);
    if (immichVal.trim()) fd.append('immich', immichVal.trim());
    if (isDom) {
      const chosen = audience === 'chosen';
      const picked = Object.keys(targets).filter(k => targets[k]);
      if (chosen) {
        if (!picked.length) return toast('Pick at least one submissive, or choose Everyone', true);
        for (const t of picked) fd.append('target_sub_ids', t);
      } else fd.append('target_all', '1');
    } else if (audience === 'household') {
      fd.append('audience', 'household');
    }
    for (const file of files) fd.append('media', file);
    try {
      await upload('/feed', fd);
      toast('Posted');
      reload();
    } catch (err) { toast(err.message, true); }
  };

  return (
    <div className="card">
      <h2>{isDom ? 'Post to your household' : 'Write to your Dominant'}</h2>
      {isDom && !subs.length && <p className="hint">No submissives paired yet — posts stay visible to you only.</p>}
      <form onSubmit={post} data-form="feed-post">
        <label className="f">
          <textarea maxLength={8000}
            placeholder={isDom ? 'Something for your submissives…' : 'Only your Dominant will see this…'}
            value={body} onChange={e => setBody(e.target.value)} />
        </label>
        <label className="f"><span>Photos or videos (up to 10, 512 MB each)</span>
          <input type="file" name="media" multiple
            accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/webm,video/quicktime,video/x-m4v"
            ref={fileRef} /></label>
        <ImmichControl value="" onChange={setImmichVal} />
        {isDom && (
          <div className="feed-audience">
            <label className="row">
              <input type="radio" name="audience" value="all" checked={audience === 'all'}
                onChange={() => setAudience('all')} style={{ width: 'auto' }} />
              <span style={{ margin: 0 }}>Everyone — all {subs.length} submissive{subs.length === 1 ? '' : 's'}</span>
            </label>
            <label className="row">
              <input type="radio" name="audience" value="chosen" checked={audience === 'chosen'}
                onChange={() => setAudience('chosen')} style={{ width: 'auto' }} />
              <span style={{ margin: 0 }}>Choose below</span>
            </label>
            <div className="feed-targets">
              {subs.length
                ? subs.map(s => (
                  <label key={s.id} className="chip-target">
                    <input type="checkbox" disabled={audience !== 'chosen'}
                      checked={!!targets[s.id]}
                      onChange={e => setTargets(t => ({ ...t, [s.id]: e.target.checked }))} />
                    {s.title ? s.title + ' ' + s.name : s.name}
                  </label>
                ))
                : <span className="tiny">No submissives paired yet.</span>}
            </div>
          </div>
        )}
        {!isDom && crossOk && (
          <div className="feed-audience">
            <label className="row">
              <input type="radio" name="audience" value="household" checked={audience === 'household'}
                onChange={() => setAudience('household')} style={{ width: 'auto' }} />
              <span style={{ margin: 0 }}>Everyone in the household <span className="tiny">(submissives can see it too)</span></span>
            </label>
            <label className="row">
              <input type="radio" name="audience" value="dom" checked={audience === 'dom'}
                onChange={() => setAudience('dom')} style={{ width: 'auto' }} />
              <span style={{ margin: 0 }}>Only my Dominant</span>
            </label>
          </div>
        )}
        <button className="primary" type="submit">Post</button>
      </form>
      <p className="hint">
        {isDom
          ? '“Everyone” broadcasts to the submissives paired right when you post — submissives who join later do not see it.'
          : crossOk
            ? 'Your Dominant lets the submissives see each other — choose who receives this post.'
            : 'Only your Dominant can see what you post here.'}
      </p>
    </div>
  );
}

function FeedCard({ it, user, reload }) {
  const isDomView = user.role === 'dom';
  const author = `${it.author_title ? it.author_title + ' ' : ''}${it.author_name}`;

  let chip;
  if (it.kind === 'post') {
    const label = it.author_role === 'sub' ? 'Household note'
      : isDomView ? 'Your note' : 'From your Dominant';
    chip = <span className="chip acc">{label}</span>;
  } else if (it.kind === 'entry' && it.author_role === 'dom') {
    chip = <span className="chip acc">Journal · from your Dominant</span>;
  } else {
    const [cls, label] = KIND_CHIP[it.kind];
    chip = <span className={'chip ' + cls}>{label}</span>;
  }

  const meta = [];
  if (it.kind === 'checkin') meta.push(`${it.date}`);
  const del = it.can_delete ? (
    <button className="small danger" onClick={() => {
      if (!confirm('Delete this post and its comments?')) return;
      api(`/feed/${it.id}`, { method: 'DELETE' })
        .then(() => { toast('Post deleted'); reload(); })
        .catch(e => toast(e.message, true));
    }}>Delete</button>
  ) : null;

  let body = null;
  if (it.kind === 'checkin') {
    body = (
      <>
        <span className="chip good" style={{ marginRight: 6 }}>Mood · {MOOD_WORDS[(it.mood || 1) - 1] || it.mood}</span>
        <span className="chip good">Day · {it.day_rating}/10</span>
        <div style={{ marginTop: 8 }}>
          {it.best_part && <div className="entry-body"><span className="tiny">Best:</span> {it.best_part}</div>}
          {it.worst_part && <div className="entry-body"><span className="tiny">Worst:</span> {it.worst_part}</div>}
          {it.sexual_notes && <div className="entry-body"><span className="tiny">Intimate notes:</span> {it.sexual_notes}</div>}
        </div>
      </>
    );
  } else if (it.kind === 'post') {
    body = (
      <>
        <div className="entry-body">{it.text}</div>
        {(it.attachments || []).length ? (
          <div className="feed-media">{it.attachments.map((a, i) => <Media key={i} a={a} alt="Attachment" />)}</div>
        ) : null}
      </>
    );
  } else if (it.kind === 'task') {
    body = (
      <>
        <div className="title" style={{ marginTop: 8 }}>{it.task_title}</div>
        {it.note && <div className="entry-body">{it.note}</div>}
        {it.evidence_path && <div className="feed-media"><Media a={{ path: it.evidence_path }} alt="Evidence" /></div>}
        {!it.evidence_path && it.im_asset_id && (
          <div className="feed-media"><Media a={{ immich: true, asset_id: it.im_asset_id, media: it.im_media || 'image' }} alt="Evidence" /></div>
        )}
      </>
    );
  } else if (it.kind === 'punishment') {
    body = (
      <>
        <div className="title punish-text" style={{ marginTop: 8 }}>{it.title}</div>
        {it.note && <div className="entry-body">{it.note}</div>}
        {it.evidence_path && <div className="feed-media"><Media a={{ path: it.evidence_path }} alt="Evidence" /></div>}
        {!it.evidence_path && it.im_asset_id && (
          <div className="feed-media"><Media a={{ immich: true, asset_id: it.im_asset_id, media: it.im_media || 'image' }} alt="Evidence" /></div>
        )}
      </>
    );
  } else if (it.kind === 'entry') {
    body = (
      <>
        {it.prompt_text && <div className="tiny" style={{ marginTop: 8 }}>Re: “{it.prompt_text.slice(0, 140)}”</div>}
        <div className="entry-body">{it.text}</div>
      </>
    );
  }

  return (
    <div className={'item' + (it.kind === 'punishment' ? ' punish-card' : '')}>
      <div className="spread">
        <div className="title">{author} {chip}</div>
        <div className="row">
          {isDomView && (it.targets || []).length > 0 && (
            <span className="tiny">→ {it.targets.map(t => t.sub_name).join(', ')}</span>
          )}
          {del}
        </div>
      </div>
      {body}
      <div className="entry-meta">{fmtDT(it.ts)}</div>
      <Comments subject={it.comment_subject} id={it.comment_id} count={it.comment_count} />
    </div>
  );
}