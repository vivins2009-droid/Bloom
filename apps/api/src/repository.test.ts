import { describe, expect, it } from 'vitest';
import { createAccessCode, normalizeDatabase } from './repository.js';

describe('admin data foundation', () => {
  it('migrates legacy school ownership without changing access codes', () => {
    const migrated = normalizeDatabase({
      accounts: [{ id: 'school-1', role: 'SCHOOL', accessCode: 'SCH-OLD', passphraseHash: 'salt:hash', displayName: 'A', organizationName: 'Old School', firstLogin: false, createdAt: '2026-01-01' }],
      accessRequests: [{ id: 'request-1', applicantName: 'B', role: 'SCHOOL', organizationName: 'Next School', contact: 'b@example.org', note: '', status: 'PENDING', createdAt: '2026-01-01' }],
      meals: [{ id: 'meal-1', schoolId: 'school-1', name: 'Rice', createdAt: '2026-01-01' }],
      assignments: [], logs: [],
      pickups: [{ id: 'pickup-1', schoolId: 'school-1', wasteLogId: 'log-1', estimatedWeightKg: 4, destination: 'LIVESTOCK_OR_COMPOST', status: 'AWAITING_SCHOOL_CONFIRMATION', createdAt: '2026-01-01', updatedAt: '2026-01-01' }]
    });
    expect(migrated.schemaVersion).toBe(3);
    expect(migrated.accounts[0]).toMatchObject({ role: 'FOOD_PROVIDER', accessCode: 'SCH-OLD', organizationTypeId: 'type-public-school', status: 'ACTIVE' });
    expect(migrated.accessRequests[0]).toMatchObject({ role: 'FOOD_PROVIDER', organizationTypeName: 'Public school' });
    expect(migrated.meals[0].providerId).toBe('school-1');
    expect(migrated.pickups[0]).toMatchObject({ providerId: 'school-1', status: 'AWAITING_PROVIDER_CONFIRMATION', eligibleRoles: ['FARMER_COLLECTOR', 'COMPOSTER'] });
  });

  it('creates role-specific access codes without collisions', () => {
    const first = createAccessCode('FOOD_PROVIDER', []);
    const second = createAccessCode('FOOD_PROVIDER', [{ id: '1', role: 'FOOD_PROVIDER', accessCode: first, passphraseHash: '', displayName: '', organizationName: '', contact: '', organizationTypeId: 'type-public-school', status: 'ACTIVE', firstLogin: true, createdAt: '' }]);
    expect(first).toMatch(/^FPR-[A-F0-9]{6}$/);
    expect(second).toMatch(/^FPR-[A-F0-9]{6}$/);
    expect(second).not.toBe(first);
    expect(createAccessCode('FARMER_COLLECTOR', [])).toMatch(/^FCL-/);
    expect(createAccessCode('COMPOSTER', [])).toMatch(/^CMP-/);
  });
});
