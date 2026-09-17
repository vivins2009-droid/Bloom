import { describe, expect, it } from 'vitest';
import { calculateInsights, calculateRecommendation, reconcilePickup, recurrenceDates, roleCanRecoverPickup } from './domain.js';
import type { DailyWasteLog, Meal, Pickup } from '@bloom/contracts';

const log = (date: string, prepared: number, attendance: number, leftoverKg = 5): DailyWasteLog => ({
  id: date, providerId: 's1', date, mealIds: ['m1'], actualAttendance: attendance, servingsPrepared: prepared,
  leftoverKg, reason: 'OVERPRODUCTION', suitableForCollection: true, notes: '', createdAt: `${date}T10:00:00Z`
});

describe('food provider domain', () => {
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

const pickup = (status: Pickup['status'] = 'AVAILABLE'): Pickup => ({ id: 'p1', providerId: 'provider', providerName: 'Producer', wasteLogId: 'log', estimatedWeightKg: 5, eligibleRoles: ['FOOD_COLLECTOR'], status, availableFrom: '2026-09-09T09:00:00.000Z', pickupDeadline: '2026-09-09T12:00:00.000Z', locality: 'Coimbatore', collectionAddress: '12 Service Road', collectionInstructions: '', activity: [], createdAt: '2026-09-09T08:00:00.000Z', updatedAt: '2026-09-09T08:00:00.000Z' });

describe('recovery pickup rules', () => {
  it('limits visibility to eligible recovery roles', () => {
    const item = pickup();
    expect(roleCanRecoverPickup('FOOD_COLLECTOR', item)).toBe(true);
    expect(roleCanRecoverPickup('FOOD_WASTE_PRODUCER', item)).toBe(false);
    expect(roleCanRecoverPickup('ADMIN', item)).toBe(false);
  });

  it('returns an expired reservation to the available network before its deadline', () => {
    const item = { ...pickup('RESERVED'), reservedByAccountId: 'partner', reservedAt: '2026-09-09T09:00:00.000Z', reservationExpiresAt: '2026-09-09T09:30:00.000Z' };
    expect(reconcilePickup(item, new Date('2026-09-09T09:31:00.000Z'))).toBe(true);
    expect(item.status).toBe('AVAILABLE');
    expect(item.reservedByAccountId).toBeUndefined();
    expect(item.activity.at(-1)?.toStatus).toBe('AVAILABLE');
  });

  it('does not silently release an overdue in-transit pickup', () => {
    const item = pickup('IN_TRANSIT');
    expect(reconcilePickup(item, new Date('2026-09-09T13:00:00.000Z'))).toBe(false);
    expect(item.status).toBe('IN_TRANSIT');
  });
});
