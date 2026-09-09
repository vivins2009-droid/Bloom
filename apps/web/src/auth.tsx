import { ArrowLeft, ArrowRight, CheckCircle2, Eye, EyeOff, Leaf, Moon, Sun } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import type { Account, OrganizationType, PublicAccountRole } from '@bloom/contracts';
import { api } from './api';
import { Field, Notice, SelectField } from './components';

type AuthMode = 'signin' | 'request';

export function ThemeButton() {
  const [dark, setDark] = useState(() => localStorage.getItem('bloom_theme') === 'dark');
  useEffect(() => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; localStorage.setItem('bloom_theme', dark ? 'dark' : 'light'); }, [dark]);
  return <button className="icon-button" onClick={() => setDark((value) => !value)} aria-label={dark ? 'Use light theme' : 'Use dark theme'}>{dark ? <Sun size={18} /> : <Moon size={18} />}</button>;
}

export function AuthPage({ onAuthenticated }: { onAuthenticated: (account: Account) => void }) {
  const [mode, setMode] = useState<AuthMode>('signin');
  return <main className="auth-page">
    <div className="auth-top"><a className="wordmark" href="/"><span className="brand-mark">b</span><span>Bloom</span></a><ThemeButton /></div>
    <section className="auth-story">
      <p className="eyebrow">Food service, thoughtfully managed</p>
      <h1>Bloom</h1>
      <p>Plan every service with confidence, understand what comes back, and connect useful surplus with local recovery partners.</p>
      <div className="auth-flow" aria-label="Bloom workflow"><span>Plan</span><i /><span>Record</span><i /><span>Recover</span></div>
    </section>
    <section className="auth-panel">
      <div className="auth-switch" role="tablist" aria-label="Account access">
        <button role="tab" aria-selected={mode === 'signin'} onClick={() => setMode('signin')}>Sign in</button>
        <button role="tab" aria-selected={mode === 'request'} onClick={() => setMode('request')}>Request access</button>
      </div>
      {mode === 'signin' ? <SignIn onAuthenticated={onAuthenticated} /> : <RequestAccess onBack={() => setMode('signin')} />}
    </section>
  </main>;
}

function SignIn({ onAuthenticated }: { onAuthenticated: (account: Account) => void }) {
  const [accessCode, setAccessCode] = useState(''); const [passphrase, setPassphrase] = useState('');
  const [show, setShow] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try { onAuthenticated(await api<Account>('/auth/login', { method: 'POST', body: JSON.stringify({ accessCode, passphrase }) })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Sign in failed.'); }
    finally { setBusy(false); }
  };
  return <form className="auth-form" onSubmit={submit}>
    <header><p className="eyebrow">Welcome back</p><h2>Open your workspace</h2><p>Use the credentials assigned by the district administrator.</p></header>
    {error && <Notice tone="error">{error}</Notice>}
    <Field label="Access code"><input autoComplete="username" value={accessCode} onChange={(event) => setAccessCode(event.target.value)} placeholder="e.g. SCH-8F2A1C" required /></Field>
    <Field label="Passphrase"><span className="password-field"><input type={show ? 'text' : 'password'} autoComplete="current-password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} placeholder="Enter your passphrase" required /><button type="button" onClick={() => setShow((value) => !value)} aria-label={show ? 'Hide passphrase' : 'Show passphrase'}>{show ? <EyeOff size={17} /> : <Eye size={17} />}</button></span></Field>
    <button className="button button--primary button--wide" disabled={busy}>{busy && <i className="button-spinner" />}{busy ? 'Signing in' : 'Sign in'}<ArrowRight size={17} /></button>
    <p className="demo-note">Local demo: <code>SCH-DEMO</code> / <code>bloom-school</code></p>
  </form>;
}

function RequestAccess({ onBack }: { onBack: () => void }) {
  const [form, setForm] = useState({ applicantName: '', role: 'FOOD_PROVIDER' as PublicAccountRole, organizationTypeId: '', organizationName: '', contact: '', note: '' });
  const [types, setTypes] = useState<OrganizationType[]>([]); const [loadingTypes, setLoadingTypes] = useState(true);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [sent, setSent] = useState(false);
  const loadTypes = () => { setLoadingTypes(true); setError(''); api<{ data: OrganizationType[] }>('/organization-types').then(({ data }) => { setTypes(data); setForm((current) => ({ ...current, organizationTypeId: data.find((item) => item.role === current.role)?.id ?? '' })); }).catch((reason) => setError(reason instanceof Error ? reason.message : 'Signup options could not be loaded.')).finally(() => setLoadingTypes(false)); };
  useEffect(loadTypes, []);
  const change = (key: keyof typeof form, value: string) => setForm((current) => ({ ...current, [key]: value }));
  const changeRole = (role: PublicAccountRole) => setForm((current) => ({ ...current, role, organizationTypeId: types.find((item) => item.role === role)?.id ?? '' }));
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try { await api('/access-requests', { method: 'POST', body: JSON.stringify(form) }); setSent(true); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'The request could not be sent.'); }
    finally { setBusy(false); }
  };
  if (sent) return <div className="auth-success"><CheckCircle2 size={34} /><p className="eyebrow">Request received</p><h2>Your request is with the district team.</h2><p>An administrator will review your organization and contact you with an access code and one-time passphrase.</p><button className="button button--quiet" onClick={onBack}><ArrowLeft size={16} /> Return to sign in</button></div>;
  return <form className="auth-form" onSubmit={submit}>
    <header><p className="eyebrow">Join the network</p><h2>Request an account</h2><p>Tell the district team who you are. Operational details come after approval.</p></header>
    {error && <Notice tone="error">{error} {loadingTypes ? null : <button type="button" className="notice-link" onClick={loadTypes}>Try again</button>}</Notice>}
    <div className="field-grid"><Field label="Your name"><input value={form.applicantName} onChange={(e) => change('applicantName', e.target.value)} required /></Field><Field label="Account role"><SelectField value={form.role} onChange={(e) => changeRole(e.target.value as PublicAccountRole)} aria-label="Account role">{([['FOOD_PROVIDER', 'Food provider'], ['FARMER_COLLECTOR', 'Farmer / Collector'], ['COMPOSTER', 'Composter']] as const).map(([value, label]) => <option key={value} value={value}>{label}{!loadingTypes && !types.some((item) => item.role === value) ? ' — not accepting requests' : ''}</option>)}</SelectField></Field></div>
    <Field label="Organization type"><SelectField value={form.organizationTypeId} onChange={(e) => change('organizationTypeId', e.target.value)} aria-label="Organization type" disabled={loadingTypes || !types.some((item) => item.role === form.role)} required><option value="">{loadingTypes ? 'Loading options…' : 'Choose an organization type'}</option>{types.filter((item) => item.role === form.role).map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</SelectField></Field>
    <Field label="Organization"><input value={form.organizationName} onChange={(e) => change('organizationName', e.target.value)} required /></Field>
    <Field label="Email or phone" hint="The administrator will use this to return your credentials."><input value={form.contact} onChange={(e) => change('contact', e.target.value)} required /></Field>
    <Field label="Note (optional)"><textarea rows={3} value={form.note} onChange={(e) => change('note', e.target.value)} placeholder="Anything the district team should know" /></Field>
    <button className="button button--primary button--wide" disabled={busy || loadingTypes || !form.organizationTypeId}>{busy && <i className="button-spinner" />}{busy ? 'Sending request' : 'Request access'}<ArrowRight size={17} /></button>
  </form>;
}

export function ChangePassphrase({ account, onChanged }: { account: Account; onChanged: (account: Account) => void }) {
  const [first, setFirst] = useState(''); const [second, setSecond] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (first !== second) { setError('The passphrases do not match.'); return; }
    setBusy(true); setError(''); try { onChanged(await api('/auth/change-passphrase', { method: 'POST', body: JSON.stringify({ passphrase: first }) })); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Passphrase change failed.'); } finally { setBusy(false); }
  };
  return <main className="center-screen"><form className="first-login" onSubmit={submit}><span className="brand-mark"><Leaf size={20} /></span><p className="eyebrow">First sign in</p><h1>Create your private passphrase</h1><p>The one-time passphrase has done its job. Choose at least 10 characters that only you know.</p>{error && <Notice tone="error">{error}</Notice>}<Field label="New passphrase"><input type="password" minLength={10} value={first} onChange={(e) => setFirst(e.target.value)} required /></Field><Field label="Repeat passphrase"><input type="password" minLength={10} value={second} onChange={(e) => setSecond(e.target.value)} required /></Field><button className="button button--primary button--wide" disabled={busy}>{busy ? 'Saving passphrase' : 'Save passphrase'}</button></form></main>;
}
