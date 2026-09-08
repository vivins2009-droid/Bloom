import { createServer, type Server } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let server: Server;
let baseUrl = '';
let adminCookie = '';

async function request(path: string, options: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers: { 'content-type': 'application/json', ...(options.headers ?? {}) } });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  return { response, body, cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '' };
}

const asAdmin = (path: string, options: RequestInit = {}) => request(path, { ...options, headers: { cookie: adminCookie, ...(options.headers ?? {}) } });

beforeAll(async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bloom-admin-test-'));
  process.env.DATA_DRIVER = 'file';
  process.env.DATA_FILE = join(directory, 'state.json');
  process.env.NODE_ENV = 'test';
  const { app } = await import('./server.js');
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not start.');
  baseUrl = `http://127.0.0.1:${address.port}`;
  const login = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ accessCode: 'ADMIN-BLOOM', passphrase: 'bloom-admin' }) });
  adminCookie = login.cookie;
});

afterAll(async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });

describe.sequential('admin operations API', () => {
  it('submits, approves, and completes first login without exposing plaintext credentials', async () => {
    const submitted = await request('/api/access-requests', { method: 'POST', body: JSON.stringify({ applicantName: 'Test Operator', role: 'FOOD_PROVIDER', organizationTypeId: 'type-public-school', organizationName: 'Test Community Kitchen', contact: 'operator-test@example.org', note: 'Integration check' }) });
    expect(submitted.response.status).toBe(201);
    expect(submitted.body.organizationTypeName).toBe('Public school');
    const approved = await asAdmin(`/api/admin/access-requests/${submitted.body.id}/approve`, { method: 'POST' });
    expect(approved.body.accessCode).toMatch(/^FPR-/);
    const login = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ accessCode: approved.body.accessCode, passphrase: approved.body.passphrase }) });
    expect(login.body.firstLogin).toBe(true);
    const changed = await request('/api/auth/change-passphrase', { method: 'POST', headers: { cookie: login.cookie }, body: JSON.stringify({ passphrase: 'new-private-passphrase' }) });
    expect(changed.body.firstLogin).toBe(false);
    const profile = await request('/api/account/profile', { method: 'PATCH', headers: { cookie: login.cookie }, body: JSON.stringify({ displayName: 'Updated Operator' }) });
    expect(profile.body.displayName).toBe('Updated Operator');
    const selfChanged = await request('/api/account/change-passphrase', { method: 'POST', headers: { cookie: login.cookie }, body: JSON.stringify({ currentPassphrase: 'new-private-passphrase', newPassphrase: 'another-private-passphrase' }) });
    expect(selfChanged.response.status).toBe(200);
    const nameRequest = await request('/api/account/organization-name-request', { method: 'POST', headers: { cookie: login.cookie }, body: JSON.stringify({ requestedName: 'Updated Community Kitchen', reason: 'Registered name changed' }) });
    expect(nameRequest.response.status).toBe(201);
    const approvedName = await asAdmin(`/api/admin/organization-name-requests/${nameRequest.body.id}/approve`, { method: 'POST' });
    expect(approvedName.body.account.organizationName).toBe('Updated Community Kitchen');
    const audit = await asAdmin('/api/admin/audit-events');
    expect(audit.body.data.some((event: any) => event.action === 'REQUEST_APPROVED')).toBe(true);
    expect(JSON.stringify(audit.body)).not.toContain(approved.body.passphrase);
  });

  it('publishes administrator-managed signup options immediately', async () => {
    const created = await asAdmin('/api/admin/organization-types', { method: 'POST', body: JSON.stringify({ role: 'FOOD_PROVIDER', name: 'Hospital kitchen' }) });
    expect(created.response.status).toBe(201);
    const publicTypes = await request('/api/organization-types');
    expect(publicTypes.body.data.some((item: any) => item.name === 'Hospital kitchen')).toBe(true);
    await asAdmin(`/api/admin/organization-types/${created.body.id}`, { method: 'PATCH', body: JSON.stringify({ active: false }) });
    const refreshed = await request('/api/organization-types');
    expect(refreshed.body.data.some((item: any) => item.id === created.body.id)).toBe(false);
  });

  it('creates, suspends, reactivates, and resets an account', async () => {
    const created = await asAdmin('/api/admin/accounts', { method: 'POST', body: JSON.stringify({ role: 'FARMER_COLLECTOR', organizationTypeId: 'type-independent-collector', displayName: 'Collector Test', organizationName: 'Route Test', contact: 'collector-test@example.org' }) });
    const accountId = created.body.account.id;
    const suspended = await asAdmin(`/api/admin/accounts/${accountId}/status`, { method: 'POST', body: JSON.stringify({ status: 'SUSPENDED', reason: 'Temporary integration check' }) });
    expect(suspended.body.status).toBe('SUSPENDED');
    const denied = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ accessCode: created.body.accessCode, passphrase: created.body.passphrase }) });
    expect(denied.response.status).toBe(403);
    const active = await asAdmin(`/api/admin/accounts/${accountId}/status`, { method: 'POST', body: JSON.stringify({ status: 'ACTIVE', reason: 'Integration check complete' }) });
    expect(active.body.status).toBe('ACTIVE');
    const reset = await asAdmin(`/api/admin/accounts/${accountId}/reset-passphrase`, { method: 'POST', body: JSON.stringify({ reason: 'Verify one-time reset flow' }) });
    expect(reset.body.passphrase).toBeTruthy();
  });

  it('constrains pickup overrides and records their reasons', async () => {
    const login = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ accessCode: 'SCH-DEMO', passphrase: 'bloom-school' }) });
    const headers = { cookie: login.cookie };
    const log = await request('/api/waste-logs', { method: 'POST', headers, body: JSON.stringify({ date: '2027-01-19', mealIds: ['meal-tomato'], actualAttendance: 80, servingsPrepared: 90, leftoverKg: 4, reason: 'OVERPRODUCTION', suitableForCollection: true, notes: '' }) });
    const secondLog = await request('/api/waste-logs', { method: 'POST', headers, body: JSON.stringify({ date: '2027-01-19', mealIds: ['meal-sambar'], actualAttendance: 30, servingsPrepared: 34, leftoverKg: 1, reason: 'LOW_ATTENDANCE', suitableForCollection: false, notes: '' }) });
    expect(secondLog.response.status).toBe(201);
    const pickup = await request(`/api/waste-logs/${log.body.id}/publish-pickup`, { method: 'POST', headers });
    const expired = await asAdmin(`/api/admin/pickups/${pickup.body.id}/override`, { method: 'POST', body: JSON.stringify({ action: 'EXPIRE', reason: 'Collection window elapsed' }) });
    expect(expired.body.status).toBe('EXPIRED');
    const reopened = await asAdmin(`/api/admin/pickups/${pickup.body.id}/override`, { method: 'POST', body: JSON.stringify({ action: 'REOPEN', reason: 'A new collection window is available' }) });
    expect(reopened.body.status).toBe('AVAILABLE');
    const invalid = await asAdmin(`/api/admin/pickups/${pickup.body.id}/override`, { method: 'POST', body: JSON.stringify({ action: 'REOPEN', reason: 'Invalid repeat' }) });
    expect(invalid.response.status).toBe(409);
  });
});
