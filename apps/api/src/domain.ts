import type { DailyWasteLog, InsightSummary, Meal, Recommendation, WasteReason } from '@bloom/contracts';

export function calculateRecommendation(input: {
  expectedAttendance: number;
  mealIds: string[];
  logs: DailyWasteLog[];
  safetyBufferPercent?: number;
}): Recommendation {
  const safetyBuffer = Math.ceil(input.expectedAttendance * ((input.safetyBufferPercent ?? 5) / 100));
  const eligible = input.logs
    .filter((log) => input.mealIds.some((id) => log.mealIds.includes(id)))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 4);
  const rawAdjustment = eligible.length >= 2
    ? Math.round(eligible.reduce((sum, log) => sum + Math.max(0, log.servingsPrepared - log.actualAttendance), 0) / eligible.length)
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
  const periodLogs = logs.filter((log) => new Date(`${log.date}T00:00:00`) >= cutoff);
  const attendance = periodLogs.reduce((sum, log) => sum + log.actualAttendance, 0);
  const leftovers = periodLogs.reduce((sum, log) => sum + log.leftoverKg, 0);
  const mealTotals = new Map<string, number>();
  const reasonTotals = new Map<WasteReason, number>();
  periodLogs.forEach((log) => {
    const share = log.mealIds.length ? log.leftoverKg / log.mealIds.length : 0;
    log.mealIds.forEach((id) => mealTotals.set(id, (mealTotals.get(id) ?? 0) + share));
    reasonTotals.set(log.reason, (reasonTotals.get(log.reason) ?? 0) + log.leftoverKg);
  });
  const topMeals = [...mealTotals.entries()].map(([mealId, leftoverKg]) => ({
    mealId,
    name: meals.find((meal) => meal.id === mealId)?.name ?? 'Archived meal',
    leftoverKg: Number(leftoverKg.toFixed(1))
  })).sort((a, b) => b.leftoverKg - a.leftoverKg).slice(0, 3);
  const topReasons = [...reasonTotals.entries()].map(([reason, leftoverKg]) => ({ reason, leftoverKg: Number(leftoverKg.toFixed(1)) })).sort((a, b) => b.leftoverKg - a.leftoverKg);
  const recommendation = topMeals[0]
    ? `${topMeals[0].name} produced the most leftovers in the last 30 days. Review its serving count before its next service.`
    : null;
  return {
    periodDays: 30,
    totalLogs: periodLogs.length,
    leftoverPer100Attendees: attendance ? Number(((leftovers / attendance) * 100).toFixed(1)) : null,
    trend: periodLogs.map((log) => ({ date: log.date, leftoverKg: log.leftoverKg })).sort((a, b) => a.date.localeCompare(b.date)),
    topMeals,
    topReasons,
    recommendation
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
