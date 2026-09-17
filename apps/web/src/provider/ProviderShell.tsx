import { CalendarDays, ChartNoAxesCombined, ClipboardList, Home as HomeIcon, MessageCircle, Settings } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Account, Pickup } from '@bloom/contracts';
import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { api } from '../api';
import { AppShell } from '../layout/AppShell';
import { AccountSettings } from '../settings/AccountSettings';
import { Dashboard } from './Dashboard';
import { Home } from './Home';
import { MealCalendar } from './MealCalendar';
import { Pickups } from './Pickups';
import { ChatPage } from '../chat/ChatPage';

const nav = [{ to: '/home', label: 'Home', icon: HomeIcon }, { to: '/tracker', label: 'Waste tracker', icon: ChartNoAxesCombined }, { to: '/calendar', label: 'Meal calendar', icon: CalendarDays }, { to: '/pickups', label: 'Pickups', icon: ClipboardList }, { to: '/chat', label: 'Chat', icon: MessageCircle }, { to: '/settings', label: 'Settings', icon: Settings }];

export function ProviderShell({ account, onAccountChanged, onLogout }: { account: Account; onAccountChanged: (account: Account) => void; onLogout: () => void }) {
  const [attention, setAttention] = useState(false);
  useEffect(() => { api<{ data: Pickup[] }>('/pickups').then(({ data }) => setAttention(data.some((pickup) => pickup.status === 'AWAITING_PROVIDER_CONFIRMATION'))).catch(() => setAttention(false)); }, []);
  return <AppShell account={account} workspace="Food Waste Producer" navigation={nav} onLogout={onLogout} actions={attention && <Link className="attention-pill" to="/pickups">Confirm pickup</Link>}><Routes><Route path="/home" element={<Home />} /><Route path="/tracker" element={<Dashboard account={account} />} /><Route path="/dashboard" element={<Navigate to="/tracker" replace />} /><Route path="/calendar" element={<MealCalendar />} /><Route path="/pickups" element={<Pickups />} /><Route path="/chat" element={<ChatPage account={account} />} /><Route path="/settings" element={<AccountSettings account={account} onAccountChanged={onAccountChanged} />} /><Route path="*" element={<Navigate to="/home" replace />} /></Routes></AppShell>;
}
