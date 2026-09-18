import type { Account, DailyWasteLog, InsightSummary, Meal, Pickup, PickupStatus, Recommendation, RecoveryRole, ServicePeriod, WasteReason, WasteStage } from '@bloom/contracts';

export const ACTIVE_PICKUP_STATUSES: PickupStatus[] = ['RESERVED', 'IN_TRANSIT', 'AWAITING_PROVIDER_CONFIRMATION'];

export const roleCanRecoverPickup = (role: Account['role'], pickup: Pickup) =>
  role === 'FOOD_COLLECTOR' && pickup.eligibleRoles.includes(role as RecoveryRole);

export function reconcilePickup(pickup: Pickup, now = new Date()): boolean {
  const nowMs = now.getTime();
  const deadlineMs = new Date(pickup.pickupDeadline).getTime();
  if (pickup.status === 'AVAILABLE' && deadlineMs <= nowMs) {
    pickup.activity.push({
      id: `event-${pickup.id}-${nowMs}`,
      actorId: 'system',
      actorName: 'Bloom',
      fromStatus: 'AVAILABLE',
      toStatus: 'EXPIRED',
      reason: 'Collection deadline passed',
      createdAt: now.toISOString()
    });
    pickup.status = 'EXPIRED';
    pickup.updatedAt = now.toISOString();
    return true;
  }
  if (pickup.status === 'RESERVED') {
    const reservationMs = pickup.reservationExpiresAt ? new Date(pickup.reservationExpiresAt).getTime() : 0;
    if (deadlineMs <= nowMs || reservationMs <= nowMs) {
      const nextStatus: PickupStatus = deadlineMs <= nowMs ? 'EXPIRED' : 'AVAILABLE';
      pickup.activity.push({
        id: `event-${pickup.id}-${nowMs}`,
        actorId: 'system',
        actorName: 'Bloom',
        fromStatus: 'RESERVED',
        toStatus: nextStatus,
        reason: nextStatus === 'AVAILABLE' ? 'Reservation hold expired' : 'Collection deadline passed',
        createdAt: now.toISOString()
      });
      pickup.status = nextStatus;
      pickup.reservedByAccountId = undefined;
      pickup.reservedByName = undefined;
      pickup.reservedAt = undefined;
      pickup.reservationExpiresAt = undefined;
      pickup.updatedAt = now.toISOString();
      return true;
    }
  }
  return false;
}

export function reconcilePickups(pickups: Pickup[], now = new Date()): boolean {
  return pickups.reduce((changed, pickup) => reconcilePickup(pickup, now) || changed, false);
}

export function calculateRecommendation(input: {
  expectedAttendance: number;
  mealIds: string[];
  logs: DailyWasteLog[];
  safetyBufferPercent?: number;
}): Recommendation {
  const safetyBuffer = Math.ceil(input.expectedAttendance * ((input.safetyBufferPercent ?? 5) / 100));
  const eligible = input.logs
    .filter((log) => input.mealIds.some((id) => (log.mealIds ?? []).includes(id)))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 4);
  const rawAdjustment = eligible.length >= 2
    ? Math.round(eligible.reduce((sum, log) => sum + Math.max(0, (log.servingsPrepared ?? 0) - (log.actualAttendance ?? 0)), 0) / eligible.length)
    : 0;
  const historicalAdjustment = Math.min(rawAdjustment, Math.floor(input.expectedAttendance * 0.15));
  return {
    expectedAttendance: input.expectedAttendance,
    safetyBuffer,
    historicalAdjustment,
    recommendedServings: Math.max(input.expectedAttendance, input.expectedAttendance + safetyBuffer - historicalAdjustment),
    eligibleLogCount: eligible.length
  };
}

export function calculateInsights(logs: DailyWasteLog[], meals: Meal[], now = new Date()): InsightSummary {
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - 29);
  const periodLogs = logs.filter((log) => { const at = new Date(log.recordedAt ?? `${log.date}T00:00:00`); return at >= cutoff && at <= now; });
  const attendance = periodLogs.reduce((sum, log) => sum + (log.actualAttendance ?? 0), 0);
  const leftovers = periodLogs.reduce((sum, log) => sum + log.leftoverKg, 0);
  const mealTotals = new Map<string, number>();
  const reasonTotals = new Map<WasteReason, number>();
  const stageTotals = new Map<WasteStage, number>();
  const serviceTotals = new Map<ServicePeriod, number>();
  const categoryTotals = new Map<string, number>();
  const trendTotals = new Map<string, number>();
  periodLogs.forEach((log) => {
    const mealIds = log.mealIds ?? [];
    const share = mealIds.length ? log.leftoverKg / mealIds.length : 0;
    mealIds.forEach((id) => mealTotals.set(id, (mealTotals.get(id) ?? 0) + share));
    reasonTotals.set(log.reason, (reasonTotals.get(log.reason) ?? 0) + log.leftoverKg);
    if (log.wasteStage) stageTotals.set(log.wasteStage, (stageTotals.get(log.wasteStage) ?? 0) + log.leftoverKg);
    if (log.servicePeriod) serviceTotals.set(log.servicePeriod, (serviceTotals.get(log.servicePeriod) ?? 0) + log.leftoverKg);
    if (log.foodCategory?.trim()) categoryTotals.set(log.foodCategory.trim(), (categoryTotals.get(log.foodCategory.trim()) ?? 0) + log.leftoverKg);
    trendTotals.set(log.date, (trendTotals.get(log.date) ?? 0) + log.leftoverKg);
  });
  const topMeals = [...mealTotals.entries()].map(([mealId, leftoverKg]) => ({
    mealId,
    name: meals.find((meal) => meal.id === mealId)?.name ?? 'Archived meal',
    leftoverKg: Number(leftoverKg.toFixed(1))
  })).sort((a, b) => b.leftoverKg - a.leftoverKg).slice(0, 3);
  const topReasons = [...reasonTotals.entries()].map(([reason, leftoverKg]) => ({ reason, leftoverKg: Number(leftoverKg.toFixed(1)) })).sort((a, b) => b.leftoverKg - a.leftoverKg);
  const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0);
  const currentStart = new Date(startOfToday); currentStart.setDate(currentStart.getDate() - 6);
  const previousStart = new Date(startOfToday); previousStart.setDate(previousStart.getDate() - 13);
  const current = logs.filter((log) => { const at = new Date(log.recordedAt ?? `${log.date}T00:00:00`); return at >= currentStart && at <= now; });
  const previous = logs.filter((log) => { const at = new Date(log.recordedAt ?? `${log.date}T00:00:00`); return at >= previousStart && at < currentStart; });
  const currentKg = current.reduce((sum, log) => sum + log.leftoverKg, 0);
  const previousKg = previous.reduce((sum, log) => sum + log.leftoverKg, 0);
  const stageBreakdown = [...stageTotals.entries()].map(([stage, wasteKg]) => ({ stage, wasteKg: Number(wasteKg.toFixed(1)) })).sort((a, b) => b.wasteKg - a.wasteKg);
  const serviceBreakdown = [...serviceTotals.entries()].map(([servicePeriod, wasteKg]) => ({ servicePeriod, wasteKg: Number(wasteKg.toFixed(1)) })).sort((a, b) => b.wasteKg - a.wasteKg);
  const categoryBreakdown = [...categoryTotals.entries()].map(([category, wasteKg]) => ({ category, wasteKg: Number(wasteKg.toFixed(1)) })).sort((a, b) => b.wasteKg - a.wasteKg).slice(0, 5);
  const guidance: string[] = [];
  if (periodLogs.length >= 3 && stageBreakdown[0] && leftovers > 0 && stageBreakdown[0].wasteKg / leftovers >= .4) guidance.push(`${stageBreakdown[0].stage.replaceAll('_', ' ').toLowerCase()} accounts for ${Math.round(stageBreakdown[0].wasteKg / leftovers * 100)}% of recorded waste. Start the next reduction check there.`);
  if (periodLogs.length >= 3 && serviceBreakdown[0] && leftovers > 0 && serviceBreakdown[0].wasteKg / leftovers >= .4) guidance.push(`${serviceBreakdown[0].servicePeriod.replaceAll('_', ' ').toLowerCase()} services produce the largest recorded share. Review preparation and portion decisions for that period.`);
  if (current.length >= 2 && previousKg > 0) guidance.push(`Waste is ${currentKg <= previousKg ? 'down' : 'up'} ${Math.abs(Math.round(((currentKg - previousKg) / previousKg) * 100))}% compared with the previous seven days.`);
  const recommendation = guidance[0] ?? null;
  return {
    periodDays: 30,
    totalLogs: periodLogs.length,
    leftoverPer100Attendees: attendance ? Number(((leftovers / attendance) * 100).toFixed(1)) : null,
    trend: [...trendTotals.entries()].map(([date, leftoverKg]) => ({ date, leftoverKg: Number(leftoverKg.toFixed(1)) })).sort((a, b) => a.date.localeCompare(b.date)),
    topMeals,
    topReasons,
    recommendation,
    sevenDay: { totalKg: Number(currentKg.toFixed(1)), recordCount: current.length, collectionSuitableKg: Number(current.filter((log) => log.suitableForCollection).reduce((sum, log) => sum + log.leftoverKg, 0).toFixed(1)), changePercent: previousKg ? Math.round(((currentKg - previousKg) / previousKg) * 100) : null },
    stageBreakdown,
    serviceBreakdown,
    categoryBreakdown,
    guidance
  };
}

export function recurrenceDates(startDate: string, frequency: 'NONE' | 'WEEKLY' | 'BIWEEKLY', endDate?: string): string[] {
  if (frequency === 'NONE') return [startDate];
  const end = endDate ? new Date(`${endDate}T00:00:00`) : new Date(new Date(`${startDate}T00:00:00`).getTime() + 90 * 86400000);
  const cursor = new Date(`${startDate}T00:00:00`);
  const step = frequency === 'WEEKLY' ? 7 : 14;
  const dates: string[] = [];
  while (cursor <= end && dates.length < 53) {
    const year = cursor.getFullYear();
    const month = String(cursor.getMonth() + 1).padStart(2, '0');
    const day = String(cursor.getDate()).padStart(2, '0');
    dates.push(`${year}-${month}-${day}`);
    cursor.setDate(cursor.getDate() + step);
  }
  return dates;
}
