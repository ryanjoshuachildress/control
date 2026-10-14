import { useEffect, useState } from 'react';
import { api } from '../api';
import { useUser, setImmichOrigin } from '../user';
import { toast } from '../toast';
import { go, useRoute } from '../router';
import { DOM_TITLES, SUB_TITLES } from '../format';

const titleOptions = (role) => [...(role === 'dom' ? DOM_TITLES : SUB_TITLES), '__custom'];

// Login / register / forgot / reset screens (route decided by the hash, as in
// the vanilla router).
export default function Auth({ signedOut, resetToken }) {
  const route = useRoute();
  const { setUser } = useUser();
  const [tz] = useState(() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
  });

  if (route.parts[0] === 'forgot') return <Forgot />;
  if (route.parts[0] === 'reset') return <Reset token={resetToken} />;
  if (route.parts[0] === 'register') return <Register tz={tz} />;
  return (
    <div className="auth-wrap">
      <div className="card">
        <div className="auth-brand">Control</div>
        <div className="auth-sub">A private place to guide and grow your dynamic</div>
        {signedOut && <p className="hint" style={{ textAlign: 'center' }}>Session ended — sign in again.</p>}
        <form onSubmit={(e) => {
          e.preventDefault();
          const f = e.target;
          api('/auth/login', { method: 'POST', body: { email: f.email.value, password: f.password.value } })
            .then(d => { setUser(d.user); go('#/'); })
            .catch(err => toast(err.message, true));
        }}>
          <label className="f"><span>Email</span><input type="email" name="email" required /></label>
          <label className="f"><span>Password</span><input type="password" name="password" required /></label>
          <button className="primary" style={{ width: '100%' }} type="submit">Sign in</button>
        </form>
        <div className="auth-alt">New here? <a href="#/register">Create an account</a> · <a href="#/forgot">Forgot password?</a></div>
      </div>
    </div>
  );
}

function Forgot() {
  return (
    <div className="auth-wrap">
      <div className="card">
        <div className="auth-brand">Control</div>
        <div className="auth-sub">Reset your password</div>
        <form onSubmit={(e) => {
          e.preventDefault();
          const f = e.target;
          api('/auth/forgot', { method: 'POST', body: { email: f.email.value } })
            .then(() => {
              toast('If that email is registered, a reset link is on its way.');
              go('#/login');
            })
            .catch(err => toast(err.message, true));
        }}>
          <label className="f"><span>Email</span><input type="email" name="email" required /></label>
          <button className="primary" style={{ width: '100%' }} type="submit">Send reset link</button>
        </form>
        <div className="auth-alt">Remembered it? <a href="#/login">Sign in</a></div>
      </div>
    </div>
  );
}

function Reset({ token }) {
  useEffect(() => { if (!token) go('#/login'); }, [token]);
  if (!token) return null;
  return (
    <div className="auth-wrap">
      <div className="card">
        <div className="auth-brand">Control</div>
        <div className="auth-sub">Choose a new password</div>
        <form onSubmit={(e) => {
          e.preventDefault();
          const f = e.target;
          if (f.password.value !== f.confirm.value) return toast('Passwords do not match', true);
          api('/auth/reset', { method: 'POST', body: { token, password: f.password.value } })
            .then(() => { toast('Password updated — sign in with it now'); go('#/login'); })
            .catch(err => toast(err.message, true));
        }}>
          <label className="f"><span>New password <span className="tiny">(8+ characters)</span></span>
            <input type="password" name="password" required minLength={8} /></label>
          <label className="f"><span>Confirm new password</span>
            <input type="password" name="confirm" required minLength={8} /></label>
          <button className="primary" style={{ width: '100%' }} type="submit">Set new password</button>
        </form>
      </div>
    </div>
  );
}

function Register({ tz }) {
  const { setUser } = useUser();
  const [role, setRole] = useState('dom');
  const [customTitle, setCustomTitle] = useState(false);

  return (
    <div className="auth-wrap">
      <div className="card">
        <div className="auth-brand">Control</div>
        <div className="auth-sub">Create your account</div>
        <form onSubmit={(e) => {
          e.preventDefault();
          const f = e.target;
          const title = f.title.value === '__custom' ? (f.customTitle ? f.customTitle.value : '') : f.title.value;
          api('/auth/register', { method: 'POST', body: {
            email: f.email.value, password: f.password.value, name: f.name.value,
            role, title, timezone: tz, inviteCode: f.inviteCode ? f.inviteCode.value : ''
          } })
            .then(d => {
              setUser(d.user);
              setImmichOrigin(null);
              toast(`Welcome, ${d.user.name}`);
              go('#/');
            })
            .catch(err => toast(err.message, true));
        }}>
          <div className="role-pick" id="rolePick">
            <label data-role="dom" className={role === 'dom' ? 'on' : ''}>
              Dominant
              <input type="radio" name="role" value="dom" checked={role === 'dom'} onChange={() => setRole('dom')} />
            </label>
            <label data-role="sub" className={role === 'sub' ? 'on' : ''}>
              submissive
              <input type="radio" name="role" value="sub" checked={role === 'sub'} onChange={() => setRole('sub')} />
            </label>
          </div>
          <label className="f"><span>Title</span>
            <select name="title" onChange={(e) => setCustomTitle(e.target.value === '__custom')}>
              {titleOptions(role).map(t => <option key={t} value={t}>{t === '__custom' ? 'Other…' : t}</option>)}
            </select>
          </label>
          {customTitle && (
            <label className="f"><span>Custom title</span><input type="text" name="customTitle" maxLength={60} /></label>
          )}
          <label className="f"><span>Display name</span>
            <input type="text" name="name" required maxLength={80} placeholder="How you are addressed" /></label>
          <label className="f"><span>Email</span><input type="email" name="email" required /></label>
          <label className="f"><span>Password <span className="tiny">(8+ characters)</span></span>
            <input type="password" name="password" required minLength={8} /></label>
          {role === 'sub' && (
            <label className="f"><span>Dom's invite code <span className="tiny">(pair later in Settings instead)</span></span>
              <input type="text" name="inviteCode" placeholder="CTRL-…" /></label>
          )}
          <button className="primary" style={{ width: '100%' }} type="submit">Create account</button>
        </form>
        <div className="auth-alt">Already have an account? <a href="#/login">Sign in</a></div>
      </div>
    </div>
  );
}