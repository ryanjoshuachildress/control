import { useEffect, useState } from 'react';
import { api } from '../api';
import { useUser } from '../user';
import { toast } from '../toast';
import { DOM_TITLES, SUB_TITLES } from '../format';

// Profile + pairing settings for both roles.
export default function Settings() {
  const { user, setUser } = useUser();
  const [pair, setPair] = useState(null);
  const [err, setErr] = useState('');
  const [tick, setTick] = useState(0);

  useEffect(() => {
    api('/pair').then(setPair).catch(e => setErr(e.message));
  }, [tick]);

  if (err) return <div className="empty">{err}</div>;
  if (!user || !pair) return null;
  const reload = () => setTick(t => t + 1);

  const titles = user.role === 'dom' ? DOM_TITLES : SUB_TITLES;
  const custom = user.title && !titles.includes(user.title);

  return (
    <>
      <div className="card">
        <h2>Profile</h2>
        <form onSubmit={(e) => {
          e.preventDefault();
          const f = e.target;
          const titleVal = f.title.value === '__custom' ? (f.customTitle ? f.customTitle.value : '') : f.title.value;
          const body = {
            name: f.name.value, title: titleVal, timezone: f.timezone.value,
            email_notifications: f.email_notifications.checked,
            allow_sub_interaction: user.role === 'dom' ? f.allow_sub_interaction.checked : undefined
          };
          const keyVal = f.immich_key ? String(f.immich_key.value || '').trim() : '';
          if (keyVal) body.immich_key = keyVal; // only sent when the user pasted one
          api('/auth/me', { method: 'PATCH', body })
            .then((d) => {
              setUser(d.user);
              toast(keyVal ? 'Profile saved — Immich key verified' : 'Profile saved');
              reload();
            })
            .catch(errr => toast(errr.message, true));
        }}>
          <label className="f"><span>Display name</span>
            <input type="text" name="name" required maxLength={80} defaultValue={user.name} /></label>
          <label className="f"><span>Title</span>
            <select name="title" defaultValue={custom ? '__custom' : user.title}>
              {titles.map(t => <option key={t} value={t}>{t}</option>)}
              <option value="__custom">Custom…</option>
            </select></label>
          <label className="f"><span>Custom title</span>
            <input type="text" name="customTitle" maxLength={60} defaultValue={custom ? user.title : ''} /></label>
          <label className="f"><span>Timezone <span className="tiny">(drives all deadlines)</span></span>
            <input type="text" name="timezone" defaultValue={user.timezone} required aria-label="IANA timezone" placeholder="America/Chicago" /></label>
          <label className="f row">
            <input type="checkbox" name="email_notifications" defaultChecked={user.email_notifications} style={{ width: 'auto', marginRight: 8 }} />
            <span style={{ margin: 0 }}>Email me notifications</span>
          </label>
          {user.role === 'dom' && (
            <>
              <label className="f row">
                <input type="checkbox" name="allow_sub_interaction" defaultChecked={user.allow_sub_interaction} style={{ width: 'auto', marginRight: 8 }} />
                <span style={{ margin: 0 }}>Let my submissives see each other <span className="tiny">(household-wide)</span></span>
              </label>
              <p className="hint" style={{ marginTop: -8 }}>Off — the default — every submissive is sandboxed: they never see each other's feed posts, journals, or Moment versions, and each must record their version of a shared Moment to read yours. On — submissives who share a Moment or a household-wide post can read each other's versions and posts and join the threads. You always see everything either way.</p>
            </>
          )}
          <label className="f"><span>Immich API key {user.immich_linked ? <span className="tiny">(one is on file — paste a new one to replace it)</span> : ''}</span>
            <input type="password" name="immich_key" autoComplete="off"
              placeholder={user.immich_linked ? '•••••••• (paste a new key to replace)' : 'paste your Immich API key'} /></label>
          {user.immich_linked
            ? <button className="small ghost" type="button" style={{ margin: '-6px 0 14px' }} onClick={() => {
                if (!confirm('Remove your Immich API key from Control? Existing links keep working.')) return;
                api('/auth/me', { method: 'PATCH', body: { immich_key: '' } })
                  .then(d => { setUser(d.user); toast('Immich key removed'); reload(); })
                  .catch(e => toast(e.message, true));
              }}>Remove Immich key</button>
            : <p className="hint" style={{ marginTop: -8 }}>Lets you link photos and videos straight from your Immich library into Moments — no re-uploads.</p>}
          <button className="primary" type="submit">Save</button>
        </form>
      </div>
      {user.role === 'dom' ? (
        <>
          <div className="card">
            <h2>Invite code</h2>
            <div className="code-box">
              <code>{pair.invite_code || '—'}</code>
              <button className="small" onClick={(e) => {
                const code = e.target.closest('.code-box').querySelector('code');
                navigator.clipboard && navigator.clipboard.writeText(code.textContent)
                  .then(() => toast('Copied')).catch(() => toast('Copy failed', true));
              }}>Copy</button>
            </div>
          </div>
          <div className="card">
            <h2>My submissives</h2>
            {pair.subs.length ? pair.subs.map(s => (
              <div className="item spread" key={s.id}>
                <div>
                  <div className="title">{s.name}</div>
                  <div className="tiny">{s.title || ''} · {s.email}</div>
                </div>
                <button className="small danger" onClick={() => {
                  if (!confirm('Unpair this submissive? Their tasks and prompts will be deactivated.')) return;
                  api('/pair', { method: 'DELETE', body: { sub_id: s.id } })
                    .then(() => { toast('Unpaired'); reload(); })
                    .catch(e => toast(e.message, true));
                }}>Unpair</button>
              </div>
            )) : <div className="empty">None paired yet.</div>}
          </div>
        </>
      ) : (
        <div className="card">
          <h2>My Dominant</h2>
          {pair.dom ? (
            <div className="item spread">
              <div><div className="title">{pair.dom.title || ''} {pair.dom.name}</div></div>
              <button className="small danger" onClick={() => {
                if (!confirm('Leave your Dom? Your tasks and prompts will be deactivated.')) return;
                api('/pair', { method: 'DELETE' })
                  .then(() => { toast('Unpaired'); reload(); })
                  .catch(e => toast(e.message, true));
              }}>Unpair from {pair.dom.name}</button>
            </div>
          ) : (
            <>
              <p className="hint">Not paired yet. Enter the invite code your Dom gave you:</p>
              <form className="row" onSubmit={(e) => {
                e.preventDefault();
                api('/pair', { method: 'POST', body: { code: e.target.code.value } })
                  .then(() => { toast('Paired'); location.hash = '#/today'; reload(); })
                  .catch(e => toast(e.message, true));
              }}>
                <input type="text" name="code" placeholder="CTRL-…" required style={{ maxWidth: 240 }} />
                <button className="primary small" type="submit">Pair</button>
              </form>
            </>
          )}
        </div>
      )}
    </>
  );
}