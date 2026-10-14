import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { UserContext, subscribeSession, getImmichOrigin, setImmichOrigin } from './user';
import { useHashRoute, RouterProvider } from './router';
import { initToast, ToastHost, toast } from './toast';
import FocusHost from './FocusHost';

import Auth from './pages/Auth';
import Today from './pages/Today';
import SubJournal from './pages/SubJournal';
import SubAbout from './pages/SubAbout';
import Feed from './pages/Feed';
import Moments from './pages/Moments';
import Recap from './pages/Recap';
import Dash from './pages/Dash';
import DomSub from './pages/DomSub';
import Stats from './pages/Stats';
import Settings from './pages/Settings';
import DomJournal from './pages/DomJournal';

const TABS = {
  dom: [['#/feed', 'Feed'], ['#/moments', 'Moments'], ['#/recap', 'Recap'], ['#/dash', 'Dashboard'], ['#/journal', 'My journal'], ['#/settings', 'Settings']],
  sub: [['#/feed', 'Feed'], ['#/', 'Today'], ['#/journal', 'Journal'], ['#/about', 'About me'], ['#/moments', 'Moments'], ['#/recap', 'Recap'], ['#/stats', 'Stats'], ['#/settings', 'Settings']]
};

export default function App() {
  const [user, setUser] = useState(null);
  const [booted, setBooted] = useState(false);
  const [authErr, setAuthErr] = useState('');
  const [toastState, setToastState] = useState({ msg: '', isErr: false });

  initToast(setToastState);
  // api.js clears the module session on a 401; mirror it into state
  useEffect(() => subscribeSession(() => setUser(null)), []);

  useEffect(() => {
    api('/auth/me')
      .then(d => {
        setUser(d.user);
        setImmichOrigin(d.immich_origin || null);
      })
      .catch(() => setAuthErr('signed-out'))
      .finally(() => setBooted(true));
  }, []);

  const route = useHashRoute();
  const isReset = route.parts[0] === 'reset';

  const ctxValue = useMemo(() => ({
    user, setUser, immichOrigin: getImmichOrigin()
  }), [user]);

  function Shell({ active, children }) {
    const who = user.title ? user.title : user.name;
    const tabs = TABS[user.role].map(([href, label]) => (
      <a key={href} href={href} className={active === href ? 'on' : ''}>{label}</a>
    ));
    return (
      <>
        <header className="topbar"><div className="wrap">
          <a className="brand" href="#/">Control</a>
          <nav className="tabs">{tabs}</nav>
          <div className="whoami">
            <b>{who}</b>
            <button className="small ghost" onClick={async () => {
              try { await api('/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
              setUser(null);
              location.hash = '#/login';
            }}>Log out</button>
          </div>
        </div></header>
        <main className="wrap">{children}</main>
      </>
    );
  }

  function Page() {
    const parts = route.parts;
    const page = parts[0] || '';
    if (!user) return null; // auth screen handled below
    // Every in-app page renders inside the shell; focus spec is consumed here
    // once per navigation.
    const focusSpec = route.focus;
    const wrap = (el) => <><FocusHost focusSpec={focusSpec} />{el}</>;

    if (user.role === 'dom') {
      if (page === '' || (page === 'dash' && parts.length === 1)) return wrap(<Shell active="#/dash"><Dash /></Shell>);
      if (page === 'dash') return wrap(<Shell active="#/dash"><Dash /></Shell>);
      if (page === 'feed') return wrap(<Shell active="#/feed"><Feed /></Shell>);
      if (page === 'moments') return wrap(<Shell active="#/moments"><Moments /></Shell>);
      if (page === 'recap') return wrap(<Shell active="#/recap"><Recap /></Shell>);
      if (page === 'sub' && parts[1]) return wrap(<Shell active="#/dash"><DomSub subId={parts[1]} tab={parts[2] || 'tasks'} focusSpec={focusSpec} /></Shell>);
      if (page === 'journal') return wrap(<Shell active="#/journal"><DomJournal /></Shell>);
      if (page === 'settings') return wrap(<Shell active="#/settings"><Settings /></Shell>);
      return wrap(<Shell active="#/dash"><Dash /></Shell>);
    }
    if (user.role === 'sub') {
      // Today is the default page ('#/' and '#/today')
      if (page === '' || page === 'today') return wrap(<Shell active="#/"><Today /></Shell>);
      if (page === 'feed') return wrap(<Shell active="#/feed"><Feed /></Shell>);
      if (page === 'recap') return wrap(<Shell active="#/recap"><Recap /></Shell>);
      if (page === 'moments') return wrap(<Shell active="#/moments"><Moments /></Shell>);
      if (page === 'about') return wrap(<Shell active="#/about"><SubAbout /></Shell>);
      if (page === 'journal') return wrap(<Shell active="#/journal"><SubJournal /></Shell>);
      if (page === 'stats') return wrap(<Shell active="#/stats"><Stats /></Shell>);
      if (page === 'settings') return wrap(<Shell active="#/settings"><Settings /></Shell>);
      return wrap(<Shell active="#/"><Today /></Shell>);
    }
    return null;
  }

  return (
    <UserContext.Provider value={ctxValue}>
      <RouterProvider value={route}>
        {!booted && <div className="boot">Loading…</div>}
        {booted && !user && (
          <Auth signedOut={authErr === 'signed-out'}
            resetToken={isReset ? decodeURIComponent(route.parts[1] || '') : null} />
        )}
        {booted && user && <Page />}
        <ToastHost state={toastState} />
      </RouterProvider>
    </UserContext.Provider>
  );
}