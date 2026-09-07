import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import type { Account } from '@bloom/contracts';
import { api } from './api';
import { AuthPage, ChangePassphrase } from './auth';
import { AdminInbox } from './pages/AdminInbox';
import { SchoolShell } from './school/SchoolShell';
import { Spinner } from './components';

export function App() {
  const [account, setAccount] = useState<Account | null | undefined>(undefined);
  useEffect(() => { api<Account>('/auth/me').then(setAccount).catch(() => setAccount(null)); }, []);

  const logout = async () => { await api('/auth/logout', { method: 'POST' }); setAccount(null); };
  if (account === undefined) return <main className="center-screen"><Spinner label="Opening your workspace" /></main>;
  if (!account) return <AuthPage onAuthenticated={setAccount} />;
  if (account.firstLogin) return <ChangePassphrase account={account} onChanged={setAccount} />;
  if (account.role === 'ADMIN') return <AdminInbox account={account} onLogout={logout} />;
  if (account.role !== 'SCHOOL') return <DeferredPortal account={account} onLogout={logout} />;

  return <BrowserRouter><Routes>
    <Route path="/*" element={<SchoolShell account={account} onLogout={logout} />} />
    <Route path="*" element={<Navigate to="/home" replace />} />
  </Routes></BrowserRouter>;
}

function DeferredPortal({ account, onLogout }: { account: Account; onLogout: () => void }) {
  return <main className="deferred-page"><div className="brand-mark">b</div><p className="eyebrow">Bloom V2</p><h1>{account.organizationName}</h1><p>Your {account.role === 'COMPOSTER' ? 'composter' : 'farmer and collector'} workspace will arrive after the School portal is approved.</p><button className="button button--quiet" onClick={onLogout}>Sign out</button></main>;
}
