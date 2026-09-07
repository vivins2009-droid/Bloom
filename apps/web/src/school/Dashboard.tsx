import { ArrowRight, CalendarDays, ChevronDown, ClipboardCheck, Lightbulb, Pencil, Scale, Sparkles, Trash2, TrendingDown, Utensils } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { Account, DailyWasteLog, InsightSummary, Meal, MealAssignment, Pickup, Recommendation, WasteReason } from '@bloom/contracts';
import { api, formatDate, today } from '../api';
import { ConfirmDialog, DatePicker, Field, Notice, SelectField, Spinner } from '../components';

const reasonLabel: Record<WasteReason, string> = { LOW_ATTENDANCE: 'Lower attendance', MENU_PREFERENCE: 'Meal preference', OVERPRODUCTION: 'Overproduction', PREPARATION_WASTE: 'Preparation waste', OTHER: 'Other' };

export function Dashboard({ account }: { account: Account }) {
  const [meals, setMeals] = useState<Meal[]>([]); const [assignments, setAssignments] = useState<MealAssignment[]>([]); const [logs, setLogs] = useState<DailyWasteLog[]>([]); const [pickups, setPickups] = useState<Pickup[]>([]);
  const [insights, setInsights] = useState<InsightSummary | null>(null); const [loading, setLoading] = useState(true); const [loadError, setLoadError] = useState('');
  const load = async (showPageLoader = false) => {
    if (showPageLoader) setLoading(true); setLoadError('');
    try {
      const [mealBody, assignmentBody, logBody, pickupBody, insightBody] = await Promise.all([
        api<{ data: Meal[] }>('/meals'), api<{ data: MealAssignment[] }>('/meal-assignments'), api<{ data: DailyWasteLog[] }>('/waste-logs'), api<{ data: Pickup[] }>('/pickups'), api<InsightSummary>('/insights')
      ]);
      setMeals(mealBody.data); setAssignments(assignmentBody.data); setLogs(logBody.data); setPickups(pickupBody.data); setInsights(insightBody);
    } catch (reason) { setLoadError(reason instanceof Error ? reason.message : 'Dashboard data could not be loaded.'); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(true); }, []);
  const todayAssignment = assignments.find((item) => item.date === today());
  const todayLog = logs.find((item) => item.date === today());

  if (loading) return <main className="page"><Spinner label="Preparing today’s school dashboard" /></main>;
  if (loadError) return <main className="page"><Notice tone="error"><span>{loadError}</span><button onClick={() => void load(true)}>Try again</button></Notice></main>;
  return <main className="page dashboard-page">
    <section className="page-heading dashboard-heading"><div><p className="eyebrow">Waste tracker · {new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date())}</p><h1>Plan, record, recover.</h1><p>{account.organizationName}</p></div><Link className="text-link" to="/calendar"><CalendarDays size={16} /> Open meal calendar</Link></section>
    <ServingCalculator meals={meals} defaultMealIds={todayAssignment?.mealIds ?? []} />
    <DailyLog meals={meals} defaultMealIds={todayAssignment?.mealIds ?? []} existing={todayLog} pickup={pickups.find((item) => item.id === todayLog?.pickupId)} onSaved={() => load(false)} />
    <Insights insights={insights!} />
  </main>;
}

function ServingCalculator({ meals, defaultMealIds }: { meals: Meal[]; defaultMealIds: string[] }) {
  const [attendance, setAttendance] = useState(270); const [date, setDate] = useState(today()); const [mealId, setMealId] = useState(defaultMealIds[0] ?? meals[0]?.id ?? '');
  const [result, setResult] = useState<Recommendation | null>(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { if (!mealId && meals[0]) setMealId(meals[0].id); }, [meals, mealId]);
  const calculate = async (event?: FormEvent) => { event?.preventDefault(); if (!mealId) { setError('Add and schedule a meal before calculating servings.'); return; } setBusy(true); setError(''); try { setResult(await api('/recommendations', { method: 'POST', body: JSON.stringify({ expectedAttendance: attendance, mealIds: [mealId] }) })); } catch (reason) { setError(reason instanceof Error ? reason.message : 'The recommendation could not be calculated.'); } finally { setBusy(false); } };
  useEffect(() => { if (mealId) void calculate(); }, [mealId]);
  return <section className="calculator-section section-rule">
    <div className="section-intro"><span className="section-number">01</span><div><p className="eyebrow">Serving calculator</p><h2>How many servings should we prepare?</h2><p>Start with attendance. Bloom adds a small safety margin and checks recent overproduction for this meal.</p></div></div>
    <div className="calculator-layout">
      <form className="calculator-form" onSubmit={calculate}>
        {error && <Notice tone="error">{error}</Notice>}
        <Field label="Expected attendance"><input type="number" min={1} max={5000} value={attendance} onChange={(e) => setAttendance(Number(e.target.value))} /></Field>
        <DatePicker label="Service date" value={date} onChange={setDate} />
        <Field label="Scheduled meal"><SelectField value={mealId} onChange={(e) => setMealId(e.target.value)} aria-label="Scheduled meal"><option value="">Choose a meal</option>{meals.map((meal) => <option key={meal.id} value={meal.id}>{meal.name}</option>)}</SelectField></Field>
        <button className="button button--primary" disabled={busy}>{busy ? 'Calculating servings' : 'Update recommendation'}<ArrowRight size={17} /></button>
      </form>
      <div className="serving-result" aria-live="polite">
        <span className="result-icon"><Utensils size={23} /></span><p>Recommended cook</p><strong>{result?.recommendedServings ?? '—'}</strong><b>servings</b>
        {result && <details><summary>See calculation <ChevronDown size={15} /></summary><dl><div><dt>Expected attendance</dt><dd>{result.expectedAttendance}</dd></div><div><dt>5% safety margin</dt><dd>+{result.safetyBuffer}</dd></div><div><dt>Recent overproduction</dt><dd>−{result.historicalAdjustment}</dd></div></dl><small>{result.eligibleLogCount < 2 ? 'No historical adjustment yet. Two matching logs are needed.' : `Based on ${result.eligibleLogCount} recent logs for this meal.`}</small></details>}
      </div>
    </div>
  </section>;
}

function DailyLog({ meals, defaultMealIds, existing, pickup, onSaved }: { meals: Meal[]; defaultMealIds: string[]; existing?: DailyWasteLog; pickup?: Pickup; onSaved: () => Promise<void> }) {
  const [open, setOpen] = useState(false); const [confirmDelete, setConfirmDelete] = useState(false); const [saved, setSaved] = useState<DailyWasteLog | undefined>(existing); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [publishing, setPublishing] = useState(false);
  useEffect(() => setSaved(existing), [existing]);
  const [form, setForm] = useState({ mealId: defaultMealIds[0] ?? meals[0]?.id ?? '', actualAttendance: 260, servingsPrepared: 275, leftoverKg: 0, reason: 'LOW_ATTENDANCE' as WasteReason, suitableForCollection: false, notes: '' });
  const beginEdit = () => { if (!saved) return; setForm({ mealId: saved.mealIds[0] ?? '', actualAttendance: saved.actualAttendance, servingsPrepared: saved.servingsPrepared, leftoverKg: saved.leftoverKg, reason: saved.reason, suitableForCollection: saved.suitableForCollection, notes: saved.notes }); setOpen(true); };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); const scrollPosition = window.scrollY; setBusy(true); setError('');
    try { const log = await api<DailyWasteLog>(saved ? `/waste-logs/${saved.id}` : '/waste-logs', { method: saved ? 'PUT' : 'POST', body: JSON.stringify({ date: today(), mealIds: [form.mealId], actualAttendance: form.actualAttendance, servingsPrepared: form.servingsPrepared, leftoverKg: form.leftoverKg, reason: form.reason, suitableForCollection: form.suitableForCollection, notes: form.notes }) }); await onSaved(); setSaved(log); setOpen(false); requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo({ top: scrollPosition }))); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'The daily log could not be saved.'); }
    finally { setBusy(false); }
  };
  const publish = async () => { if (!saved) return; setPublishing(true); setError(''); try { await api(`/waste-logs/${saved.id}/publish-pickup`, { method: 'POST' }); onSaved(); } catch (reason) { setError(reason instanceof Error ? reason.message : 'The pickup could not be published.'); } finally { setPublishing(false); } };
  const remove = async () => { if (!saved) return; setBusy(true); setError(''); try { await api(`/waste-logs/${saved.id}`, { method: 'DELETE' }); setSaved(undefined); setOpen(false); setConfirmDelete(false); await onSaved(); } catch (reason) { setError(reason instanceof Error ? reason.message : 'The daily log could not be deleted.'); } finally { setBusy(false); } };
  const locked = Boolean(pickup && ['RESERVED', 'IN_TRANSIT', 'AWAITING_SCHOOL_CONFIRMATION', 'COLLECTED'].includes(pickup.status));
  const mealNames = saved?.mealIds.map((id) => meals.find((meal) => meal.id === id)?.name).filter(Boolean).join(', ');
  return <section className="daily-log section-rule">
    <div className="section-intro"><span className="section-number">02</span><div><p className="eyebrow">Daily record</p><h2>What came back today?</h2><p>A short, consistent record turns kitchen experience into useful guidance.</p></div></div>
    {error && <Notice tone="error">{error}</Notice>}
    {saved && !open ? <div className="log-summary"><div className="log-summary__main"><span className="success-mark"><ClipboardCheck size={21} /></span><div><small>Today’s log saved</small><h3>{saved.leftoverKg} kg leftover</h3><p>{mealNames} · {saved.actualAttendance} attended · {saved.servingsPrepared} prepared</p></div></div><div className="log-summary__aside"><span>{reasonLabel[saved.reason]}</span>{saved.suitableForCollection && !saved.pickupId ? <button className="button button--primary" onClick={publish} disabled={publishing}>{publishing ? 'Publishing pickup' : 'Publish pickup'}<ArrowRight size={16} /></button> : saved.pickupId ? <Link className="button button--quiet" to="/pickups">View pickup</Link> : <small>Not marked for collection</small>}<div className="log-actions"><button className="icon-button" onClick={beginEdit} disabled={locked} aria-label="Edit today’s waste log" title={locked ? 'Locked after pickup acceptance' : 'Edit waste log'}><Pencil size={16} /></button><button className="icon-button icon-button--danger" onClick={() => setConfirmDelete(true)} disabled={locked} aria-label="Delete today’s waste log" title={locked ? 'Locked after pickup acceptance' : 'Delete waste log'}><Trash2 size={16} /></button></div>{locked && <small className="locked-note">Locked because collection is in progress or complete.</small>}</div></div> : !open ? <div className="log-empty"><div><span><Scale size={21} /></span><div><h3>No waste log for today</h3><p>Record attendance, portions prepared, and any leftovers after service.</p></div></div><button className="button button--primary" onClick={() => setOpen(true)}>Record today’s waste</button></div> : <form className="log-form" onSubmit={submit}>
      <div className="form-heading"><div><h3>Today’s outcome</h3><p>{formatDate(today())}</p></div><button type="button" className="icon-button" onClick={() => setOpen(false)} aria-label="Close daily log">×</button></div>
      <div className="form-grid form-grid--three"><Field label="Meal"><SelectField value={form.mealId} onChange={(e) => setForm({ ...form, mealId: e.target.value })} required><option value="">Choose a meal</option>{meals.map((meal) => <option key={meal.id} value={meal.id}>{meal.name}</option>)}</SelectField></Field><Field label="Actual attendance"><input type="number" min={1} value={form.actualAttendance} onChange={(e) => setForm({ ...form, actualAttendance: Number(e.target.value) })} required /></Field><Field label="Servings prepared"><input type="number" min={1} value={form.servingsPrepared} onChange={(e) => setForm({ ...form, servingsPrepared: Number(e.target.value) })} required /></Field></div>
      <div className="form-grid"><Field label="Leftover weight (kg)"><input type="number" min={0} max={500} step="0.1" value={form.leftoverKg} onChange={(e) => setForm({ ...form, leftoverKg: Number(e.target.value) })} required /></Field><Field label="Primary reason"><SelectField value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value as WasteReason })}>{Object.entries(reasonLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</SelectField></Field></div>
      <Field label="Notes (optional)"><textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
      <label className="check-row"><input type="checkbox" checked={form.suitableForCollection} onChange={(e) => setForm({ ...form, suitableForCollection: e.target.checked })} /><span><strong>Suitable for livestock feed or compost collection</strong><small>Saving this log will not publish a pickup. You can review it first.</small></span></label>
      <div className="form-actions"><button type="button" className="button button--quiet" onClick={() => setOpen(false)}>Cancel</button><button className="button button--primary" disabled={busy}>{busy ? 'Saving daily log' : saved ? 'Save changes' : 'Save daily log'}</button></div>
    </form>}<ConfirmDialog open={confirmDelete} title="Delete today’s waste log?" description="This permanently removes the record and any pickup that has not yet been accepted." confirmLabel="Delete waste log" busy={busy} onConfirm={remove} onCancel={() => setConfirmDelete(false)} />
  </section>;
}

function Insights({ insights }: { insights: InsightSummary }) {
  const maxTrend = Math.max(...insights.trend.map((item) => item.leftoverKg), 1);
  const points = insights.trend.map((item, index) => ({ x: insights.trend.length === 1 ? 50 : (index / (insights.trend.length - 1)) * 100, y: 90 - (item.leftoverKg / maxTrend) * 70 }));
  const path = points.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ');
  return <section className="insights-section section-rule">
    <div className="section-intro"><span className="section-number">03</span><div><p className="eyebrow">Kitchen insights</p><h2>Learn from the last 30 days.</h2><p>Only recorded school data appears here. No estimates are presented as results.</p></div></div>
    {insights.totalLogs === 0 ? <div className="insights-empty"><span><Sparkles size={22} /></span><h3>Your first insight starts with a daily log.</h3><p>After two or more services, Bloom can compare meals and adjust recommendations.</p></div> : <>
      <div className="insight-grid"><article className="headline-metric"><span>Leftovers per 100 attendees</span><strong>{insights.leftoverPer100Attendees} <small>kg</small></strong><p>Across {insights.totalLogs} recorded service{insights.totalLogs === 1 ? '' : 's'}</p></article>{insights.trend.length >= 2 ? <article className="trend-chart"><div><span>Leftover trend</span><small>Daily kilograms</small></div><svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="Leftover kilograms by recorded service over the last 30 days"><path d={path} fill="none" stroke="currentColor" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />{points.map((point, index) => <circle key={index} cx={point.x} cy={point.y} r="2" vectorEffect="non-scaling-stroke" />)}</svg></article> : <article className="trend-insufficient"><TrendingDown size={22} /><span>30-day leftover trend</span><h3>One more daily log is needed.</h3><p>A trend compares change between services. Bloom will draw it after a second dated record instead of presenting a meaningless single point.</p></article>}</div>
      <div className="breakdown-grid"><Breakdown title="Meals producing the most leftovers" rows={insights.topMeals.map((item) => ({ label: item.name, value: item.leftoverKg }))} /><Breakdown title="Why leftovers happened" rows={insights.topReasons.map((item) => ({ label: reasonLabel[item.reason], value: item.leftoverKg }))} /></div>
      {insights.recommendation && <div className="recommendation"><Lightbulb size={20} /><div><span>Next service</span><p>{insights.recommendation}</p></div><TrendingDown size={22} /></div>}
    </>}
  </section>;
}

function Breakdown({ title, rows }: { title: string; rows: Array<{ label: string; value: number }> }) {
  const max = Math.max(...rows.map((row) => row.value), 1);
  return <article className="breakdown"><h3>{title}</h3>{rows.length ? <div>{rows.map((row) => <div className="breakdown-row" key={row.label}><span>{row.label}</span><strong>{row.value} kg</strong><i><b style={{ width: `${(row.value / max) * 100}%` }} /></i></div>)}</div> : <p>More daily logs are needed.</p>}</article>;
}
