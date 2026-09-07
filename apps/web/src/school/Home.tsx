import { ArrowDown, ArrowRight, CalendarDays, ClipboardList, Scale } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { DailyWasteLog, MealAssignment, Pickup } from '@bloom/contracts';
import { Link } from 'react-router-dom';
import { api, formatDate, today } from '../api';

type Overview = { logs: DailyWasteLog[]; assignments: MealAssignment[]; pickups: Pickup[] };
const activePickupStatuses = ['AVAILABLE', 'RESERVED', 'IN_TRANSIT', 'AWAITING_SCHOOL_CONFIRMATION'];
const pickupLabels: Record<string, string> = { AVAILABLE: 'Waiting for a partner', RESERVED: 'Reserved', IN_TRANSIT: 'Collector in transit', AWAITING_SCHOOL_CONFIRMATION: 'Awaiting your confirmation' };

export function Home() {
  const [overview, setOverview] = useState<Overview | null>(null);
  useEffect(() => { Promise.all([api<{ data: DailyWasteLog[] }>('/waste-logs'), api<{ data: MealAssignment[] }>('/meal-assignments'), api<{ data: Pickup[] }>('/pickups')]).then(([logs, assignments, pickups]) => setOverview({ logs: logs.data, assignments: assignments.data, pickups: pickups.data })).catch(() => setOverview({ logs: [], assignments: [], pickups: [] })); }, []);
  const todayLog = overview?.logs.find((log) => log.date === today());
  const nextMeal = overview?.assignments.filter((item) => item.date >= today()).sort((a, b) => a.date.localeCompare(b.date))[0];
  const activePickup = overview?.pickups.find((item) => activePickupStatuses.includes(item.status));
  return <main className="home-page">
    <section className="home-hero">
      <div><p className="eyebrow">School food planning</p><h1 className="home-wordmark">Bloom</h1><p>Plan portions, record what comes back, and offer suitable leftovers for collection—all from one clear workflow.</p><a className="button button--primary" href="#dashboard-overview">View dashboard <ArrowDown size={17} /></a></div>
      <div className="home-flow" aria-label="Bloom school workflow"><span><b>01</b>Plan servings</span><i /><span><b>02</b>Record leftovers</span><i /><span><b>03</b>Publish pickup</span></div>
    </section>
    <section className="home-dashboard" id="dashboard-overview">
      <header><div><p className="eyebrow">Workspace overview</p><h2>Dashboard</h2></div><p>See what needs attention, then open the right workspace.</p></header>
      <div className="dashboard-previews">
        <article><span className="preview-icon"><Scale size={21} /></span><p className="eyebrow">Waste tracker</p><h3>{!overview ? 'Checking today’s record…' : todayLog ? `${todayLog.leftoverKg} kg recorded today` : 'Today’s log is waiting'}</h3><p>{todayLog ? `${todayLog.actualAttendance} attended · ${todayLog.servingsPrepared} servings prepared` : 'Calculate portions and record what comes back after service.'}</p><Link to="/tracker">Open waste tracker <ArrowRight size={16} /></Link></article>
        <article><span className="preview-icon"><CalendarDays size={21} /></span><p className="eyebrow">Meal calendar</p><h3>{!overview ? 'Checking the schedule…' : nextMeal ? `Next service: ${formatDate(nextMeal.date, { day: 'numeric', month: 'long' })}` : 'No upcoming meals scheduled'}</h3><p>{nextMeal ? `${nextMeal.mealIds.length} meal${nextMeal.mealIds.length === 1 ? '' : 's'} assigned for this service.` : 'Add meals and assign them to upcoming service dates.'}</p><Link to="/calendar">Open meal calendar <ArrowRight size={16} /></Link></article>
        <article><span className="preview-icon"><ClipboardList size={21} /></span><p className="eyebrow">Pickups</p><h3>{!overview ? 'Checking recovery status…' : activePickup ? pickupLabels[activePickup.status] : 'No active pickup'}</h3><p>{activePickup ? `${activePickup.estimatedWeightKg} kg is moving through the recovery process.` : 'Suitable leftovers you publish will appear here.'}</p><Link to="/pickups">Open pickups <ArrowRight size={16} /></Link></article>
      </div>
    </section>
  </main>;
}
