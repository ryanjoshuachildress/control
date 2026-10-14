import { useEffect, useState, useRef } from 'react';
import { api, upload } from '../api';
import { useUser, getImmichOrigin } from '../user';
import { toast } from '../toast';
import Comments from '../components/Comments';
import ImmichControl from '../components/ImmichControl';
import { Media } from '../components/Media';
import { StarsInput, starsDisp } from '../components/Stars';
import { fmtDate, fmtDT, wordCount, peopleLabel } from '../format';
import { useRoute } from '../router';

const RATING_LABELS = [['r_originality', 'Originality'], ['r_hotness', 'Hotness'], ['r_surprise', 'Surprise'], ['r_connection', 'Connection']];
const PLANNED_CHIP = { planned: 'Planned', spontaneous: 'Spontaneous', both: 'Planned & spontaneous', other: 'Other' };

// Moments: record shared experiences, each participant's own version, tags.
export default function Moments() {
  const { user } = useUser();
  const route = useRoute();
  const q = route.query.get('q') || '';
  const tagId = route.query.get('tag') || route.query.get('tag_id') || '';
  const [d, setD] = useState(null);
  const [pair, setPair] = useState(null);
  const [err, setErr] = useState('');
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    Promise.all([
      api('/moments' + (q || tagId ? `?q=${encodeURIComponent(q)}&tag_id=${encodeURIComponent(tagId)}` : '')),
      api('/pair')
    ]).then(([dd, pp]) => { alive && (setD(dd), setPair(pp)); })
      .catch(e => alive && setErr(e.message));
    return () => { alive = false; };
  }, [q, tagId, tick]);

  if (err) return <div className="empty">{err}</div>;
  if (!d) return null;
  const reload = () => setTick(t => t + 1);
  const subs = (pair && pair.subs) || [];
  const paired = user.role === 'dom' || !!user.dom_id;
  const allTags = d.tags ? d.tags.tags.concat(d.tags.pending) : [];

  return (
    <>
      {paired
        ? <Composer user={user} subs={subs} allTags={allTags} reload={reload} immichOrigin={getImmichOrigin()} />
        : <div className="card"><h2>Moments</h2><p className="hint">Pair with a Dominant to record shared moments.</p></div>}
      <TagManager user={user} tags={d.tags} reload={reload} />
      <div className="card">
        <h2>Moments</h2>
        <FilterBar q={q} tagId={tagId} tags={(d.tags && d.tags.tags) || []} />
        {d.groups.length
          ? d.groups.map(g => <MomentCard key={g.id} g={g} user={user} reload={reload} />)
          : <div className="empty">No moments recorded yet.</div>}
      </div>
    </>
  );
}

function FilterBar({ q, tagId, tags }) {
  const ref = useRef(null);
  return (
    <form data-form="moment-filter" className="row" style={{ alignItems: 'flex-end', marginBottom: 14 }}
      onSubmit={(e) => {
        e.preventDefault();
        const f = ref.current;
        const qs = [];
        if (f.q.value.trim()) qs.push('q=' + encodeURIComponent(f.q.value.trim()));
        if (f.tag.value) qs.push('tag=' + encodeURIComponent(f.tag.value));
        location.hash = '#/moments' + (qs.length ? '?' + qs.join('&') : '');
      }}
      ref={ref}>
      <label className="f" style={{ margin: 0, flex: 2, minWidth: 170 }}>
        <span>Search</span>
        <input type="text" name="q" defaultValue={q} placeholder="Search moments…" />
      </label>
      <label className="f" style={{ margin: 0, flex: 1, minWidth: 140 }}>
        <span>Tag</span>
        <select name="tag" defaultValue={tagId}>
          <option value="">All tags</option>
          {tags.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </label>
      <button className="small" type="submit" style={{ marginBottom: 14 }}>Apply</button>
    </form>
  );
}

function TagManager({ user, tags, reload }) {
  const dom = user.role === 'dom';
  return dom ? (
    <div className="card">
      <h2>Tag master list</h2>
      {!!((tags.pending || []).length) && (
        <>
          <p className="hint">New tags your submissives typed — waiting for your approval:</p>
          {tags.pending.map(t => (
            <div className="item spread" key={t.id}>
              <div>{t.name} <span className="chip">pending</span></div>
              <div className="row">
                <button className="small" onClick={() => tagAction.rename(t, reload)}>Rename</button>
                <button className="small primary" onClick={() => tagAction.approve(t, reload)}>Approve</button>
                <button className="small danger" onClick={() => tagAction.del(t, reload)}>Delete</button>
              </div>
            </div>
          ))}
        </>
      )}
      {!!((tags.tags || []).length) ? (
        <div className="row" style={{ marginTop: 10 }}>
          {tags.tags.map(t => (
            <span className="tagchip" key={t.id}>
              {t.name}
              <button className="xsmall ghost" onClick={() => tagAction.rename(t, reload)} title="Rename">✎</button>
              <button className="xsmall ghost" onClick={() => tagAction.del(t, reload)} title="Delete">✕</button>
            </span>
          ))}
        </div>
      ) : <div className="empty">No tags yet — type them into a moment above.</div>}
    </div>
  ) : (
    <div className="card">
      <h2>Tags</h2>
      <p className="hint">Your Dom keeps the household tag list — new tags you type wait for their approval.</p>
      {!!((tags.pending || []).length) && (
        <div className="tiny">Pending from you: {tags.pending.map(t => t.name).join(', ')}</div>
      )}
    </div>
  );
}

const tagAction = {
  rename: (t, reload) => {
    const name = prompt('Rename tag (it stays attached to every moment using it):');
    if (!name || !name.trim()) return;
    api(`/moments/tags/${t.id}`, { method: 'PATCH', body: { name: name.trim() } })
      .then(() => { toast('Tag renamed'); reload(); })
      .catch(e => toast(e.message, true));
  },
  approve: (t, reload) => {
    api(`/moments/tags/${t.id}/approve`, { method: 'POST' })
      .then(() => { toast('Tag approved — everyone can use it'); reload(); })
      .catch(e => toast(e.message, true));
  },
  del: (t, reload) => {
    if (!confirm('Remove this tag from the master list and from every moment using it?')) return;
    api(`/moments/tags/${t.id}`, { method: 'DELETE' })
      .then(() => { toast('Tag removed'); reload(); })
      .catch(e => toast(e.message, true));
  }
};

function Composer({ user, subs, allTags, reload }) {
  const isDom = user.role === 'dom';
  const domInfo = isDom ? user : null;
  const dateRef = useRef(null);
  const [immichVal, setImmichVal] = useState('');
  const [pk, setPk] = useState({ planned: true, spontaneous: false, other: false });
  const [pkOther, setPkOther] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const fd = new FormData();
    fd.append('title', f.title.value);
    fd.append('description', f.description.value);
    fd.append('date', f.date.value);
    fd.append('time', f.time.value);
    fd.append('people_dom', f.people_dom.checked ? '1' : '');
    if (isDom) {
      const subsChecked = [...f.querySelectorAll('input[name="sub_ids"]:checked')];
      for (const s of subsChecked) fd.append('sub_ids', s.value);
    }
    fd.append('people_other', f.people_other.value);
    const kind = pk.other ? 'other' : (pk.planned && pk.spontaneous ? 'both' : (pk.planned ? 'planned' : 'spontaneous'));
    if (kind === 'other') {
      if (!pkOther.trim()) return toast('Describe the "other" option', true);
      fd.append('planned_kind', 'other');
      fd.append('planned_other', pkOther);
    } else if (kind === 'both' && pkOther.trim()) {
      fd.append('planned_kind', 'both');
      fd.append('planned_other', pkOther);
    } else fd.append('planned_kind', kind);
    for (const [, name] of [['summary', 'summary'], ['best', 'best_part'], ['worst', 'worst_part'], ['review', 'review'], ['tags', 'tags']]) fd.append(name, f[name].value);
    fd.append('again', (f.querySelector('input[name="again"]:checked') || {}).value || 'yes');
    // ratings required
    for (const [k, l] of RATING_LABELS) {
      const w = f.querySelector(`.stars[data-stars="${k}"]`);
      if (!w || !w.dataset.value) {
        w && w.classList.add('miss');
        return toast('Rate all four with the stars — they are required to save', true);
      }
      fd.append(k, w.dataset.value);
    }
    if (immichVal.trim()) fd.append('immich', immichVal.trim());
    for (const file of [...f.media.files]) fd.append('media', file);
    try {
      await upload('/moments', fd);
      toast('Moment recorded' + (isDom ? ' — involved submissives are being asked to record their version' : ''));
      location.hash = '#/moments';
      reload();
    } catch (err) { toast(err.message, true); }
  };

  return (
    <div className="card">
      <h2>Record a Moment</h2>
      <p className="hint">A shared memory of something you experienced — {isDom
        ? 'each involved submissive records their own version of it.'
        : 'your version stays yours; your Dom can see it.'}</p>
      <form data-form="moment-create" onSubmit={submit}>
        <div className="row">
          <label className="f" style={{ flex: 2, minWidth: 190 }}><span>Title <span className="tiny">(50)</span></span>
            <input type="text" name="title" required maxLength={50} /></label>
          <label className="f" style={{ flex: 1, minWidth: 150 }}><span>Date</span><input type="date" name="date" ref={dateRef} required /></label>
          <label className="f" style={{ flex: 1, minWidth: 120 }}><span>Time</span><input type="time" name="time" /></label>
        </div>
        <label className="f"><span>Description <span className="tiny">(160)</span></span>
          <input type="text" name="description" maxLength={160} /></label>
        <div className="f"><span>People involved</span>
          <div className="row">
            {domInfo && (
              <label className="chip-target">
                <input type="checkbox" name="people_dom" /> {peopleLabel(domInfo)}
              </label>
            )}
            {!domInfo && (
              <label className="chip-target">
                <input type="checkbox" name="people_dom" /> My Dominant
              </label>
            )}
            {isDom && subs.map(s => (
              <label key={s.id} className="chip-target">
                <input type="checkbox" name="sub_ids" value={s.id} /> {peopleLabel(s)}
              </label>
            ))}
          </div>
          {isDom && <div className="tiny" style={{ marginTop: 6 }}>Only the submissives you check here can see this moment and record their version of it.</div>}
          <input type="text" name="people_other" maxLength={200} placeholder="Other people (not on Control)…" style={{ marginTop: 8 }} />
        </div>
        <div className="f planned-block"><span>Planned or spontaneous</span>
          <div className="row">
            <label className="chip-target">
              <input type="checkbox" checked={pk.planned} onChange={() => setPk(p => ({ ...p, planned: !p.planned }))} /> Planned
            </label>
            <label className="chip-target">
              <input type="checkbox" checked={pk.spontaneous} onChange={() => setPk(p => ({ ...p, spontaneous: !p.spontaneous }))} /> Spontaneous
            </label>
            <label className="chip-target">
              <input type="checkbox" checked={pk.other} onChange={() => setPk(p => ({ ...p, other: !p.other }))} /> Other
            </label>
            {pk.other ? (
              <input type="text" value={pkOther} onChange={e => setPkOther(e.target.value)}
                maxLength={80} placeholder="Describe…" style={{ flex: 1, minWidth: 140 }} />
            ) : null}
          </div>
        </div>
        <WordArea name="summary" label="Summary" max={2000} formName="summary" />
        <div className="row">
          <WordArea name="best_part" label="The best part" max={100} minh={56} />
          <WordArea name="worst_part" label="The not so good part" max={100} minh={56} />
        </div>
        <div className="f"><span>Would you willingly do it again?</span>
          <div className="row">
            <label className="chip-target"><input type="radio" name="again" value="yes" defaultChecked /><span>Yes</span></label>
            <label className="chip-target"><input type="radio" name="again" value="no" /><span>No</span></label>
          </div>
        </div>
        <div className="row">
          {RATING_LABELS.map(([k, l]) => <StarsInput key={k} name={k} label={l} />)}
          <div className="tiny" style={{ width: '100%' }}>Ratings are needed to save — click the stars.</div>
        </div>
        <label className="f"><span>Review <span className="tiny">(180 characters)</span></span>
          <input type="text" name="review" maxLength={180} /></label>
        <label className="f"><span>Tags <span className="tiny">(comma separated)</span></span>
          <input type="text" name="tags" list="tagListMoments" maxLength={500} placeholder="rope, date night, first time…" />
          <datalist id="tagListMoments">
            {allTags.map(t => <option key={t.id} value={t.name} />)}
          </datalist>
          <div className="tiny">{isDom ? 'New tags join the household master list right away.' : 'New tags wait for your Dom to approve them onto the master list.'}</div>
        </label>
        <label className="f fileinput"><span>Photos or videos <span className="tiny">(up to 10, 512 MB each)</span></span>
          <input type="file" name="media" multiple
            accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/webm,video/quicktime,video/x-m4v" /></label>
        <ImmichControl value="" onChange={setImmichVal} dateRef={dateRef} />
        <button className="primary" type="submit">Record moment</button>
      </form>
    </div>
  );
}

// Word-limited textarea with live counter + the same red flag on overflow.
function WordArea({ name, label, max, minh, value }) {
  const [val, setVal] = useState(value || '');
  const n = wordCount(val);
  return (
    <label className="f" style={minh ? { flex: 1, minWidth: 220 } : undefined}>
      <span>{label}</span>
      <textarea data-wordmax={max} data-wordlabel={label} name={name} maxLength={8000}
        style={minh ? { minHeight: 56 } : undefined}
        value={val} onChange={e => setVal(e.target.value)} />
      <div className={'word-out tiny' + (n > max ? ' over' : '')}>{n} / {max} words</div>
    </label>
  );
}

function MomentCard({ g, user, reload }) {
  const mine = g.versions.find(v => !v.locked && v.mine);
  const who = [];
  if (g.people.dom_involved && g.people.dom) who.push(peopleLabel(g.people.dom));
  for (const s of g.people.subs) who.push(peopleLabel(s));
  if (g.people.other) who.push(`other: ${g.people.other}`);

  return (
    <div className="item moment" data-focus={`moment:${g.id}`}>
      <div className="spread">
        <div style={{ minWidth: 0 }}>
          <div className="title" style={{ fontSize: '15.5px' }}>{g.title}</div>
          {g.description ? <div className="muted">{g.description}</div> : null}
          <div className="tiny" style={{ marginTop: 4 }}>
            {who.length ? who.map((w, i) => <span key={i}>{w}{' · '}</span>) : <span className="tiny">just me</span>}
          </div>
        </div>
        <span className="chip acc">{PLANNED_CHIP[g.planned.kind] || 'Planned'}{g.planned.kind === 'other' && g.planned.other ? `: ${g.planned.other}` : ''}</span>
      </div>
      <div className="tiny" style={{ marginTop: 6 }}>
        {fmtDate(g.date)}{g.time ? ` · ${g.time}` : ''} · {g.creator_title ? `${g.creator_title} ${g.creator_name}` : g.creator_name}
        {g.created_by === user.id ? ' (you)' : ''}
      </div>
      {!!g.tags.length && (
        <div className="row" style={{ marginTop: 10 }}>
          {g.tags.map(t => (
            <button key={t.id} className={'tagchip' + (t.status === 'pending' ? ' pend' : '')}
              data-action="filter-tag" data-id={t.id}
              onClick={() => { location.hash = `#/moments?tag=${encodeURIComponent(t.id)}`; }}
              title={`Show only moments tagged “${t.name}”`}>
              {t.name}{t.status === 'pending' ? ' ·' : ''}
            </button>
          ))}
        </div>
      )}
      {g.versions.map(v => <Version key={v.id || v.author_id} g={g} v={v} reload={reload} />)}
      {user.role === 'dom' && (g.pending || []).length ? (
        <div className="mv-pending">⏳ Waiting on their version: {g.pending.map(p => peopleLabel(p)).join(', ')} — they're prompted to record it before they can read yours.</div>
      ) : null}
      {mine && <VersionEdit g={g} v={mine} reload={reload} />}
      <VersionForm g={g} reload={reload} />
      <Comments subject="moment" id={g.id} count={g.comment_count} />
      {g.can_delete && (
        <div className="row" style={{ marginTop: 10 }}>
          <button className="small danger" onClick={async () => {
            if (!confirm('Delete this moment — all versions, photos and tags?')) return;
            try { await api(`/moments/${g.id}`, { method: 'DELETE' }); toast('Moment deleted'); reload(); }
            catch (e) { toast(e.message, true); }
          }}>Delete moment</button>
        </div>
      )}
    </div>
  );
}

function Version({ g, v, reload }) {
  if (v.locked) {
    return (
      <div className="mv locked">🔒 <b>{peopleLabel(v)}</b> has recorded their version
        {v.author_role === 'dom' ? ' — record yours below to unlock it.' : ' — it stays sealed for you.'}
      </div>
    );
  }
  return (
    <div className="mv" id={`mv-${v.id}`}>
      <div className="spread">
        <div className="mv-author">
          {peopleLabel(v)} {v.mine && <span className="chip acc">yours</span>}
          <span className={'chip ' + (v.again === 'yes' ? 'good' : 'bad')}>{v.again === 'yes' ? 'would do again' : 'not again'}</span>
        </div>
        <div className="row">
          <span className="tiny">{fmtDT(v.created_at)}</span>
          {v.mine && (
            <button className="xsmall ghost" title="Edit your version"
              onClick={() => {
                const d = document.getElementById(`mvEdit-${v.id}`);
                if (d) { d.open = true; d.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
              }}>✎ Edit</button>
          )}
        </div>
      </div>
      {v.summary && <div className="entry-body">{v.summary}</div>}
      {!!((v.attachments || []).length) && (
        <div className="feed-media">
          {v.attachments.map((a, i) => (
            <span className="att" key={i}>
              <Media a={a} alt="Photo" />
              {v.mine && (
                <button className="xsmall ghost" title="Remove this file"
                  onClick={async () => {
                    try { await api(`/moments/${g.id}/attachments/${a.id}`, { method: 'DELETE' }); toast('Attachment removed'); reload(); }
                    catch (e) { toast(e.message, true); }
                  }}>✕</button>
              )}
            </span>
          ))}
        </div>
      )}
      {v.best_part && <div className="entry-body"><span className="tiny">Best:</span> {v.best_part}</div>}
      {v.worst_part && <div className="entry-body"><span className="tiny">Not so good:</span> {v.worst_part}</div>}
      <div className="mv-ratings">
        {['originality', 'hotness', 'surprise', 'connection'].map(k => (
          <span className="rating" key={k}>
            <span className="tiny">{k[0].toUpperCase() + k.slice(1)}</span> {starsDisp(v.ratings[k])} <b>{Number(v.ratings[k]) || ''}</b>
          </span>
        ))}
      </div>
      {v.review && <div className="entry-body mv-review">“{v.review}”</div>}
    </div>
  );
}

// Edit form (summary/details) — kept as <details> so the ✎ Edit action opens it.
function VersionEdit({ g, v, reload }) {
  const dateRef = useRef(null);
  const [immichVal, setImmichVal] = useState((v.attachments || []).filter(a => a.immich).map(a => a.asset_id).join(','));
  return (
    <details className="mv-form" id={`mvEdit-${v.id}`}>
      <summary>Edit {peopleLabel(v)}'s version</summary>
      <form data-form="moment-edit" onSubmit={async (e) => {
        e.preventDefault();
        const f = e.target;
        const fd = new FormData();
        fd.append('summary', f.summary.value);
        fd.append('best_part', f.best_part.value);
        fd.append('worst_part', f.worst_part.value);
        fd.append('again', (f.querySelector('input[name="again"]:checked') || {}).value || 'yes');
        fd.append('immich', immichVal.trim()); // replace-on-edit semantics
        for (const [k] of RATING_LABELS) {
          const w = f.querySelector(`.stars[data-stars="${k}"]`);
          if (!w || !w.dataset.value) {
            w && w.classList.add('miss');
            return toast('Rate all four with the stars — they are required to save', true);
          }
          fd.append(k, w.dataset.value);
        }
        fd.append('review', f.review.value);
        for (const file of [...f.media.files]) fd.append('media', file);
        try {
          await fetch(`/api/moments/${g.id}/version`, { method: 'PUT', body: fd, credentials: 'same-origin' })
            .then(async res => {
              const data = await res.json().catch(() => ({}));
              if (!res.ok) throw new Error(data.error || 'Upload failed');
            });
          toast('Version updated');
          reload();
        } catch (err) { toast(err.message, true); }
      }} data-moment={g.id}>
        <WordArea name="summary" label="Summary" max={2000} value={v.summary} />
        <div className="row">
          <WordArea name="best_part" label="The best part" max={100} minh={56} value={v.best_part} />
          <WordArea name="worst_part" label="The not so good part" max={100} minh={56} value={v.worst_part} />
        </div>
        <div className="f"><span>Would you willingly do it again?</span>
          <div className="row">
            <label className="chip-target"><input type="radio" name="again" value="yes" defaultChecked={v.again === 'yes'} /><span>Yes</span></label>
            <label className="chip-target"><input type="radio" name="again" value="no" defaultChecked={v.again === 'no'} /><span>No</span></label>
          </div>
        </div>
        <div className="row">
          {RATING_LABELS.map(([k, l]) => <StarsInput key={k} name={k} label={l} initial={v.ratings[l.toLowerCase()]} />)}
        </div>
        <label className="f"><span>Review <span className="tiny">(180 characters)</span></span>
          <input type="text" name="review" maxLength={180} defaultValue={v.review} /></label>
        <label className="f fileinput"><span>Add photos or videos <span className="tiny">(kept files stay as in the card above)</span></span>
          <input type="file" name="media" multiple
            accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/webm,video/quicktime,video/x-m4v" /></label>
        <ImmichControl value={immichVal} onChange={setImmichVal} fixedDate={g.date} dateRef={dateRef} />
        <button className="primary small" type="submit">Save changes</button>
        {g.can_delete && (
          <button className="small danger" type="button" onClick={async () => {
            if (!confirm('Delete this moment — all versions, photos and tags?')) return;
            try { await api(`/moments/${g.id}`, { method: 'DELETE' }); toast('Moment deleted'); reload(); }
            catch (e) { toast(e.message, true); }
          }}>Delete whole moment</button>
        )}
      </form>
    </details>
  );
}

function VersionForm({ g, reload }) {
  if (!g.can_record) return null;
  const dateRef = useRef(null);
  const [immichVal, setImmichVal] = useState('');
  return (
    <details className={'mv-form' + (g.needs_record ? ' urgent' : '')} open={!!g.needs_record}>
      <summary>{g.needs_record
        ? '🔒 Your version is waiting — record it to unlock reading the others'
        : 'Add your version'}</summary>
      <form data-form="moment-version" data-moment={g.id} onSubmit={async (e) => {
        e.preventDefault();
        const f = e.target;
        const fd = new FormData();
        fd.append('summary', f.summary.value);
        fd.append('best_part', f.best_part.value);
        fd.append('worst_part', f.worst_part.value);
        fd.append('again', (f.querySelector('input[name="again"]:checked') || {}).value || 'yes');
        fd.append('immich', immichVal.trim());
        for (const [k] of RATING_LABELS) {
          const w = f.querySelector(`.stars[data-stars="${k}"]`);
          if (!w || !w.dataset.value) {
            w && w.classList.add('miss');
            return toast('Rate all four with the stars — they are required to save', true);
          }
          fd.append(k, w.dataset.value);
        }
        fd.append('review', f.review.value);
        for (const file of [...f.media.files]) fd.append('media', file);
        try {
          await upload(`/moments/${g.id}/version`, fd);
          toast('Your version is recorded — reading unlocked');
          reload();
        } catch (err) { toast(err.message, true); }
      }}>
        <WordArea name="summary" label="Summary" max={2000} />
        <div className="row">
          <WordArea name="best_part" label="The best part" max={100} minh={56} />
          <WordArea name="worst_part" label="The not so good part" max={100} minh={56} />
        </div>
        <div className="f"><span>Would you willingly do it again?</span>
          <div className="row">
            <label className="chip-target"><input type="radio" name="again" value="yes" defaultChecked /><span>Yes</span></label>
            <label className="chip-target"><input type="radio" name="again" value="no" /><span>No</span></label>
          </div>
        </div>
        <div className="row">
          {RATING_LABELS.map(([k, l]) => <StarsInput key={k} name={k} label={l} />)}
          <div className="tiny" style={{ width: '100%' }}>Ratings are needed to save — click the stars.</div>
        </div>
        <label className="f"><span>Review <span className="tiny">(180 characters)</span></span>
          <input type="text" name="review" maxLength={180} /></label>
        <label className="f fileinput"><span>Photos or videos <span className="tiny">(up to 10, 512 MB each)</span></span>
          <input type="file" name="media" multiple
            accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/webm,video/quicktime,video/x-m4v" /></label>
        <ImmichControl value="" onChange={setImmichVal} dateRef={dateRef} fixedDate={g.date} />
        <button className="primary small" type="submit">Record your version</button>
      </form>
    </details>
  );
}