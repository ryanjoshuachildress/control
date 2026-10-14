import { useEffect, useState } from 'react';
import { api } from '../api';
import { Media } from '../components/Media';

// submissive "About me": read-only view of the fields the Dom exposed.
export default function SubAbout() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api('/profile/mine').then(setD).catch(e => setErr(e.message));
  }, []);
  if (err) return <div className="empty">{err}</div>;
  if (!d) return null;

  return (
    <div className="card">
      <h2>About me</h2>
      <p className="hint">
        {d.dom
          ? `Your ${d.dom.title || 'Dominant'} keeps this information — only they can edit it, and only what they have chosen to show you appears here.`
          : 'Pair with a Dominant to see this page.'}
      </p>
      {d.fields.length
        ? d.fields.map(f => <Field key={f.id} f={f} />)
        : <div className="empty">Nothing shared with you yet.</div>}
    </div>
  );
}

function Field({ f }) {
  const kind = f.kind || (f.multiline ? 'multiline' : 'text');
  return (
    <div className="item">
      <div className="tiny">{f.label}</div>
      {kind === 'photo' ? (
        f.value
          ? <a className="pf-thumb-link" href={`/uploads/${f.value}`} target="_blank" rel="noopener" title="View full size">
              <img className="pf-thumb" src={`/uploads/${f.value}`} alt={f.label} />
            </a>
          : f.im_asset_id
            ? <Media a={{ immich: true, asset_id: f.im_asset_id, media: f.im_media || 'image' }} alt={f.label} />
            : <div className="tiny" style={{ marginTop: 4 }}>—</div>
      ) : (
        <div className="entry-body" style={{ marginTop: 2 }}>
          {f.value ? f.value : <span className="tiny">—</span>}
        </div>
      )}
    </div>
  );
}