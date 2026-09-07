import { Check, Clipboard, Inbox, LogOut, ShieldCheck, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AccessRequest, Account } from '@bloom/contracts';
import { api } from '../api';
import { Notice, Spinner } from '../components';
import { ThemeButton } from '../auth';

export function AdminInbox({ account, onLogout }: { account: Account; onLogout: () => void }) {
  const [requests, setRequests] = useState<AccessRequest[] | null>(null);
  const [error, setError] = useState(''); const [credentials, setCredentials] = useState<{ accessCode: string; passphrase: string } | null>(null);
  const load = () => { setError(''); api<{ data: AccessRequest[] }>('/admin/access-requests').then((body) => setRequests(body.data)).catch((reason) => setError(reason.message)); };
  useEffect(() => { window.history.replaceState({}, '', '/admin'); load(); }, []);
  const review = async (id: string, action: 'approve' | 'reject') => {
    try {
      if (action === 'approve') setCredentials(await api(`/admin/access-requests/${id}/approve`, { method: 'POST' }));
      else await api(`/admin/access-requests/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason: 'Application did not meet the current onboarding requirements.' }) });
      load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'The request could not be reviewed.'); }
  };
  const pending = requests?.filter((item) => item.status === 'PENDING') ?? [];
  return <div className="admin-layout">
    <header className="admin-header"><a className="wordmark" href="/"><span className="brand-mark">b</span><span>Bloom</span><small>District desk</small></a><div><ThemeButton /><button className="icon-button" onClick={onLogout} aria-label="Sign out"><LogOut size={18} /></button></div></header>
    <main className="admin-main">
      <section className="page-heading"><div><p className="eyebrow">Action queue</p><h1>Good afternoon, {account.displayName.split(' ')[0]}.</h1><p>Review access requests before they delay a school or recovery partner.</p></div><span className="queue-count"><strong>{pending.length}</strong> awaiting review</span></section>
      {error && <Notice tone="error"><span>{error}</span><button onClick={load}>Try again</button></Notice>}
      {!requests ? <Spinner label="Loading access requests" /> : pending.length === 0 ? <section className="empty-state"><span><Inbox size={24} /></span><h2>No access requests waiting</h2><p>New requests will appear here for review.</p></section> : <section className="request-list" aria-label="Pending access requests">
        {pending.map((request) => <article className="request-row" key={request.id}>
          <div className="request-avatar">{request.organizationName.slice(0, 2).toUpperCase()}</div>
          <div className="request-copy"><div><h2>{request.organizationName}</h2><span className="tag">{request.role === 'FARMER_COLLECTOR' ? 'Farmer / Collector' : request.role[0] + request.role.slice(1).toLowerCase()}</span></div><p>{request.applicantName} · {request.contact}</p>{request.note && <blockquote>{request.note}</blockquote>}<small>Requested {new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(Math.round((new Date(request.createdAt).getTime() - Date.now()) / 86400000), 'day')}</small></div>
          <div className="request-actions"><button className="button button--quiet" onClick={() => review(request.id, 'reject')}><X size={16} /> Reject request</button><button className="button button--primary" onClick={() => review(request.id, 'approve')}><Check size={16} /> Approve account</button></div>
        </article>)}
      </section>}
      <section className="admin-preview"><ShieldCheck size={20} /><div><h2>Operations analysis comes next</h2><p>The full admin dashboard will be built from verified logs after the School experience is approved. No demo statistics are shown here.</p></div></section>
    </main>
    {credentials && <div className="dialog-backdrop" role="presentation"><section className="dialog" role="dialog" aria-modal="true" aria-labelledby="credentials-title"><p className="eyebrow">Account approved</p><h2 id="credentials-title">Copy these credentials now</h2><p>The one-time passphrase is only shown in this window. Send both values to the applicant using your approved channel.</p><dl className="credentials"><div><dt>Access code</dt><dd>{credentials.accessCode}<button onClick={() => navigator.clipboard.writeText(credentials.accessCode)} aria-label="Copy access code"><Clipboard size={16} /></button></dd></div><div><dt>One-time passphrase</dt><dd>{credentials.passphrase}<button onClick={() => navigator.clipboard.writeText(credentials.passphrase)} aria-label="Copy one-time passphrase"><Clipboard size={16} /></button></dd></div></dl><button className="button button--primary button--wide" onClick={() => setCredentials(null)}>I have copied the credentials</button></section></div>}
  </div>;
}
