import { Leaf, LogOut, Menu, X, type LucideIcon } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { Account } from '@bloom/contracts';
import { NavLink, useLocation } from 'react-router-dom';
import { ThemeButton } from '../auth';

export type AppNavigationItem = {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
};

export function AppShell({
  account,
  workspace,
  navigation,
  actions,
  onLogout,
  children,
  className = ''
}: {
  account: Account;
  workspace: string;
  navigation: AppNavigationItem[];
  actions?: ReactNode;
  onLogout: () => void;
  children: ReactNode;
  className?: string;
}) {
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  useEffect(() => setDrawerOpen(false), [location.pathname]);
  useEffect(() => {
    if (!drawerOpen) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setDrawerOpen(false); };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [drawerOpen]);
  const current = [...navigation].sort((a, b) => b.to.length - a.to.length).find((item) => item.end ? location.pathname === item.to : location.pathname.startsWith(item.to));
  const initials = account.organizationName.split(/\s+/).slice(0, 2).map((word) => word[0]).join('').toUpperCase();

  return <div className={`app-layout dashboard-shell ${className}`}>
    <aside className={`dashboard-sidebar ${drawerOpen ? 'is-open' : ''}`} aria-label={`${workspace} navigation`}>
      <div className="sidebar-brand"><span className="brand-mark"><Leaf size={18} /></span><div><strong>Bloom</strong><small>Private recovery network</small></div><button className="sidebar-close" onClick={() => setDrawerOpen(false)} aria-label="Close navigation"><X size={19} /></button></div>
      <div className="sidebar-workspace"><span>Workspace</span><strong>{workspace}</strong></div>
      <nav className="sidebar-nav">{navigation.map(({ to, label, icon: Icon, end }) => <NavLink key={to} to={to} end={end}><Icon size={18} aria-hidden="true" /><span>{label}</span></NavLink>)}</nav>
      <div className="sidebar-footer">
        <div className="sidebar-account"><span className="provider-avatar">{initials}</span><div><strong>{account.organizationName}</strong><small>{account.displayName}</small></div></div>
        <div className="sidebar-utilities"><ThemeButton /><button className="sidebar-logout" onClick={onLogout} aria-label="Log out"><LogOut size={18} /><span>Log out</span></button></div>
      </div>
    </aside>
    {drawerOpen && <button className="drawer-backdrop" onClick={() => setDrawerOpen(false)} aria-label="Close navigation" />}
    <div className="app-stage">
      <header className="app-header dashboard-header">
        <button className="menu-button" onClick={() => setDrawerOpen(true)} aria-label="Open navigation" aria-expanded={drawerOpen}><Menu size={20} /></button>
        <div className="header-context"><span>{workspace}</span><strong>{current?.label ?? 'Overview'}</strong></div>
        <div className="app-header__actions">{actions}<span className="header-user">{account.displayName}</span></div>
      </header>
      <div className="dashboard-content">{children}</div>
    </div>
  </div>;
}
