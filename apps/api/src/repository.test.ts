import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccessCode, FileRepository, normalizeDatabase } from './repository.js';

describe('admin data foundation', () => {
  it('migrates legacy school ownership without changing access codes', () => {
    const migrated = normalizeDatabase({
      accounts: [{ id: 'school-1', role: 'SCHOOL', accessCode: 'SCH-OLD', passphraseHash: 'salt:hash', displayName: 'A', organizationName: 'Old School', firstLogin: false, createdAt: '2026-01-01' }],
      accessRequests: [{ id: 'request-1', applicantName: 'B', role: 'SCHOOL', organizationName: 'Next School', contact: 'b@example.org', note: '', status: 'PENDING', createdAt: '2026-01-01' }],
      meals: [{ id: 'meal-1', schoolId: 'school-1', name: 'Rice', createdAt: '2026-01-01' }],
      assignments: [], logs: [],
      pickups: [{ id: 'pickup-1', schoolId: 'school-1', wasteLogId: 'log-1', estimatedWeightKg: 4, destination: 'LIVESTOCK_OR_COMPOST', status: 'AWAITING_SCHOOL_CONFIRMATION', createdAt: '2026-01-01', updatedAt: '2026-01-01' }]
    });
    expect(migrated.schemaVersion).toBe(5);
    expect(migrated.accounts[0]).toMatchObject({ role: 'FOOD_WASTE_PRODUCER', accessCode: 'SCH-OLD', organizationTypeId: 'type-community-kitchen', status: 'ACTIVE' });
    expect(migrated.accessRequests[0]).toMatchObject({ role: 'FOOD_WASTE_PRODUCER' });
    expect(migrated.meals[0].providerId).toBe('school-1');
    expect(migrated.pickups[0]).toMatchObject({ providerId: 'school-1', status: 'AWAITING_PROVIDER_CONFIRMATION', eligibleRoles: ['FOOD_COLLECTOR'] });
  });

  it('creates role-specific access codes without collisions', () => {
    const first = createAccessCode('FOOD_WASTE_PRODUCER', []);
    const second = createAccessCode('FOOD_WASTE_PRODUCER', [{ id: '1', role: 'FOOD_WASTE_PRODUCER', accessCode: first, passphraseHash: '', displayName: '', organizationName: '', contact: '', organizationTypeId: 'type-community-kitchen', status: 'ACTIVE', firstLogin: true, createdAt: '' }]);
    expect(first).toMatch(/^FWP-[A-F0-9]{6}$/);
    expect(second).toMatch(/^FWP-[A-F0-9]{6}$/);
    expect(second).not.toBe(first);
    expect(createAccessCode('FOOD_COLLECTOR', [])).toMatch(/^FCL-/);
  });

  it('restores every advertised local demo account after a data reset', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bloom-demo-reset-'));
    const file = join(directory, 'dev.json');
    const reset = normalizeDatabase({
      accounts: [{ id: 'acct-admin', role: 'ADMIN', accessCode: 'ADMIN-BLOOM', passphraseHash: 'salt:hash', displayName: 'Bloom Administrator', organizationName: 'Bloom Operations', contact: 'admin@example.org', status: 'ACTIVE', firstLogin: false, createdAt: '2026-01-01' }],
      organizationTypes: []
    });
    await writeFile(file, JSON.stringify(reset));
    const database = await new FileRepository(file).read();
    expect(database.accounts.map((account) => account.accessCode)).toEqual(expect.arrayContaining(['ADMIN-BLOOM', 'FWP-DEMO', 'FCL-DEMO']));
    expect(JSON.parse(await readFile(file, 'utf8')).accounts).toHaveLength(3);
  });
});
