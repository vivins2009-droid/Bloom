import { Bell, CalendarDays, ChartNoAxesCombined, ClipboardList, Home as HomeIcon, LogOut, Settings } from 'lucide-react';
import type { Account } from '@bloom/contracts';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { ThemeButton } from '../auth';
import { Dashboard } from './Dashboard';
import { MealCalendar } from './MealCalendar';
import { Pickups } from './Pickups';
import { SchoolSettings } from './SchoolSettings';
import { Home } from './Home';

const nav = [
  { to: '/home', label: 'Home', icon: HomeIcon },
  { to: '/tracker', label: 'Waste tracker', icon: ChartNoAxesCombined },
  { to: '/calendar', label: 'Meal calendar', icon: CalendarDays },
  { to: '/pickups', label: 'Pickups', icon: ClipboardList },
  { to: '/settings', label: 'Settings', icon: Settings }
];

export function SchoolShell({ account, onLogout }: { account: Account; onLogout: () => void }) {
  return <div className="app-layout">
    <aside className="nav-rail">
      <nav>{nav.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} aria-label={label}><Icon size={19} /><span>{label}</span></NavLink>)}</nav>
      <button className="rail-logout" onClick={onLogout}><LogOut size={17} /><span>Log out</span></button>
    </aside>
    <div className="app-stage">
      <header className="app-header"><div className="app-header__actions"><button className="icon-button" aria-label="Notifications"><Bell size={18} /></button><ThemeButton /></div></header>
      <Routes><Route path="/home" element={<Home />} /><Route path="/tracker" element={<Dashboard account={account} />} /><Route path="/dashboard" element={<Navigate to="/tracker" replace />} /><Route path="/calendar" element={<MealCalendar />} /><Route path="/pickups" element={<Pickups />} /><Route path="/settings" element={<SchoolSettings account={account} onLogout={onLogout} />} /><Route path="*" element={<Navigate to="/home" replace />} /></Routes>
    </div>
    <nav className="mobile-nav" aria-label="Primary navigation">{nav.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to}><Icon size={20} /><span>{label === 'Meal calendar' ? 'Calendar' : label}</span></NavLink>)}</nav>
  </div>;
}
