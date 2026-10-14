import { createContext, useContext } from 'react';

// Session user + Immich origin live in module state synced with React context;
// api.js needs to read/clear it outside the component tree.
let sessionUser = null;
let immichOrigin = null;

export const UserContext = createContext({ user: null, setUser: () => {}, immichOrigin: null });

export function getSessionUser() { return sessionUser; }
export function clearSessionUser() {
  sessionUser = null;
  // notify live listeners; App subscribes
  for (const fn of listeners) fn(null);
}
export function setImmichOrigin(origin) { immichOrigin = origin; }
export function getImmichOrigin() { return immichOrigin; }

const listeners = new Set();
export function subscribeSession(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export const useUser = () => useContext(UserContext);