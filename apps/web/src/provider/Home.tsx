import { ArrowRight, CalendarDays, ClipboardList, Plus, Scale } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { DailyWasteLog, MealAssignment, Pickup } from '@bloom/contracts';
import { Link } from 'react-router-dom';
import { api, formatDate, today } from '../api';

type Overview = { logs: DailyWasteLog[]; assignments: MealAssignment[]; pickups: Pickup[] };
const activePickupStatuses = ['AVAILABLE', 'RESERVED', 'IN_TRANSIT', 'AWAITING_PROVIDER_CONFIRMATION'];
const pickupLabels: Record<string, string> = { AVAILABLE: 'Waiting for a partner', RESERVED: 'Reserved', IN_TRANSIT: 'Collector in transit', AWAITING_PROVIDER_CONFIRMATION: 'Awaiting your confirmation' };

export function Home() {
  const [overview, setOverview] = useState<Overview | null>(null);
  useEffect(() => { Promise.all([api<{ data: DailyWasteLog[] }>('/waste-logs'), api<{ data: MealAssignment[] }>('/meal-assignments'), api<{ data: Pickup[] }>('/pickups')]).then(([logs, assignments, pickups]) => setOverview({ logs: logs.data, assignments: assignments.data, pickups: pickups.data })).catch(() => setOverview({ logs: [], assignments: [], pickups: [] })); }, []);
  const todayLogs = overview?.logs.filter((log) => log.date === today()) ?? [];
  const nextMeal = overview?.assignments.filter((item) => item.date >= today()).sort((a, b) => a.date.localeCompare(b.date))[0];
  const activePickup = overview?.pickups.find((item) => activePickupStatuses.includes(item.status));
  return <main className="page home-page dashboard-home">
    <header className="page-heading dashboard-page-heading"><div><p className="eyebrow">Food Waste Producer</p><h1>Today’s overview</h1><p>Track today’s waste, prepare upcoming services, and coordinate collections.</p></div><Link className="button button--primary" to="/tracker"><Plus size={17} /> Record waste</Link></header>
    <section className="home-dashboard" id="dashboard-overview">
      <div className="dashboard-previews">
        <article><span className="preview-icon"><Scale size={21} /></span><p className="eyebrow">Waste tracker</p><h3>{!overview ? 'Checking today’s records…' : todayLogs.length ? `${todayLogs.reduce((sum, log) => sum + log.leftoverKg, 0)} kg across ${todayLogs.length} service${todayLogs.length === 1 ? '' : 's'}` : 'Today’s log is waiting'}</h3><p>{todayLogs.length ? `${todayLogs.reduce((sum, log) => sum + log.actualAttendance, 0)} attendees recorded today` : 'Calculate portions and record what comes back after each service.'}</p><Link to="/tracker">Open waste tracker <ArrowRight size={16} /></Link></article>
        <article className="dashboard-preview--calendar"><span className="preview-icon"><CalendarDays size={21} /></span><p className="eyebrow">Meal calendar</p><h3>{!overview ? 'Checking the schedule…' : nextMeal ? `Next service: ${formatDate(nextMeal.date, { day: 'numeric', month: 'long' })}` : 'No upcoming meals scheduled'}</h3><p>{nextMeal ? `${nextMeal.mealIds.length} meal${nextMeal.mealIds.length === 1 ? '' : 's'} assigned for this service.` : 'Add meals and assign them to upcoming service dates.'}</p><Link to="/calendar">Open meal calendar <ArrowRight size={16} /></Link></article>
        <article><span className="preview-icon"><ClipboardList size={21} /></span><p className="eyebrow">Pickups</p><h3>{!overview ? 'Checking recovery status…' : activePickup ? pickupLabels[activePickup.status] : 'No active pickup'}</h3><p>{activePickup ? `${activePickup.estimatedWeightKg} kg is moving through the recovery process.` : 'Suitable leftovers you publish will appear here.'}</p><Link to="/pickups">Open pickups <ArrowRight size={16} /></Link></article>
      </div>
    </section>
  </main>;
}
