import { describe, expect, it } from 'vitest';
import { calculateInsights, calculateRecommendation, recurrenceDates } from './domain.js';
import type { DailyWasteLog, Meal } from '@bloom/contracts';

const log = (date: string, prepared: number, attendance: number, leftoverKg = 5): DailyWasteLog => ({
  id: date, providerId: 's1', date, mealIds: ['m1'], actualAttendance: attendance, servingsPrepared: prepared,
  leftoverKg, reason: 'OVERPRODUCTION', suitableForCollection: true, notes: '', createdAt: `${date}T10:00:00Z`
});

describe('school domain', () => {
  it('never recommends fewer servings than expected attendance', () => {
    const result = calculateRecommendation({ expectedAttendance: 100, mealIds: ['m1'], logs: [log('2026-09-01', 150, 100), log('2026-09-02', 150, 100)] });
    expect(result.recommendedServings).toBe(100);
    expect(result.historicalAdjustment).toBe(15);
  });

  it('omits history adjustment with fewer than two matching logs', () => {
    expect(calculateRecommendation({ expectedAttendance: 100, mealIds: ['m1'], logs: [log('2026-09-01', 120, 100)] }).historicalAdjustment).toBe(0);
  });

  it('calculates insights only from recorded logs', () => {
    const meals: Meal[] = [{ id: 'm1', providerId: 's1', name: 'Tomato rice', createdAt: '2026-09-01' }];
    const insights = calculateInsights([log('2026-09-01', 110, 100, 8)], meals, new Date('2026-09-07'));
    expect(insights.leftoverPer100Attendees).toBe(8);
    expect(insights.topMeals[0].name).toBe('Tomato rice');
  });

  it('generates biweekly dates', () => {
    expect(recurrenceDates('2026-09-07', 'BIWEEKLY', '2026-10-06')).toEqual(['2026-09-07', '2026-09-21', '2026-10-05']);
  });
});
