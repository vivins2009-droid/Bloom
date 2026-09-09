import {
  Activity, AlertTriangle, ArrowDown, ArrowRight, ArrowUp, Bell, Building2, Check, ClipboardCheck,
  ClipboardList, Copy, Home, KeyRound, LogOut, MoreHorizontal, PauseCircle, Plus, RotateCcw,
  Search, Settings, SlidersHorizontal, Trash2, UserRoundCheck, UsersRound, X
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { BrowserRouter, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import type {
  AccessRequest, AccessRequestStatus, Account, AccountStatus, AdminAuditEvent, AdminOverview,
  OrganizationNameChangeRequest, OrganizationType, Pickup, PickupStatus, PublicAccountRole
} from '@bloom/contracts';
import { ThemeButton } from '../auth';
import { api } from '../api';
import { Field, Notice, SelectField, Spinner } from '../components';

type Credentials = { accessCode: string; passphrase: string };
type RoleFilter = PublicAccountRole | 'ALL';
const roles: Array<[PublicAccountRole, string]> = [['FOOD_PROVIDER', 'Food provider'], ['FARMER_COLLECTOR', 'Farmer / Collector'], ['COMPOSTER', 'Composter']];
const roleLabel = (role: PublicAccountRole) => roles.find(([value]) => value === role)?.[1] ?? role;
const pickupLabel: Record<PickupStatus, string> = { AVAILABLE: 'Available', RESERVED: 'Reserved', IN_TRANSIT: 'In transit', AWAITING_PROVIDER_CONFIRMATION: 'Awaiting provider confirmation', COLLECTED: 'Collected', CANCELLED: 'Cancelled', EXPIRED: 'Expired' };
const actionLabel = (action: string) => action.toLowerCase().replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase());
const formatDate = (value: string, detail = false) => new Intl.DateTimeFormat('en-IN', detail ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' }).format(new Date(value));

const nav = [
  { to: '/admin/home', label: 'Home', icon: Home },
  { to: '/admin/requests', label: 'Requests', icon: ClipboardCheck },
  { to: '/admin/organizations', label: 'Organizations', icon: UsersRound },
  { to: '/admin/pickups', label: 'Pickups', icon: ClipboardList },
  { to: '/admin/activity', label: 'Activity', icon: Activity }
];

export function AdminPortal({ account, onLogout }: { account: Account; onLogout: () => void }) {
  return <BrowserRouter><AdminShell account={account} onLogout={onLogout} /></BrowserRouter>;
}

function AdminShell({ account, onLogout }: { account: Account; onLogout: () => void }) {
  const location = useLocation(); const navigate = useNavigate();
  const [overview, setOverview] = useState<AdminOverview | null>(null); const [moreOpen, setMoreOpen] = useState(false);
  useEffect(() => { api<AdminOverview>('/admin/overview').then(setOverview).catch(() => setOverview(null)); }, [location.pathname]);
  const attention = (overview?.pendingRequests ?? 0) + (overview?.pendingNameChanges ?? 0) + (overview?.pickupExceptions ?? 0);
  return <div className="app-layout admin-layout">
    <aside className="nav-rail admin-rail">
      <nav>{nav.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to}><Icon size={18} /><span>{label}</span></NavLink>)}</nav>
      <button className="rail-logout" onClick={onLogout}><LogOut size={17} /><span>Log out</span></button>
    </aside>
    <div className="app-stage">
      <header className="app-header admin-header"><span className="admin-context">Network operations</span><div className="app-header__actions">
        <button className="attention-button" onClick={() => navigate(overview?.pendingRequests ? '/admin/requests' : '/admin/pickups')} aria-label={`${attention} items need attention`}><Bell size={18} />{attention > 0 && <b>{attention}</b>}</button>
        <ThemeButton />
      </div></header>
      <Routes>
        <Route path="/admin/home" element={<AdminHome account={account} />} />
        <Route path="/admin/requests" element={<Requests />} />
        <Route path="/admin/organizations" element={<Organizations />} />
        <Route path="/admin/pickups" element={<AdminPickups />} />
        <Route path="/admin/activity" element={<AuditActivity />} />
        <Route path="/admin/settings" element={<AdminSettings account={account} onLogout={onLogout} />} />
        <Route path="*" element={<Navigate to="/admin/home" replace />} />
      </Routes>
    </div>
    <nav className="mobile-nav admin-mobile-nav" aria-label="Primary navigation">{nav.slice(0, 4).map(({ to, label, icon: Icon }) => <NavLink key={to} to={to}><Icon size={19} /><span>{label === 'Organizations' ? 'Network' : label}</span></NavLink>)}<button className={moreOpen ? 'active' : ''} onClick={() => setMoreOpen((value) => !value)}><MoreHorizontal size={20} /><span>More</span></button></nav>
    {moreOpen && <div className="mobile-more" role="dialog" aria-label="More navigation"><NavLink to="/admin/activity" onClick={() => setMoreOpen(false)}><Activity size={19} />Activity</NavLink><NavLink to="/admin/settings" onClick={() => setMoreOpen(false)}><Settings size={19} />Settings</NavLink><button onClick={onLogout}><LogOut size={19} />Log out</button></div>}
  </div>;
}

function PageHeading({ index, eyebrow, title, description, action }: { index: string; eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <header className="admin-page-heading"><span className="section-index">{index}</span><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{description}</p></div>{action}</header>;
}

function AdminHome({ account }: { account: Account }) {
  const [overview, setOverview] = useState<AdminOverview | null>(null); const [error, setError] = useState('');
  const load = () => { setError(''); api<AdminOverview>('/admin/overview').then(setOverview).catch((reason) => setError(reason.message)); };
  useEffect(load, []);
  if (!overview && !error) return <Spinner label="Preparing the operations desk" />;
  if (error) return <AdminError message={error} retry={load} />;
  const metrics = [
    { label: 'Requests waiting', value: overview!.pendingRequests + overview!.pendingNameChanges, to: '/admin/requests', note: `${overview!.pendingRequests} access · ${overview!.pendingNameChanges} name change` },
    { label: 'Active organizations', value: overview!.activeOrganizations, to: '/admin/organizations', note: 'Accounts currently able to sign in' },
    { label: 'Pickup exceptions', value: overview!.pickupExceptions, to: '/admin/pickups', note: overview!.pickupExceptions ? 'Cancelled, expired, or overdue in transit' : 'No exceptions need review' },
    { label: 'Collected in 30 days', value: `${overview!.collectedKgLast30Days.toLocaleString()} kg`, to: '/admin/pickups', note: 'Confirmed recovery, not an estimate' }
  ];
  return <main className="admin-page admin-home">
    <PageHeading index="01" eyebrow="Operations desk" title={`Good ${new Date().getHours() < 12 ? 'morning' : 'afternoon'}, ${account.displayName.replace(/^District\s+/i, '')}.`} description="Start with what needs a decision, then move through the network record." />
    <section className="admin-metrics" aria-label="Network overview">{metrics.map((metric) => <NavLink to={metric.to} className="admin-metric" key={metric.label}><span>{metric.label}</span><strong>{metric.value}</strong><small>{metric.note}</small><ArrowRight size={19} /></NavLink>)}</section>
    <section className="admin-section"><div className="section-title"><div><p className="eyebrow">Latest record</p><h2>Recent activity</h2></div><NavLink className="text-link" to="/admin/activity">Open activity <ArrowRight size={15} /></NavLink></div>
      {overview!.recentActivity.length ? <div className="activity-list compact">{overview!.recentActivity.map((event) => <ActivityRow event={event} key={event.id} />)}</div> : <EmptyState icon={<Activity />} title="No administrative activity yet" description="Approvals, account changes, signup options, and pickup interventions will appear here." />}
    </section>
  </main>;
}

function Requests() {
  const [requests, setRequests] = useState<AccessRequest[]>([]); const [nameRequests, setNameRequests] = useState<OrganizationNameChangeRequest[]>([]); const [types, setTypes] = useState<OrganizationType[]>([]);
  const [query, setQuery] = useState(''); const [role, setRole] = useState<RoleFilter>('ALL'); const [status, setStatus] = useState<AccessRequestStatus | 'ALL'>('PENDING');
  const [error, setError] = useState(''); const [loading, setLoading] = useState(true); const [rejecting, setRejecting] = useState<AccessRequest | null>(null); const [rejectingName, setRejectingName] = useState<OrganizationNameChangeRequest | null>(null); const [approving, setApproving] = useState<string>(''); const [credentials, setCredentials] = useState<Credentials | null>(null);
  const load = () => { setLoading(true); setError(''); Promise.all([api<{ data: AccessRequest[] }>('/admin/access-requests'), api<{ data: OrganizationNameChangeRequest[] }>('/admin/organization-name-requests'), api<{ data: OrganizationType[] }>('/admin/organization-types')]).then(([a, n, t]) => { setRequests(a.data); setNameRequests(n.data); setTypes(t.data); }).catch((reason) => setError(reason.message)).finally(() => setLoading(false)); };
  useEffect(load, []);
  const filtered = useMemo(() => requests.filter((item) => (status === 'ALL' || item.status === status) && (role === 'ALL' || item.role === role) && `${item.organizationName} ${item.applicantName} ${item.contact}`.toLowerCase().includes(query.toLowerCase())), [requests, query, role, status]);
  const approve = async (request: AccessRequest) => { setApproving(request.id); setError(''); try { setCredentials(await api(`/admin/access-requests/${request.id}/approve`, { method: 'POST' })); load(); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Approval failed.'); } finally { setApproving(''); } };
  const reassign = async (request: AccessRequest, organizationTypeId: string) => { try { await api(`/admin/access-requests/${request.id}/type`, { method: 'PATCH', body: JSON.stringify({ organizationTypeId }) }); load(); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Type change failed.'); } };
  const reject = async (reason: string) => { if (!rejecting) return; await api(`/admin/access-requests/${rejecting.id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) }); setRejecting(null); load(); };
  const approveName = async (request: OrganizationNameChangeRequest) => { setApproving(request.id); try { await api(`/admin/organization-name-requests/${request.id}/approve`, { method: 'POST' }); load(); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Name change approval failed.'); } finally { setApproving(''); } };
  const rejectName = async (reason: string) => { if (!rejectingName) return; await api(`/admin/organization-name-requests/${rejectingName.id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) }); setRejectingName(null); load(); };
  return <main className="admin-page">
    <PageHeading index="02" eyebrow="Access desk" title="Requests" description="Decide who joins the network. Approval creates an account and one-time credentials." />
    <FilterBar query={query} onQuery={setQuery}><SelectField value={status} onChange={(event) => setStatus(event.target.value as typeof status)} aria-label="Request status"><option value="PENDING">Pending</option><option value="APPROVED">Approved</option><option value="REJECTED">Rejected</option><option value="ALL">Every status</option></SelectField><RoleSelect value={role} onChange={setRole} /></FilterBar>
    {error && <Notice tone="error">{error}</Notice>}
    {!loading && nameRequests.filter((item) => status === 'ALL' || item.status === status).length > 0 && <section className="admin-section name-request-section"><div className="section-title"><div><p className="eyebrow">Organization identity</p><h2>Name changes</h2></div><span>{nameRequests.filter((item) => item.status === 'PENDING').length} pending</span></div><div className="request-ledger">{nameRequests.filter((item) => status === 'ALL' || item.status === status).map((request) => <article className="request-row name-request-row" key={request.id}><div className="request-row__identity"><span className="status-dot" data-status={request.status} /><div><p className="eyebrow">Name change</p><h2>{request.currentName}</h2><p>Requested {formatDate(request.createdAt)}</p></div></div><div className="name-change"><span>Requested name</span><strong>{request.requestedName}</strong>{request.reason && <p>{request.reason}</p>}{request.rejectionReason && <p>Reason: {request.rejectionReason}</p>}</div>{request.status === 'PENDING' ? <div className="row-actions"><button className="button button--quiet" onClick={() => setRejectingName(request)}>Reject</button><button className="button button--primary" disabled={approving === request.id} onClick={() => approveName(request)}>{approving === request.id ? 'Approving…' : 'Approve name change'}</button></div> : <span className="reviewed-stamp"><Check size={15} /> Reviewed {request.reviewedAt ? formatDate(request.reviewedAt) : ''}</span>}</article>)}</div></section>}
    {loading ? <Spinner label="Loading requests" /> : filtered.length ? <section className="request-ledger access-request-ledger">{filtered.map((request) => {
      const currentType = types.find((type) => type.id === request.organizationTypeId); const typeInactive = !currentType?.active;
      return <article className="request-row" key={request.id}><div className="request-row__identity"><span className="status-dot" data-status={request.status} /><div><p className="eyebrow">{request.organizationTypeName}</p><h2>{request.organizationName}</h2><p>{request.applicantName} · {request.contact}</p></div></div><div className="request-row__detail"><span>{roleLabel(request.role)}</span><span>Requested {formatDate(request.createdAt)}</span>{request.note && <p>“{request.note}”</p>}{request.rejectionReason && <p>Reason: {request.rejectionReason}</p>}</div>{request.status === 'PENDING' ? <div className="row-actions">{typeInactive && <SelectField value="" onChange={(event) => reassign(request, event.target.value)} aria-label={`Reassign ${request.organizationName}`}><option value="">Choose an active type</option>{types.filter((type) => type.role === request.role && type.active).map((type) => <option value={type.id} key={type.id}>{type.name}</option>)}</SelectField>}<button className="button button--quiet" onClick={() => setRejecting(request)}>Reject</button><button className="button button--primary" disabled={typeInactive || approving === request.id} onClick={() => approve(request)}>{approving === request.id ? 'Creating…' : 'Approve & create account'}</button></div> : <span className="reviewed-stamp"><Check size={15} /> Reviewed {request.reviewedAt ? formatDate(request.reviewedAt) : ''}</span>}</article>;
    })}</section> : <EmptyState icon={<ClipboardCheck />} title="No requests in this view" description="Adjust the filters or wait for a new organization to request access." />}
    <ReasonDialog open={Boolean(rejecting)} title={`Reject ${rejecting?.organizationName}?`} description="This closes the request without creating an account. The reason remains in the administrative record." actionLabel="Reject request" onCancel={() => setRejecting(null)} onConfirm={reject} />
    <ReasonDialog open={Boolean(rejectingName)} title={`Reject the name “${rejectingName?.requestedName}”?`} description={`The organization will continue to appear as ${rejectingName?.currentName}. The reason remains in the administrative record.`} actionLabel="Reject name change" onCancel={() => setRejectingName(null)} onConfirm={rejectName} />
    <CredentialsDialog credentials={credentials} onClose={() => setCredentials(null)} />
  </main>;
}

function Organizations() {
  const [accounts, setAccounts] = useState<Account[]>([]); const [types, setTypes] = useState<OrganizationType[]>([]); const [query, setQuery] = useState(''); const [role, setRole] = useState<RoleFilter>('ALL'); const [status, setStatus] = useState<AccountStatus | 'ALL'>('ALL');
  const [error, setError] = useState(''); const [loading, setLoading] = useState(true); const [createOpen, setCreateOpen] = useState(false); const [action, setAction] = useState<{ kind: 'suspend' | 'reactivate' | 'reset'; account: Account } | null>(null); const [credentials, setCredentials] = useState<Credentials | null>(null);
  const load = () => { setLoading(true); Promise.all([api<{ data: Account[] }>('/admin/accounts'), api<{ data: OrganizationType[] }>('/admin/organization-types')]).then(([a, b]) => { setAccounts(a.data); setTypes(b.data); setError(''); }).catch((reason) => setError(reason.message)).finally(() => setLoading(false)); };
  useEffect(load, []);
  const filtered = accounts.filter((item) => (role === 'ALL' || item.role === role) && (status === 'ALL' || item.status === status) && `${item.organizationName} ${item.displayName} ${item.accessCode}`.toLowerCase().includes(query.toLowerCase()));
  const changeType = async (account: Account, organizationTypeId: string) => { try { await api(`/admin/accounts/${account.id}/type`, { method: 'PATCH', body: JSON.stringify({ organizationTypeId }) }); load(); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Account update failed.'); } };
  const perform = async (reason: string) => { if (!action) return; if (action.kind === 'reset') setCredentials(await api(`/admin/accounts/${action.account.id}/reset-passphrase`, { method: 'POST', body: JSON.stringify({ reason }) })); else await api(`/admin/accounts/${action.account.id}/status`, { method: 'POST', body: JSON.stringify({ status: action.kind === 'suspend' ? 'SUSPENDED' : 'ACTIVE', reason }) }); setAction(null); load(); };
  return <main className="admin-page"><PageHeading index="03" eyebrow="Network registry" title="Organizations" description="Manage the people who can enter Bloom and the labels applicants see before they join." action={<button className="button button--primary" onClick={() => setCreateOpen(true)}><Plus size={17} /> Create account</button>} />
    {error && <Notice tone="error">{error}</Notice>}
    <section className="admin-section"><div className="section-title"><div><p className="eyebrow">Accounts</p><h2>Network registry</h2></div><span>{accounts.length} records</span></div><FilterBar query={query} onQuery={setQuery}><RoleSelect value={role} onChange={setRole} /><SelectField value={status} onChange={(event) => setStatus(event.target.value as typeof status)} aria-label="Account status"><option value="ALL">Every status</option><option value="ACTIVE">Active</option><option value="SUSPENDED">Suspended</option></SelectField></FilterBar>
      {loading ? <Spinner label="Loading organizations" /> : filtered.length ? <div className="account-ledger">{filtered.map((account) => <article className="account-row" key={account.id}><div className="account-monogram">{account.organizationName.slice(0, 2).toUpperCase()}</div><div><h3>{account.organizationName}</h3><p>{account.displayName} · {account.contact || 'No contact recorded'}</p><small>{account.accessCode} · {roleLabel(account.role as PublicAccountRole)}</small></div><SelectField value={account.organizationTypeId} onChange={(event) => changeType(account, event.target.value)} aria-label={`Organization type for ${account.organizationName}`}>{types.filter((type) => type.role === account.role && type.active).map((type) => <option value={type.id} key={type.id}>{type.name}</option>)}</SelectField><span className={`account-state ${account.status.toLowerCase()}`}>{account.status.toLowerCase()}</span><div className="icon-actions"><button onClick={() => setAction({ kind: 'reset', account })} aria-label={`Reset passphrase for ${account.organizationName}`}><KeyRound size={17} /></button><button onClick={() => setAction({ kind: account.status === 'ACTIVE' ? 'suspend' : 'reactivate', account })} aria-label={`${account.status === 'ACTIVE' ? 'Suspend' : 'Reactivate'} ${account.organizationName}`}>{account.status === 'ACTIVE' ? <PauseCircle size={17} /> : <RotateCcw size={17} />}</button></div></article>)}</div> : <EmptyState icon={<UsersRound />} title="No organizations match" description="Clear the filters or create a new account." />}
    </section>
    <OrganizationTypes types={types} reload={load} onError={setError} />
    <CreateAccountDialog open={createOpen} types={types} onClose={() => setCreateOpen(false)} onCreated={(result) => { setCreateOpen(false); setCredentials(result); load(); }} />
    <ReasonDialog open={Boolean(action)} title={action?.kind === 'reset' ? `Reset ${action.account.organizationName}’s passphrase?` : `${action?.kind === 'suspend' ? 'Suspend' : 'Reactivate'} ${action?.account.organizationName}?`} description={action?.kind === 'reset' ? 'Their current sessions will end. A new one-time passphrase will be shown once.' : action?.kind === 'suspend' ? 'They will be signed out and unable to enter Bloom until reactivated.' : 'They will be able to sign in again with their existing credentials.'} actionLabel={action?.kind === 'reset' ? 'Reset passphrase' : action?.kind === 'suspend' ? 'Suspend account' : 'Reactivate account'} onCancel={() => setAction(null)} onConfirm={perform} />
    <CredentialsDialog credentials={credentials} onClose={() => setCredentials(null)} />
  </main>;
}

function OrganizationTypes({ types, reload, onError }: { types: OrganizationType[]; reload: () => void; onError: (message: string) => void }) {
  const [role, setRole] = useState<PublicAccountRole>('FOOD_PROVIDER'); const [name, setName] = useState(''); const [remove, setRemove] = useState<OrganizationType | null>(null);
  const visible = types.filter((type) => type.role === role).sort((a, b) => a.sortOrder - b.sortOrder);
  const request = async (path: string, init: RequestInit) => { try { await api(path, init); reload(); } catch (reason) { onError(reason instanceof Error ? reason.message : 'Signup option update failed.'); } };
  const add = async (event: FormEvent) => { event.preventDefault(); if (!name.trim()) return; await request('/admin/organization-types', { method: 'POST', body: JSON.stringify({ role, name }) }); setName(''); };
  const move = (type: OrganizationType, delta: number) => request(`/admin/organization-types/${type.id}`, { method: 'PATCH', body: JSON.stringify({ sortOrder: Math.max(0, type.sortOrder + delta) }) });
  return <section className="admin-section taxonomy"><div className="section-title"><div><p className="eyebrow">Public signup</p><h2>Organization types</h2></div><p>Changes appear on the access form immediately.</p></div><div className="role-tabs" role="tablist">{roles.map(([value, label]) => <button key={value} role="tab" aria-selected={role === value} onClick={() => setRole(value)}>{label}<span>{types.filter((type) => type.role === value && type.active).length}</span></button>)}</div>
    <form className="add-type" onSubmit={add}><Field label="Add an option"><input value={name} onChange={(event) => setName(event.target.value)} placeholder={`e.g. ${role === 'FOOD_PROVIDER' ? 'Hospital kitchen' : role === 'FARMER_COLLECTOR' ? 'Food rescue group' : 'Anaerobic digester'}`} /></Field><button className="button button--primary" disabled={name.trim().length < 2}><Plus size={17} /> Add option</button></form>
    <div className="type-list">{visible.map((type, index) => <TypeRow type={type} first={index === 0} last={index === visible.length - 1} key={type.id} onMove={move} onUpdate={(body) => request(`/admin/organization-types/${type.id}`, { method: 'PATCH', body: JSON.stringify(body) })} onRemove={() => setRemove(type)} />)}</div>
    <ReasonlessDialog open={Boolean(remove)} title={`Remove “${remove?.name}”?`} description="If an account or request uses this type, it will be archived and disappear from new requests. Otherwise it will be deleted." actionLabel="Remove option" onCancel={() => setRemove(null)} onConfirm={async () => { if (remove) await request(`/admin/organization-types/${remove.id}`, { method: 'DELETE' }); setRemove(null); }} />
  </section>;
}

function TypeRow({ type, first, last, onMove, onUpdate, onRemove }: { type: OrganizationType; first: boolean; last: boolean; onMove: (type: OrganizationType, delta: number) => void; onUpdate: (body: Partial<OrganizationType>) => void; onRemove: () => void }) {
  const [name, setName] = useState(type.name); useEffect(() => setName(type.name), [type.name]);
  return <article className={`type-row ${type.active ? '' : 'inactive'}`}><span className="type-order">{String(type.sortOrder + 1).padStart(2, '0')}</span><input value={name} onChange={(event) => setName(event.target.value)} aria-label={`Name for ${type.name}`} /><button className="text-link" disabled={name.trim() === type.name || name.trim().length < 2} onClick={() => onUpdate({ name: name.trim() })}>Save</button><button className={`mini-toggle ${type.active ? 'on' : ''}`} onClick={() => onUpdate({ active: !type.active })} aria-label={`${type.active ? 'Disable' : 'Enable'} ${type.name}`}><i /></button><div className="icon-actions"><button disabled={first} onClick={() => onMove(type, -1)} aria-label={`Move ${type.name} up`}><ArrowUp size={16} /></button><button disabled={last} onClick={() => onMove(type, 1)} aria-label={`Move ${type.name} down`}><ArrowDown size={16} /></button><button onClick={onRemove} aria-label={`Remove ${type.name}`}><Trash2 size={16} /></button></div></article>;
}

function AdminPickups() {
  const [pickups, setPickups] = useState<Pickup[]>([]); const [accounts, setAccounts] = useState<Account[]>([]); const [error, setError] = useState(''); const [loading, setLoading] = useState(true); const [selected, setSelected] = useState<{ pickup: Pickup; action: 'CANCEL' | 'EXPIRE' | 'REOPEN' } | null>(null);
  const load = () => { setLoading(true); Promise.all([api<{ data: Pickup[] }>('/pickups'), api<{ data: Account[] }>('/admin/accounts')]).then(([p, a]) => { setPickups(p.data); setAccounts(a.data); setError(''); }).catch((reason) => setError(reason.message)).finally(() => setLoading(false)); };
  useEffect(load, []);
  const overdueInTransit = (item: Pickup) => item.status === 'IN_TRANSIT' && new Date(item.pickupDeadline).getTime() < Date.now();
  const exceptions = pickups.filter((item) => ['CANCELLED', 'EXPIRED'].includes(item.status) || overdueInTransit(item));
  const active = pickups.filter((item) => !['CANCELLED', 'EXPIRED', 'COLLECTED'].includes(item.status) && !overdueInTransit(item));
  const collected = pickups.filter((item) => item.status === 'COLLECTED');
  const provider = (id: string) => accounts.find((item) => item.id === id)?.organizationName ?? 'Unknown provider';
  const override = async (reason: string) => { if (!selected) return; await api(`/admin/pickups/${selected.pickup.id}/override`, { method: 'POST', body: JSON.stringify({ action: selected.action, reason }) }); setSelected(null); load(); };
  return <main className="admin-page"><PageHeading index="04" eyebrow="Recovery oversight" title="Pickups" description="Monitor the collection record and intervene only when an exception needs an administrator." />{error && <Notice tone="error">{error}</Notice>}{loading ? <Spinner label="Loading pickups" /> : <>
    <PickupGroup title="Needs review" note="Cancelled, expired, or overdue in transit" pickups={exceptions} provider={provider} onAction={setSelected} />
    <PickupGroup title="Active movement" note="Available through confirmation" pickups={active} provider={provider} onAction={setSelected} />
    <PickupGroup title="Confirmed history" note="Collected" pickups={collected} provider={provider} onAction={setSelected} compact />
  </>}
    <ReasonDialog open={Boolean(selected)} title={`${selected?.action === 'REOPEN' ? 'Reopen' : selected?.action === 'EXPIRE' ? 'Expire' : 'Cancel'} this pickup?`} description={`${provider(selected?.pickup.providerId ?? '')} will see the updated state. The reason is stored in the audit record.`} actionLabel={`${selected?.action === 'REOPEN' ? 'Reopen' : selected?.action === 'EXPIRE' ? 'Expire' : 'Cancel'} pickup`} onCancel={() => setSelected(null)} onConfirm={override} />
  </main>;
}

function PickupGroup({ title, note, pickups, provider, onAction, compact = false }: { title: string; note: string; pickups: Pickup[]; provider: (id: string) => string; onAction: (selection: { pickup: Pickup; action: 'CANCEL' | 'EXPIRE' | 'REOPEN' }) => void; compact?: boolean }) {
  return <section className={`admin-section pickup-ledger ${compact ? 'compact' : ''}`}><div className="section-title"><div><h2>{title}</h2><p>{note}</p></div><span>{pickups.length}</span></div>{pickups.length ? pickups.map((pickup) => <article className="admin-pickup-row" key={pickup.id}><div><span className="pickup-weight">{pickup.estimatedWeightKg}<small>kg</small></span></div><div><p className="eyebrow">{pickupLabel[pickup.status]}</p><h3>{provider(pickup.providerId)}</h3><p>Published {formatDate(pickup.createdAt, true)} · Updated {formatDate(pickup.updatedAt, true)}</p></div><div className="row-actions">{pickup.status === 'AVAILABLE' && <button className="button button--quiet" onClick={() => onAction({ pickup, action: 'EXPIRE' })}>Expire</button>}{!['COLLECTED', 'CANCELLED', 'EXPIRED'].includes(pickup.status) && <button className="button button--quiet" onClick={() => onAction({ pickup, action: 'CANCEL' })}>Cancel</button>}{['CANCELLED', 'EXPIRED'].includes(pickup.status) && <button className="button button--primary" onClick={() => onAction({ pickup, action: 'REOPEN' })}>Reopen</button>}</div></article>) : <EmptyState icon={<ClipboardList />} title={`No ${title.toLowerCase()}`} description={title === 'Needs review' ? 'Pickup exceptions will appear here.' : 'There are no pickups in this state.'} />}</section>;
}

function AuditActivity() {
  const [events, setEvents] = useState<AdminAuditEvent[]>([]); const [query, setQuery] = useState(''); const [objectType, setObjectType] = useState('ALL'); const [error, setError] = useState(''); const [loading, setLoading] = useState(true);
  const load = () => { setLoading(true); api<{ data: AdminAuditEvent[] }>('/admin/audit-events').then(({ data }) => { setEvents(data); setError(''); }).catch((reason) => setError(reason.message)).finally(() => setLoading(false)); }; useEffect(load, []);
  const filtered = events.filter((event) => (objectType === 'ALL' || event.objectType === objectType) && `${event.objectLabel} ${event.summary} ${event.actorName} ${event.reason ?? ''}`.toLowerCase().includes(query.toLowerCase()));
  return <main className="admin-page"><PageHeading index="05" eyebrow="Accountability" title="Activity" description="A durable record of decisions that changed access, signup, or collection state." /><FilterBar query={query} onQuery={setQuery}><SelectField value={objectType} onChange={(event) => setObjectType(event.target.value)} aria-label="Activity type"><option value="ALL">Every activity</option><option value="ACCESS_REQUEST">Access requests</option><option value="ACCOUNT">Accounts</option><option value="ORGANIZATION_TYPE">Signup options</option><option value="PICKUP">Pickups</option></SelectField></FilterBar>{error && <Notice tone="error">{error}</Notice>}{loading ? <Spinner label="Loading activity" /> : filtered.length ? <section className="activity-list">{filtered.map((event) => <ActivityRow event={event} key={event.id} />)}</section> : <EmptyState icon={<Activity />} title="No activity matches" description="Clear the search or wait for a new administrative action." />}</main>;
}

function ActivityRow({ event }: { event: AdminAuditEvent }) { return <article className="activity-row"><span className="activity-mark"><Activity size={16} /></span><div><p className="eyebrow">{actionLabel(event.action)}</p><h3>{event.objectLabel}</h3><p>{event.summary}{event.reason ? ` Reason: ${event.reason}` : ''}</p></div><div><strong>{event.actorName}</strong><time dateTime={event.createdAt}>{formatDate(event.createdAt, true)}</time></div></article>; }

function AdminSettings({ account, onLogout }: { account: Account; onLogout: () => void }) { return <main className="admin-page"><PageHeading index="06" eyebrow="Administration" title="Settings" description="Your account details and the appearance of this device." /><section className="settings-spread"><div className="settings-column"><h2>Account</h2><dl className="account-definition"><div><dt>Account holder</dt><dd>{account.displayName}</dd></div><div><dt>Organization</dt><dd>{account.organizationName}</dd></div><div><dt>Access code</dt><dd>{account.accessCode}</dd></div><div><dt>Role</dt><dd>Administrator</dd></div></dl></div><div className="settings-column"><h2>Appearance</h2><div className="setting-tile"><span><SlidersHorizontal size={22} /></span><div><h3>Workspace theme</h3><p>Switch between the pale mint workspace and the dark operations view.</p></div><ThemeButton /></div><button className="button button--quiet settings-logout" onClick={onLogout}><LogOut size={17} /> Sign out of Bloom</button></div></section></main>; }

function FilterBar({ query, onQuery, children }: { query: string; onQuery: (value: string) => void; children?: ReactNode }) { return <div className="filter-bar"><label><Search size={17} /><span className="sr-only">Search</span><input value={query} onChange={(event) => onQuery(event.target.value)} placeholder="Search records" /></label>{children}</div>; }
function RoleSelect({ value, onChange }: { value: RoleFilter; onChange: (role: RoleFilter) => void }) { return <SelectField value={value} onChange={(event) => onChange(event.target.value as RoleFilter)} aria-label="Account role"><option value="ALL">Every role</option>{roles.map(([role, label]) => <option value={role} key={role}>{label}</option>)}</SelectField>; }
function EmptyState({ icon, title, description }: { icon: ReactNode; title: string; description: string }) { return <div className="admin-empty"><span>{icon}</span><h3>{title}</h3><p>{description}</p></div>; }
function AdminError({ message, retry }: { message: string; retry: () => void }) { return <main className="admin-page"><div className="admin-empty"><span><AlertTriangle /></span><h2>That view could not be loaded</h2><p>{message}</p><button className="button button--primary" onClick={retry}>Try again</button></div></main>; }

function DialogFrame({ open, title, description, children, onClose }: { open: boolean; title: string; description: string; children: ReactNode; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null); useEffect(() => { if (open) closeRef.current?.focus(); }, [open]);
  if (!open) return null;
  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="dialog admin-dialog" role="dialog" aria-modal="true" aria-labelledby="admin-dialog-title"><button ref={closeRef} className="dialog-close" onClick={onClose} aria-label="Close dialog"><X size={18} /></button><p className="eyebrow">Administrative action</p><h2 id="admin-dialog-title">{title}</h2><p>{description}</p>{children}</section></div>;
}
function ReasonDialog({ open, title, description, actionLabel, onCancel, onConfirm }: { open: boolean; title: string; description: string; actionLabel: string; onCancel: () => void; onConfirm: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); useEffect(() => { if (open) { setReason(''); setError(''); } }, [open]);
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(''); try { await onConfirm(reason); } catch (value) { setError(value instanceof Error ? value.message : 'The action could not be completed.'); } finally { setBusy(false); } };
  return <DialogFrame open={open} title={title} description={description} onClose={onCancel}><form onSubmit={submit}><Field label="Reason" hint="Stored in the visible activity record."><textarea rows={3} value={reason} onChange={(event) => setReason(event.target.value)} minLength={3} maxLength={300} required autoFocus /></Field>{error && <Notice tone="error">{error}</Notice>}<div className="dialog-actions"><button type="button" className="button button--quiet" onClick={onCancel}>Go back</button><button className="button button--danger" disabled={busy || reason.trim().length < 3}>{busy ? 'Working…' : actionLabel}</button></div></form></DialogFrame>;
}
function ReasonlessDialog({ open, title, description, actionLabel, onCancel, onConfirm }: { open: boolean; title: string; description: string; actionLabel: string; onCancel: () => void; onConfirm: () => Promise<void> }) { const [busy, setBusy] = useState(false); return <DialogFrame open={open} title={title} description={description} onClose={onCancel}><div className="dialog-actions"><button className="button button--quiet" onClick={onCancel}>Keep option</button><button className="button button--danger" disabled={busy} onClick={async () => { setBusy(true); await onConfirm(); setBusy(false); }}>{busy ? 'Removing…' : actionLabel}</button></div></DialogFrame>; }

function CredentialsDialog({ credentials, onClose }: { credentials: Credentials | null; onClose: () => void }) { const [copied, setCopied] = useState(''); const copy = async (label: string, value: string) => { await navigator.clipboard.writeText(value); setCopied(label); }; return <DialogFrame open={Boolean(credentials)} title="Credentials ready" description="Deliver these manually. The one-time passphrase will not be shown again after this window closes." onClose={onClose}><div className="credentials"><div><span>Access code</span><strong>{credentials?.accessCode}</strong><button onClick={() => copy('code', credentials?.accessCode ?? '')} aria-label="Copy access code">{copied === 'code' ? <Check size={17} /> : <Copy size={17} />}</button></div><div><span>One-time passphrase</span><strong>{credentials?.passphrase}</strong><button onClick={() => copy('passphrase', credentials?.passphrase ?? '')} aria-label="Copy one-time passphrase">{copied === 'passphrase' ? <Check size={17} /> : <Copy size={17} />}</button></div></div><div className="dialog-actions"><button className="button button--primary" onClick={onClose}>I have saved these</button></div></DialogFrame>; }

function CreateAccountDialog({ open, types, onClose, onCreated }: { open: boolean; types: OrganizationType[]; onClose: () => void; onCreated: (credentials: Credentials) => void }) {
  const [form, setForm] = useState({ role: 'FOOD_PROVIDER' as PublicAccountRole, organizationTypeId: '', displayName: '', organizationName: '', contact: '' }); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  useEffect(() => { if (open) setForm((current) => ({ ...current, organizationTypeId: types.find((type) => type.role === current.role && type.active)?.id ?? '' })); }, [open, types]);
  const change = (key: keyof typeof form, value: string) => setForm((current) => ({ ...current, [key]: value }));
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(''); try { const result = await api<{ account: Account } & Credentials>('/admin/accounts', { method: 'POST', body: JSON.stringify(form) }); onCreated({ accessCode: result.accessCode, passphrase: result.passphrase }); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Account creation failed.'); } finally { setBusy(false); } };
  return <DialogFrame open={open} title="Create an account" description="Create direct access without a public request. Credentials are revealed once after creation." onClose={onClose}><form className="dialog-form" onSubmit={submit}><div className="field-grid"><Field label="Role"><SelectField value={form.role} onChange={(event) => { const role = event.target.value as PublicAccountRole; setForm((current) => ({ ...current, role, organizationTypeId: types.find((type) => type.role === role && type.active)?.id ?? '' })); }}>{roles.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</SelectField></Field><Field label="Organization type"><SelectField value={form.organizationTypeId} onChange={(event) => change('organizationTypeId', event.target.value)} required>{types.filter((type) => type.role === form.role && type.active).map((type) => <option value={type.id} key={type.id}>{type.name}</option>)}</SelectField></Field></div><Field label="Account holder"><input value={form.displayName} onChange={(event) => change('displayName', event.target.value)} required /></Field><Field label="Organization"><input value={form.organizationName} onChange={(event) => change('organizationName', event.target.value)} required /></Field><Field label="Email or phone"><input value={form.contact} onChange={(event) => change('contact', event.target.value)} required /></Field>{error && <Notice tone="error">{error}</Notice>}<div className="dialog-actions"><button type="button" className="button button--quiet" onClick={onClose}>Cancel</button><button className="button button--primary" disabled={busy || !form.organizationTypeId}>{busy ? 'Creating…' : 'Create account'}</button></div></form></DialogFrame>;
}
