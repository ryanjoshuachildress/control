import { getSessionUser, clearSessionUser, setImmichOrigin } from './user';

// JSON API wrapper — same cookie session as before, same error shape.
// A 401 with a live session clears the session and drops the user at #/login.
export async function api(path, opts = {}) {
  const init = {
    method: opts.method || 'GET',
    headers: {},
    credentials: 'same-origin'
  };
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch('/api' + path, init);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && getSessionUser()) {
    clearSessionUser();
    location.hash = '#/login';
    throw new Error(data.error || 'Signed out');
  }
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// Multipart variant for the upload endpoints (evidence, feed media, moments).
export async function upload(path, formData) {
  const res = await fetch('/api' + path, { method: 'POST', body: formData, credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && getSessionUser()) {
    clearSessionUser();
    location.hash = '#/login';
    throw new Error(data.error || 'Signed out');
  }
  if (!res.ok) throw new Error(data.error || 'Upload failed');
  return data;
}