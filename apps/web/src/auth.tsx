import { ArrowLeft, ArrowRight, CheckCircle2, Eye, EyeOff, Leaf, Moon, Sun } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import type { Account, OrganizationType, PublicAccountRole } from '@bloom/contracts';
import { api } from './api';
import { Field, Notice, SelectField } from './components';

type AuthMode = 'signin' | 'request' | 'recovery';

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
      <p className="eyebrow">Private food recovery, coordinated</p>
      <h1>Bloom</h1>
      <p>Measure food waste, publish collections, and coordinate trusted handoffs between verified organizations.</p>
      <div className="auth-flow" aria-label="Bloom workflow"><span>Plan</span><i /><span>Record</span><i /><span>Recover</span></div>
    </section>
    <section className="auth-panel">
      <div className="auth-switch" role="tablist" aria-label="Account access">
        <button role="tab" aria-selected={mode === 'signin'} onClick={() => setMode('signin')}>Sign in</button>
        <button role="tab" aria-selected={mode === 'request'} onClick={() => setMode('request')}>Request access</button>
      </div>
      {mode === 'signin' ? <SignIn onAuthenticated={onAuthenticated} onRecovery={() => setMode('recovery')} /> : mode === 'request' ? <RequestAccess onBack={() => setMode('signin')} /> : <RequestRecovery onBack={() => setMode('signin')} />}
    </section>
  </main>;
}

function SignIn({ onAuthenticated, onRecovery }: { onAuthenticated: (account: Account) => void; onRecovery: () => void }) {
  const [accessCode, setAccessCode] = useState(''); const [passphrase, setPassphrase] = useState('');
  const [show, setShow] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try { onAuthenticated(await api<Account>('/auth/login', { method: 'POST', body: JSON.stringify({ accessCode, passphrase }) })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Sign in failed.'); }
    finally { setBusy(false); }
  };
  return <form className="auth-form" onSubmit={submit}>
    <header><p className="eyebrow">Welcome back</p><h2>Open your workspace</h2><p>Use the credentials assigned by the Bloom administrator.</p></header>
    {error && <Notice tone="error">{error}</Notice>}
    <Field label="Access code"><input autoComplete="username" value={accessCode} onChange={(event) => setAccessCode(event.target.value)} placeholder="e.g. FWP-8F2A1C" required /></Field>
    <Field label="Passphrase"><span className="password-field"><input type={show ? 'text' : 'password'} autoComplete="current-password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} placeholder="Enter your passphrase" required /><button type="button" onClick={() => setShow((value) => !value)} aria-label={show ? 'Hide passphrase' : 'Show passphrase'}>{show ? <EyeOff size={17} /> : <Eye size={17} />}</button></span></Field>
    <button className="button button--primary button--wide" disabled={busy}>{busy && <i className="button-spinner" />}{busy ? 'Signing in' : 'Sign in'}<ArrowRight size={17} /></button>
    <button type="button" className="text-link auth-recovery-link" onClick={onRecovery}>Forgot your passphrase?</button>
    <p className="demo-note">Local demo: <code>FWP-DEMO</code> / <code>bloom-producer</code></p>
  </form>;
}

function RequestAccess({ onBack }: { onBack: () => void }) {
  const [form, setForm] = useState({ applicantName: '', role: 'FOOD_WASTE_PRODUCER' as PublicAccountRole, organizationTypeId: '', organizationName: '', address: '', email: '', whatsapp: '+91', preferredContactMethod: 'EMAIL', weeklyWasteKg: '', hasTransportFacilities: '', transportFacilities: '' });
  const [files, setFiles] = useState<Record<string, File>>({});
  const [types, setTypes] = useState<OrganizationType[]>([]); const [loadingTypes, setLoadingTypes] = useState(true);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [sent, setSent] = useState(false);
  const loadTypes = () => { setLoadingTypes(true); setError(''); api<{ data: OrganizationType[] }>('/organization-types').then(({ data }) => { setTypes(data); setForm((current) => ({ ...current, organizationTypeId: data.find((item) => item.role === current.role)?.id ?? '' })); }).catch((reason) => setError(reason instanceof Error ? reason.message : 'Signup options could not be loaded.')).finally(() => setLoadingTypes(false)); };
  useEffect(loadTypes, []);
  const change = (key: keyof typeof form, value: string) => setForm((current) => ({ ...current, [key]: value }));
  const changeRole = (role: PublicAccountRole) => setForm((current) => ({ ...current, role, organizationTypeId: types.find((item) => item.role === role)?.id ?? '' }));
  const selectedType = types.find((item) => item.id === form.organizationTypeId);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const draft = await api<{ id: string }>('/access-requests/drafts', { method: 'POST', body: JSON.stringify({ ...form, weeklyWasteKg: form.role === 'FOOD_WASTE_PRODUCER' ? Number(form.weeklyWasteKg) : undefined, hasTransportFacilities: form.role === 'FOOD_COLLECTOR' ? form.hasTransportFacilities === 'yes' : undefined, transportFacilities: form.role === 'FOOD_COLLECTOR' && form.hasTransportFacilities === 'yes' ? form.transportFacilities : undefined }) });
      for (const requirement of selectedType?.documentRequirements ?? []) {
        const file = files[requirement.id]; if (!file) continue;
        const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error(`Could not read ${file.name}.`)); reader.readAsDataURL(file); });
        await api(`/access-requests/${draft.id}/documents`, { method: 'POST', body: JSON.stringify({ requirementId: requirement.id, fileName: file.name, mediaType: file.type, dataUrl }) });
      }
      await api(`/access-requests/${draft.id}/finalize`, { method: 'POST' }); setSent(true);
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'The request could not be sent.'); }
    finally { setBusy(false); }
  };
  if (sent) return <div className="auth-success"><CheckCircle2 size={34} /><p className="eyebrow">Request received</p><h2>Your application is with Bloom.</h2><p>When review begins, watch your preferred contact channel. If approved, your secure account-setup link will always arrive by email.</p><button className="button button--quiet" onClick={onBack}><ArrowLeft size={16} /> Return to sign in</button></div>;
  return <form className="auth-form" onSubmit={submit}>
    <header><p className="eyebrow">Join the private network</p><h2>Request an account</h2><p>Share the operational and verification details Bloom needs to review your organization.</p></header>
    {error && <Notice tone="error">{error} {loadingTypes ? null : <button type="button" className="notice-link" onClick={loadTypes}>Try again</button>}</Notice>}
    <div className="field-grid"><Field label="Contact person"><input value={form.applicantName} onChange={(e) => change('applicantName', e.target.value)} required /></Field><Field label="Participant role"><SelectField value={form.role} onChange={(e) => { changeRole(e.target.value as PublicAccountRole); setFiles({}); }} aria-label="Participant role">{([['FOOD_WASTE_PRODUCER', 'Food Waste Producer'], ['FOOD_COLLECTOR', 'Food Collector']] as const).map(([value, label]) => <option key={value} value={value}>{label}{!loadingTypes && !types.some((item) => item.role === value) ? ' — applications unavailable' : ''}</option>)}</SelectField></Field></div>
    <Field label="Organization category"><SelectField value={form.organizationTypeId} onChange={(e) => { change('organizationTypeId', e.target.value); setFiles({}); }} aria-label="Organization category" disabled={loadingTypes || !types.some((item) => item.role === form.role)} required><option value="">{loadingTypes ? 'Loading categories…' : types.some((item) => item.role === form.role) ? 'Choose a category' : 'No categories are accepting applications'}</option>{types.filter((item) => item.role === form.role).map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</SelectField></Field>
    <Field label="Organization name"><input value={form.organizationName} onChange={(e) => change('organizationName', e.target.value)} required /></Field>
    <Field label="Full address"><textarea rows={3} value={form.address} onChange={(e) => change('address', e.target.value)} minLength={8} maxLength={300} required /></Field>
    <div className="field-grid"><Field label="Email" hint="Account setup and recovery always use this address."><input type="email" autoComplete="email" value={form.email} onChange={(e) => change('email', e.target.value)} required /></Field><Field label="WhatsApp number" hint="Use international format, for example +919876543210."><input type="tel" autoComplete="tel" pattern="\+[1-9][0-9]{7,14}" value={form.whatsapp} onChange={(e) => change('whatsapp', e.target.value)} required /></Field></div>
    <Field label="Preferred review contact"><SelectField value={form.preferredContactMethod} onChange={(e) => change('preferredContactMethod', e.target.value)}><option value="EMAIL">Email</option><option value="WHATSAPP">WhatsApp</option></SelectField></Field>
    {form.role === 'FOOD_WASTE_PRODUCER' ? <Field label="Approximate food waste per week (kg)"><input type="number" min="0.1" step="0.1" value={form.weeklyWasteKg} onChange={(e) => change('weeklyWasteKg', e.target.value)} required /></Field> : <><Field label="Collection or transport facilities available?"><SelectField value={form.hasTransportFacilities} onChange={(e) => change('hasTransportFacilities', e.target.value)} required><option value="">Choose one</option><option value="yes">Yes</option><option value="no">No</option></SelectField></Field>{form.hasTransportFacilities === 'yes' && <Field label="Describe the facilities"><textarea rows={3} value={form.transportFacilities} onChange={(e) => change('transportFacilities', e.target.value)} maxLength={500} required /></Field>}</>}
    {selectedType?.documentRequirements.length ? <fieldset className="verification-documents"><legend>Verification documents</legend><p>PDF, JPEG, or PNG · maximum 10 MB each</p>{selectedType.documentRequirements.map((requirement) => <Field key={requirement.id} label={requirement.label} hint={requirement.required ? 'Required' : 'Optional'}><input type="file" accept="application/pdf,image/jpeg,image/png" required={requirement.required} onChange={(event) => { const file = event.target.files?.[0]; if (file) setFiles((current) => ({ ...current, [requirement.id]: file })); }} /></Field>)}</fieldset> : selectedType ? <Notice tone="success">This category has no document uploads configured.</Notice> : null}
    <button className="button button--primary button--wide" disabled={busy || loadingTypes || !form.organizationTypeId}>{busy && <i className="button-spinner" />}{busy ? 'Sending application' : 'Request access'}<ArrowRight size={17} /></button>
  </form>;
}

function RequestRecovery({ onBack }: { onBack: () => void }) {
  const [email, setEmail] = useState(''); const [busy, setBusy] = useState(false); const [sent, setSent] = useState(false); const [error, setError] = useState('');
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(''); try { await api('/auth/request-password-reset', { method: 'POST', body: JSON.stringify({ email }) }); setSent(true); } catch (cause) { setError(cause instanceof Error ? cause.message : 'The reset request could not be sent.'); } finally { setBusy(false); } };
  return sent ? <div className="auth-success"><CheckCircle2 size={34} /><p className="eyebrow">Check your inbox</p><h2>If the account exists, its reset link is on the way.</h2><p>The single-use link expires after 30 minutes.</p><button className="button button--quiet" onClick={onBack}><ArrowLeft size={16} /> Return to sign in</button></div> : <form className="auth-form" onSubmit={submit}><header><p className="eyebrow">Account recovery</p><h2>Reset your passphrase</h2><p>Enter the email held on your Bloom account.</p></header>{error && <Notice tone="error">{error}</Notice>}<Field label="Email"><input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></Field><button className="button button--primary button--wide" disabled={busy}>{busy ? 'Queuing link…' : 'Send reset link'}<ArrowRight size={17} /></button><button type="button" className="text-link auth-recovery-link" onClick={onBack}>Return to sign in</button></form>;
}

export function AccountLinkPage({ purpose }: { purpose: 'SETUP' | 'RESET' }) {
  const token = new URLSearchParams(window.location.search).get('token') ?? ''; const [first, setFirst] = useState(''); const [second, setSecond] = useState(''); const [busy, setBusy] = useState(false); const [done, setDone] = useState(false); const [error, setError] = useState('');
  const submit = async (event: FormEvent) => { event.preventDefault(); if (first !== second) { setError('The passphrases do not match.'); return; } setBusy(true); setError(''); try { await api('/auth/complete-account-link', { method: 'POST', body: JSON.stringify({ token, passphrase: first, purpose }) }); setDone(true); } catch (cause) { setError(cause instanceof Error ? cause.message : 'The link could not be completed.'); } finally { setBusy(false); } };
  return <main className="center-screen"><section className="account-link-card"><a className="wordmark" href="/"><span className="brand-mark">b</span><span>Bloom</span></a>{done ? <div className="auth-success"><CheckCircle2 size={34} /><p className="eyebrow">Passphrase ready</p><h2>Your account is secure.</h2><p>Return to Bloom and sign in using your access code.</p><a className="button button--primary" href="/">Open sign in</a></div> : <form className="auth-form" onSubmit={submit}><header><p className="eyebrow">{purpose === 'SETUP' ? 'Account setup' : 'Account recovery'}</p><h2>Choose your passphrase</h2><p>Use at least ten characters. This link can be used only once.</p></header>{error && <Notice tone="error">{error}</Notice>}<Field label="New passphrase"><input type="password" autoComplete="new-password" minLength={10} value={first} onChange={(event) => setFirst(event.target.value)} required /></Field><Field label="Confirm passphrase"><input type="password" autoComplete="new-password" minLength={10} value={second} onChange={(event) => setSecond(event.target.value)} required /></Field><button className="button button--primary button--wide" disabled={busy || !token}>{busy ? 'Saving…' : 'Save passphrase'}</button></form>}</section></main>;
}

export function ChangePassphrase({ account, onChanged }: { account: Account; onChanged: (account: Account) => void }) {
  const [first, setFirst] = useState(''); const [second, setSecond] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (first !== second) { setError('The passphrases do not match.'); return; }
    setBusy(true); setError(''); try { onChanged(await api('/auth/change-passphrase', { method: 'POST', body: JSON.stringify({ passphrase: first }) })); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Passphrase change failed.'); } finally { setBusy(false); }
  };
  return <main className="center-screen"><form className="first-login" onSubmit={submit}><span className="brand-mark"><Leaf size={20} /></span><p className="eyebrow">First sign in</p><h1>Create your private passphrase</h1><p>The one-time passphrase has done its job. Choose at least 10 characters that only you know.</p>{error && <Notice tone="error">{error}</Notice>}<Field label="New passphrase"><input type="password" minLength={10} value={first} onChange={(e) => setFirst(e.target.value)} required /></Field><Field label="Repeat passphrase"><input type="password" minLength={10} value={second} onChange={(e) => setSecond(e.target.value)} required /></Field><button className="button button--primary button--wide" disabled={busy}>{busy ? 'Saving passphrase' : 'Save passphrase'}</button></form></main>;
}
