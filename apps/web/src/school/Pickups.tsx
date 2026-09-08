import { ArrowRight, CheckCircle2, Clock3, PackageOpen, Truck } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Pickup, PickupStatus } from '@bloom/contracts';
import { api } from '../api';
import { Notice, Spinner } from '../components';

const labels: Record<PickupStatus, string> = { AVAILABLE: 'Waiting for a partner', RESERVED: 'Reserved', IN_TRANSIT: 'Collector in transit', AWAITING_PROVIDER_CONFIRMATION: 'Confirm collection', COLLECTED: 'Collected', CANCELLED: 'Cancelled', EXPIRED: 'Expired' };
const steps: PickupStatus[] = ['AVAILABLE', 'RESERVED', 'IN_TRANSIT', 'AWAITING_PROVIDER_CONFIRMATION', 'COLLECTED'];

export function Pickups() {
  const [pickups, setPickups] = useState<Pickup[] | null>(null); const [error, setError] = useState('');
  const load = () => { setError(''); api<{ data: Pickup[] }>('/pickups').then((body) => setPickups(body.data)).catch((reason) => setError(reason.message)); };
  useEffect(load, []);
  const confirm = async (id: string) => { try { await api(`/pickups/${id}/confirm`, { method: 'POST' }); load(); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Collection could not be confirmed.'); } };
  const active = pickups?.filter((item) => !['COLLECTED', 'CANCELLED', 'EXPIRED'].includes(item.status)) ?? []; const history = pickups?.filter((item) => ['COLLECTED', 'CANCELLED', 'EXPIRED'].includes(item.status)) ?? [];
  return <main className="page pickups-page"><section className="page-heading"><div><p className="eyebrow">Recovery</p><h1>School pickups</h1><p>See what is waiting, who is moving, and what has been collected.</p></div></section>{error && <Notice tone="error"><span>{error}</span><button onClick={load}>Try again</button></Notice>}{!pickups ? <Spinner label="Loading school pickups" /> : <>
    <section className="pickup-section"><div className="simple-heading"><h2>Active</h2><span>{active.length}</span></div>{active.length ? <div className="pickup-list">{active.map((pickup) => { const current = steps.indexOf(pickup.status); return <article className="pickup-card" key={pickup.id}><div className="pickup-card__top"><span className="pickup-icon"><Truck size={20} /></span><div><small>{labels[pickup.status]}</small><h3>{pickup.estimatedWeightKg} kg recovery pickup</h3><p>Livestock feed or compost · Published {new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(pickup.createdAt))}</p></div>{pickup.status === 'AWAITING_PROVIDER_CONFIRMATION' && <button className="button button--primary" onClick={() => confirm(pickup.id)}>Confirm collection<ArrowRight size={16} /></button>}</div><ol className="pickup-progress">{steps.map((step, index) => <li className={index <= current ? 'complete' : ''} key={step}><i>{index < current ? <CheckCircle2 size={15} /> : <Clock3 size={14} />}</i><span>{labels[step]}</span></li>)}</ol></article>; })}</div> : <div className="empty-state empty-state--compact"><span><PackageOpen size={23} /></span><h3>No active pickups</h3><p>Mark a daily waste log as suitable for collection, then publish it from the dashboard.</p></div>}</section>
    <section className="pickup-section"><div className="simple-heading"><h2>Recent history</h2><span>{history.length}</span></div>{history.length ? <div className="history-table">{history.map((pickup) => <article key={pickup.id}><span><CheckCircle2 size={17} /></span><div><strong>{pickup.estimatedWeightKg} kg</strong><small>{labels[pickup.status]}</small></div><time>{new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(pickup.updatedAt))}</time></article>)}</div> : <p className="muted-copy">Confirmed pickups will appear here.</p>}</section>
  </>}</main>;
}
