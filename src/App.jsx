import React, { useCallback, useEffect, useState } from 'react';
import api, { auth } from './lib/api';
import { getTheme, setTheme, recall, remember } from './lib/util';
import { Loading } from './components/ui';
import Login from './pages/Login';
import Campaigns from './pages/Campaigns';
import CreateCampaign from './pages/CreateCampaign';
import Customers from './pages/Customers';
import Templates from './pages/Templates';
import Stores from './pages/Stores';
import Settings from './pages/Settings';

const PAGES = [
  { id: 'campaigns', label: 'Campaigns', Component: Campaigns },
  { id: 'new', label: 'Create campaign', Component: CreateCampaign },
  { id: 'customers', label: 'Customers', Component: Customers },
  { id: 'templates', label: 'Templates', Component: Templates },
  { id: 'stores', label: 'Stores', Component: Stores },
  { id: 'settings', label: 'Settings', Component: Settings },
];

const THEME_ICONS = {
  light: <path d="M12 4V2m0 20v-2m8-8h2M2 12h2m13.66-5.66 1.41-1.41M4.93 19.07l1.41-1.41m0-11.32L4.93 4.93m14.14 14.14-1.41-1.41M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z" />,
  dark: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />,
  system: <><circle cx="12" cy="12" r="8" /><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" /></>,
};

const pageFromHash = () => {
  const id = window.location.hash.replace(/^#\/?/, '').split('?')[0];
  return PAGES.some((p) => p.id === id) ? id : 'campaigns';
};

export default function App() {
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(!!auth.getToken());
  const [signOutReason, setSignOutReason] = useState('');
  const [page, setPage] = useState(pageFromHash);
  const [status, setStatus] = useState(null);
  const [groups, setGroups] = useState([]);
  const [scope, setScope] = useState(() => recall('cc_scope'));
  const [theme, setThemeState] = useState(getTheme);

  useEffect(() => {
    auth.onSignedOut((reason) => { setUser(null); setSignOutReason(reason || ''); });
    if (!auth.getToken()) return;
    api.me().then(setUser).catch(() => auth.setToken(null)).finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    const onHash = () => setPage(pageFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const refreshGroups = useCallback(() => {
    api.groups().then((g) => {
      setGroups(g);
      // A remembered group that no longer exists falls back to all groups.
      setScope((s) => (s && !g.some((x) => x.key === s) ? '' : s));
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!user) return;
    api.status().then(setStatus).catch(() => {});
    refreshGroups();
  }, [user, refreshGroups]);

  const navigate = (id) => { window.location.hash = `/${id}`; };
  const changeScope = (key) => { setScope(key); remember('cc_scope', key); };
  const signOut = () => { auth.setToken(null); setUser(null); setSignOutReason(''); };
  const cycleTheme = () => {
    const next = { system: 'light', light: 'dark', dark: 'system' }[theme] || 'system';
    setTheme(next);
    setThemeState(next);
  };

  if (checking) return <Loading />;
  if (!user) return <Login reason={signOutReason} onSignedIn={(u) => { setUser(u); setSignOutReason(''); }} />;

  const { Component } = PAGES.find((p) => p.id === page);
  const scopeGroup = groups.find((g) => g.key === scope);
  const ctx = {
    user, status, groups, refreshGroups, navigate,
    storeGroup: scope || undefined,
    storeGroupName: scopeGroup?.name,
    refreshStatus: () => api.status().then(setStatus).catch(() => {}),
  };

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand"><img src="/favicon.svg" alt="" /><span className="hide-sm">Customer Connect</span></div>
        <nav className="nav" aria-label="Main">
          {PAGES.map((p) => (
            <button key={p.id} type="button" className={page === p.id ? 'active' : ''} onClick={() => navigate(p.id)}
              aria-current={page === p.id ? 'page' : undefined}>{p.label}</button>
          ))}
        </nav>
        <div className="topbar-right">
          <select className="select input-sm scope-select" value={scope} onChange={(e) => changeScope(e.target.value)} aria-label="Store group">
            <option value="">All groups</option>
            {groups.map((g) => <option key={g.key} value={g.key}>{g.name}</option>)}
          </select>
          <button type="button" className="icon-btn" onClick={cycleTheme} title={`Theme: ${theme} (click to change)`} aria-label={`Theme: ${theme}`}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              {THEME_ICONS[theme] || THEME_ICONS.system}
            </svg>
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={signOut} title={user.email}>Sign out</button>
        </div>
      </header>
      {status?.emailMode === 'dry-run' && (
        <div className="banner">
          Dry run: emails are built but not sent. They appear under <a href="#/settings">Settings → Outbox</a>. Add RESEND_API_KEY to send for real.
        </div>
      )}
      <Component key={`${page}:${scope}`} {...ctx} />
    </div>
  );
}
