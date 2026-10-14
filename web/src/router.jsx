import { useEffect, useState, createContext, useContext } from 'react';

// Hash router — kept because every notification email ever sent links to
// `${BASE_URL}/#/page?focus=subject:id`; hash routes keep those working.
//
// Exposes { path, parts, query, focus } and a `go()` helper.
const RouterContext = createContext({ path: '', parts: [], query: new URLSearchParams(), focus: null });

export function useHashRoute() {
  const [hash, setHash] = useState(() => location.hash || '#/');
  useEffect(() => {
    const on = () => setHash(location.hash || '#/');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const raw = hash.slice(1);
  const qIdx = raw.indexOf('?');
  const path = qIdx === -1 ? raw : raw.slice(0, qIdx);
  const query = new URLSearchParams(qIdx === -1 ? '' : raw.slice(qIdx));
  // focus is consumed once per navigation (applyFocus semantics kept: the spec
  // survives until the next page render finishes with it).
  const focusRaw = qIdx === -1 ? null : query.get('focus');
  const parts = path.split('/').filter(Boolean);
  return { hashKey: hash, path: raw, parts, query, focus: focusRaw };
}

export const useRoute = () => useContext(RouterContext);
export function RouterProvider({ value, children }) {
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function go(hash) { location.hash = hash; }