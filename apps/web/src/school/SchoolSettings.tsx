import { Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Account } from '@bloom/contracts';

export function SchoolSettings({ account }: { account: Account; onLogout: () => void }) {
  const [dark, setDark] = useState(() => localStorage.getItem('bloom_theme') === 'dark');
  useEffect(() => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; localStorage.setItem('bloom_theme', dark ? 'dark' : 'light'); }, [dark]);
  return <main className="page settings-page"><section className="page-heading"><div><p className="eyebrow">School workspace</p><h1>Settings</h1><p>Manage the details and appearance of this workspace.</p></div></section><div className="settings-layout"><section className="settings-card"><header><p className="eyebrow">Profile</p><h2>Account</h2></header><dl className="account-details"><div><dt>Account holder</dt><dd>{account.displayName}</dd></div><div><dt>Organization</dt><dd>{account.organizationName}</dd></div><div><dt>Access code</dt><dd>{account.accessCode}</dd></div><div><dt>Role</dt><dd>School</dd></div></dl><p className="security-copy">Your passphrase is stored as a secure hash. For security, your session expires automatically.</p></section><section className="settings-card settings-card--appearance"><header><p className="eyebrow">Display</p><h2>Appearance</h2></header><button className="theme-choice" onClick={() => setDark((value) => !value)}><span>{dark ? <Moon size={24} /> : <Sun size={24} />}</span><div><strong>{dark ? 'Dark workspace' : 'Light workspace'}</strong><small>Use {dark ? 'light' : 'dark'} mode on this device</small></div><i className={dark ? 'on' : ''}><b /></i></button></section></div></main>;
}
