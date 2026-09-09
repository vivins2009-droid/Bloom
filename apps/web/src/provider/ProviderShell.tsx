import { CalendarDays, ChartNoAxesCombined, ClipboardList, Home as HomeIcon, LogOut, Settings } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Account, Pickup } from '@bloom/contracts';
import { Link, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api } from '../api';
import { ThemeButton } from '../auth';
import { AccountSettings } from '../settings/AccountSettings';
import { Dashboard } from './Dashboard';
import { Home } from './Home';
import { MealCalendar } from './MealCalendar';
import { Pickups } from './Pickups';

const nav = [{ to: '/home', label: 'Home', icon: HomeIcon }, { to: '/tracker', label: 'Waste tracker', icon: ChartNoAxesCombined }, { to: '/calendar', label: 'Meal calendar', icon: CalendarDays }, { to: '/pickups', label: 'Pickups', icon: ClipboardList }, { to: '/settings', label: 'Settings', icon: Settings }];

export function ProviderShell({ account, onAccountChanged, onLogout }: { account: Account; onAccountChanged: (account: Account) => void; onLogout: () => void }) {
  const [attention, setAttention] = useState(false);
  useEffect(() => { api<{ data: Pickup[] }>('/pickups').then(({ data }) => setAttention(data.some((pickup) => pickup.status === 'AWAITING_PROVIDER_CONFIRMATION'))).catch(() => setAttention(false)); }, []);
  return <div className="app-layout"><aside className="nav-rail"><nav>{nav.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} aria-label={label}><Icon size={19} /><span>{label}</span></NavLink>)}</nav><button className="rail-logout" onClick={onLogout}><LogOut size={17} /><span>Log out</span></button></aside><div className="app-stage"><header className="app-header"><div className="app-header__actions">{attention && <Link className="attention-pill" to="/pickups">Confirm pickup</Link>}<ThemeButton /></div></header><Routes><Route path="/home" element={<Home />} /><Route path="/tracker" element={<Dashboard account={account} />} /><Route path="/dashboard" element={<Navigate to="/tracker" replace />} /><Route path="/calendar" element={<MealCalendar />} /><Route path="/pickups" element={<Pickups />} /><Route path="/settings" element={<AccountSettings account={account} onAccountChanged={onAccountChanged} />} /><Route path="*" element={<Navigate to="/home" replace />} /></Routes></div><nav className="mobile-nav" aria-label="Primary navigation">{nav.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to}><Icon size={20} /><span>{label === 'Meal calendar' ? 'Calendar' : label}</span></NavLink>)}</nav></div>;
}
