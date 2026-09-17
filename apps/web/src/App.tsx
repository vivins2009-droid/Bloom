import { useEffect, useState } from 'react';
import { BrowserRouter } from 'react-router-dom';
import type { Account } from '@bloom/contracts';
import { api } from './api';
import { AccountLinkPage, AuthPage, ChangePassphrase } from './auth';
import { AdminPortal } from './admin/AdminPortal';
import { ProviderShell } from './provider/ProviderShell';
import { RecoveryPortal } from './recovery/RecoveryPortal';
import { Spinner } from './components';

export function App() {
  const accountLinkPurpose = window.location.pathname === '/setup-account' ? 'SETUP' : window.location.pathname === '/reset-passphrase' ? 'RESET' : null;
  const [account, setAccount] = useState<Account | null | undefined>(undefined);
  useEffect(() => { api<Account>('/auth/me').then(setAccount).catch(() => setAccount(null)); }, []);

  const logout = async () => { await api('/auth/logout', { method: 'POST' }); setAccount(null); };
  if (account === undefined) return <main className="center-screen"><Spinner label="Opening your workspace" /></main>;
  if (!account && accountLinkPurpose) return <AccountLinkPage purpose={accountLinkPurpose} />;
  if (!account) return <AuthPage onAuthenticated={setAccount} />;
  if (account.firstLogin) return <ChangePassphrase account={account} onChanged={setAccount} />;
  if (account.role === 'ADMIN') return <AdminPortal account={account} onLogout={logout} />;
  if (account.role === 'FOOD_WASTE_PRODUCER') return <BrowserRouter><ProviderShell account={account} onAccountChanged={setAccount} onLogout={logout} /></BrowserRouter>;
  return <BrowserRouter><RecoveryPortal account={account} onAccountChanged={setAccount} onLogout={logout} /></BrowserRouter>;
}
