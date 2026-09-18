import { createServer, type Server } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let server: Server;
let baseUrl = '';
let adminCookie = '';
let producerTypeId = '';
let collectorTypeId = '';

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
  process.env.ATTACHMENT_PATH = join(directory, 'attachments');
  process.env.NODE_ENV = 'test';
  const { app } = await import('./server.js');
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not start.');
  baseUrl = `http://127.0.0.1:${address.port}`;
  const login = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ accessCode: 'ADMIN-BLOOM', passphrase: 'bloom-admin' }) });
  adminCookie = login.cookie;
  const producerType = await asAdmin('/api/admin/organization-types', { method: 'POST', body: JSON.stringify({ role: 'FOOD_WASTE_PRODUCER', name: 'Test producer', documentRequirements: [{ label: 'Business registration', required: true, sortOrder: 0 }] }) });
  const collectorType = await asAdmin('/api/admin/organization-types', { method: 'POST', body: JSON.stringify({ role: 'FOOD_COLLECTOR', name: 'Test collector', documentRequirements: [] }) });
  producerTypeId = producerType.body.id; collectorTypeId = collectorType.body.id;
});

afterAll(async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });

describe('admin operations API', () => {
  it('submits, approves, and completes first login without exposing plaintext credentials', async () => {
    const draft = await request('/api/access-requests/drafts', { method: 'POST', body: JSON.stringify({ applicantName: 'Test Operator', role: 'FOOD_WASTE_PRODUCER', organizationTypeId: producerTypeId, organizationName: 'Test Community Kitchen', address: '12 Test Service Road', email: 'operator-test@example.org', whatsapp: '+919876543210', preferredContactMethod: 'EMAIL', weeklyWasteKg: 42 }) });
    expect(draft.response.status).toBe(201);
    const requirement = draft.body.requiredDocuments[0];
    const incomplete = await request(`/api/access-requests/${draft.body.id}/finalize`, { method: 'POST' });
    expect(incomplete.response.status).toBe(422);
    const spoofed = await request(`/api/access-requests/${draft.body.id}/documents`, { method: 'POST', body: JSON.stringify({ requirementId: requirement.id, fileName: 'fake.pdf', mediaType: 'application/pdf', dataUrl: `data:application/pdf;base64,${Buffer.from('not a pdf').toString('base64')}` }) });
    expect(spoofed.response.status).toBe(422);
    const uploaded = await request(`/api/access-requests/${draft.body.id}/documents`, { method: 'POST', body: JSON.stringify({ requirementId: requirement.id, fileName: 'registration.pdf', mediaType: 'application/pdf', dataUrl: `data:application/pdf;base64,${Buffer.from('%PDF-1.4\n%%EOF').toString('base64')}` }) });
    expect(uploaded.response.status).toBe(201);
    expect(uploaded.body.objectKey).toBeUndefined();
    const deniedDocument = await request(`/api/admin/access-request-documents/${uploaded.body.id}/access`);
    expect(deniedDocument.response.status).toBe(401);
    const documentAccess = await asAdmin(`/api/admin/access-request-documents/${uploaded.body.id}/access`);
    expect(documentAccess.body.url).toContain(`/api/access-request-documents/${uploaded.body.id}/content`);
    const submitted = await request(`/api/access-requests/${draft.body.id}/finalize`, { method: 'POST' });
    expect(submitted.body.status).toBe('PENDING');
    const reviewing = await asAdmin(`/api/admin/access-requests/${draft.body.id}/begin-review`, { method: 'POST' });
    expect(reviewing.body.status).toBe('UNDER_REVIEW');
    const approved = await asAdmin(`/api/admin/access-requests/${draft.body.id}/approve`, { method: 'POST' });
    expect(approved.body.accessCode).toMatch(/^FWP-/);
    const login = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ accessCode: approved.body.accessCode, passphrase: approved.body.passphrase }) });
    expect(login.body.firstLogin).toBe(true);
    expect(login.body.organizationTypeName).toBe('Test producer');
    const changed = await request('/api/auth/change-passphrase', { method: 'POST', headers: { cookie: login.cookie }, body: JSON.stringify({ passphrase: 'new-private-passphrase' }) });
    expect(changed.body.firstLogin).toBe(false);
    const profile = await request('/api/account/profile', { method: 'PATCH', headers: { cookie: changed.cookie }, body: JSON.stringify({ displayName: 'Updated Operator' }) });
    expect(profile.body.displayName).toBe('Updated Operator');
    expect(profile.body.organizationTypeName).toBe('Test producer');
    await asAdmin(`/api/admin/organization-types/${producerTypeId}`, { method: 'PATCH', body: JSON.stringify({ name: 'Restaurant partner', active: false }) });
    const refreshedProfile = await request('/api/auth/me', { headers: { cookie: changed.cookie } });
    expect(refreshedProfile.body.organizationTypeName).toBe('Restaurant partner');
    const selfChanged = await request('/api/account/change-passphrase', { method: 'POST', headers: { cookie: changed.cookie }, body: JSON.stringify({ currentPassphrase: 'new-private-passphrase', newPassphrase: 'another-private-passphrase' }) });
    expect(selfChanged.response.status).toBe(200);
    const nameRequest = await request('/api/account/organization-name-request', { method: 'POST', headers: { cookie: selfChanged.cookie }, body: JSON.stringify({ requestedName: 'Updated Community Kitchen', reason: 'Registered name changed' }) });
    expect(nameRequest.response.status).toBe(201);
    const approvedName = await asAdmin(`/api/admin/organization-name-requests/${nameRequest.body.id}/approve`, { method: 'POST' });
    expect(approvedName.body.account.organizationName).toBe('Updated Community Kitchen');
    const audit = await asAdmin('/api/admin/audit-events');
    expect(audit.body.data.some((event: any) => event.action === 'REQUEST_APPROVED')).toBe(true);
    expect(JSON.stringify(audit.body)).not.toContain(approved.body.passphrase);
  });

  it('requires manual WhatsApp contact before approving a collector', async () => {
    const draft = await request('/api/access-requests/drafts', { method: 'POST', body: JSON.stringify({ applicantName: 'WhatsApp Operator', role: 'FOOD_COLLECTOR', organizationTypeId: collectorTypeId, organizationName: 'Private Collection Co', address: '44 Recovery Avenue', email: 'whatsapp-test@example.org', whatsapp: '+919812345678', preferredContactMethod: 'WHATSAPP', hasTransportFacilities: true, transportFacilities: 'Two refrigerated vans and sealed collection bins' }) });
    await request(`/api/access-requests/${draft.body.id}/finalize`, { method: 'POST' });
    const reviewing = await asAdmin(`/api/admin/access-requests/${draft.body.id}/begin-review`, { method: 'POST' });
    expect(reviewing.body.contactedAt).toBeUndefined();
    const premature = await asAdmin(`/api/admin/access-requests/${draft.body.id}/approve`, { method: 'POST' });
    expect(premature.response.status).toBe(409);
    const contacted = await asAdmin(`/api/admin/access-requests/${draft.body.id}/mark-contacted`, { method: 'POST' });
    expect(contacted.body.contactChannel).toBe('WHATSAPP');
    const approved = await asAdmin(`/api/admin/access-requests/${draft.body.id}/approve`, { method: 'POST' });
    expect(approved.body.accessCode).toMatch(/^FCL-/);
  });

  it('publishes administrator-managed signup options immediately', async () => {
    const created = await asAdmin('/api/admin/organization-types', { method: 'POST', body: JSON.stringify({ role: 'FOOD_WASTE_PRODUCER', name: 'Hospital kitchen', documentRequirements: [] }) });
    expect(created.response.status).toBe(201);
    const publicTypes = await request('/api/organization-types');
    expect(publicTypes.body.data.some((item: any) => item.name === 'Hospital kitchen')).toBe(true);
    await asAdmin(`/api/admin/organization-types/${created.body.id}`, { method: 'PATCH', body: JSON.stringify({ active: false }) });
    const refreshed = await request('/api/organization-types');
    expect(refreshed.body.data.some((item: any) => item.id === created.body.id)).toBe(false);
  });

  it('creates, suspends, reactivates, and resets an account', async () => {
    const created = await asAdmin('/api/admin/accounts', { method: 'POST', body: JSON.stringify({ role: 'FOOD_COLLECTOR', organizationTypeId: collectorTypeId, displayName: 'Collector Test', organizationName: 'Route Test', contact: 'collector-test@example.org' }) });
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

  it('does not expose administrator provisioning through the organization account endpoint', async () => {
    const attempted = await asAdmin('/api/admin/accounts', { method: 'POST', body: JSON.stringify({ role: 'ADMIN', organizationTypeId: producerTypeId, displayName: 'Unexpected Admin', organizationName: 'Bloom Operations', contact: 'unexpected-admin@example.org' }) });
    expect(attempted.response.status).toBe(422);
    const accounts = await asAdmin('/api/admin/accounts');
    expect(accounts.body.data.some((account: any) => account.role === 'ADMIN')).toBe(false);
  });

  it('rate limits repeated account-link attempts', async () => {
    const attempts = [];
    for (let index = 0; index < 13; index += 1) attempts.push(await request('/api/auth/complete-account-link', { method: 'POST', body: JSON.stringify({ token: `invalid-setup-token-${index}`, passphrase: 'long-enough-passphrase', purpose: 'SETUP' }) }));
    expect(attempts.at(-1)?.response.status).toBe(429);
  });

  it('constrains pickup overrides and records their reasons', async () => {
    const login = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ accessCode: 'FWP-DEMO', passphrase: 'bloom-producer' }) });
    const headers = { cookie: login.cookie };
    const log = await request('/api/waste-logs', { method: 'POST', headers, body: JSON.stringify({ recordedAt: '2027-01-19T12:30:00.000Z', servicePeriod: 'LUNCH', wasteStage: 'OVERPRODUCTION', foodCategory: 'Rice', leftoverKg: 4, reason: 'OVERPRODUCTION', suitableForCollection: true, notes: '' }) });
    const secondLog = await request('/api/waste-logs', { method: 'POST', headers, body: JSON.stringify({ recordedAt: '2027-01-19T20:00:00.000Z', servicePeriod: 'DINNER', wasteStage: 'PLATE_RETURN', foodCategory: 'Curry', leftoverKg: 1, reason: 'CUSTOMER_PREFERENCE', suitableForCollection: false, notes: '' }) });
    expect(secondLog.response.status).toBe(201);
    const start = new Date(Date.now() + 60_000).toISOString();
    const end = new Date(Date.now() + 3_600_000).toISOString();
    const pickup = await request(`/api/waste-logs/${log.body.id}/publish-pickup`, { method: 'POST', headers, body: JSON.stringify({ eligibleRoles: ['FOOD_COLLECTOR'], availableFrom: start, pickupDeadline: end, instructions: 'Use the service gate' }) });
    const expired = await asAdmin(`/api/admin/pickups/${pickup.body.id}/override`, { method: 'POST', body: JSON.stringify({ action: 'EXPIRE', reason: 'Collection window elapsed' }) });
    expect(expired.body.status).toBe('EXPIRED');
    const reopened = await asAdmin(`/api/admin/pickups/${pickup.body.id}/override`, { method: 'POST', body: JSON.stringify({ action: 'REOPEN', reason: 'A new collection window is available' }) });
    expect(reopened.body.status).toBe('AVAILABLE');
    const invalid = await asAdmin(`/api/admin/pickups/${pickup.body.id}/override`, { method: 'POST', body: JSON.stringify({ action: 'REOPEN', reason: 'Invalid repeat' }) });
    expect(invalid.response.status).toBe(409);
  });

  it('reserves atomically and completes a recovery handoff with provider confirmation', async () => {
    const providerLogin = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ accessCode: 'FWP-DEMO', passphrase: 'bloom-producer' }) });
    const providerHeaders = { cookie: providerLogin.cookie };
    await request('/api/account/collection-profile', { method: 'PATCH', headers: providerHeaders, body: JSON.stringify({ locality: 'Coimbatore', collectionAddress: '12 Service Road, Coimbatore 641001', collectionInstructions: 'Use the kitchen gate' }) });
    const collector = await asAdmin('/api/admin/accounts', { method: 'POST', body: JSON.stringify({ role: 'FOOD_COLLECTOR', organizationTypeId: collectorTypeId, displayName: 'Collector One', organizationName: 'Recovery Route One', contact: 'collector-race@example.org' }) });
    const secondCollector = await asAdmin('/api/admin/accounts', { method: 'POST', body: JSON.stringify({ role: 'FOOD_COLLECTOR', organizationTypeId: collectorTypeId, displayName: 'Collector Two', organizationName: 'Recovery Route Two', contact: 'collector-two@example.org' }) });
    const collectorLogin = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ accessCode: collector.body.accessCode, passphrase: collector.body.passphrase }) });
    const secondCollectorLogin = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ accessCode: secondCollector.body.accessCode, passphrase: secondCollector.body.passphrase }) });
    const log = await request('/api/waste-logs', { method: 'POST', headers: providerHeaders, body: JSON.stringify({ recordedAt: '2027-01-20T12:30:00.000Z', servicePeriod: 'LUNCH', wasteStage: 'OVERPRODUCTION', foodCategory: 'Rice', leftoverKg: 6, reason: 'OVERPRODUCTION', suitableForCollection: true, notes: '' }) });
    const pickup = await request(`/api/waste-logs/${log.body.id}/publish-pickup`, { method: 'POST', headers: providerHeaders, body: JSON.stringify({ eligibleRoles: ['FOOD_COLLECTOR'], availableFrom: new Date(Date.now() - 60_000).toISOString(), pickupDeadline: new Date(Date.now() + 3_600_000).toISOString(), instructions: 'Ring the kitchen bell' }) });
    const attempts = await Promise.all([
      request(`/api/recovery/pickups/${pickup.body.id}/reserve`, { method: 'POST', headers: { cookie: collectorLogin.cookie } }),
      request(`/api/recovery/pickups/${pickup.body.id}/reserve`, { method: 'POST', headers: { cookie: secondCollectorLogin.cookie } })
    ]);
    expect(attempts.map((attempt) => attempt.response.status).sort()).toEqual([200, 409]);
    const winner = attempts[0].response.status === 200 ? collectorLogin.cookie : secondCollectorLogin.cookie;
    const loser = attempts[0].response.status === 200 ? secondCollectorLogin.cookie : collectorLogin.cookie;
    const providerConversations = await request('/api/chat/conversations', { headers: providerHeaders });
    const pickupConversation = providerConversations.body.data.find((conversation: any) => conversation.pickupId === pickup.body.id);
    expect(pickupConversation).toBeTruthy();
    const messageBody = { text: 'We will be at the service gate.', attachmentIds: [], idempotencyKey: 'integration-message-0001' };
    const firstMessage = await request(`/api/chat/conversations/${pickupConversation.id}/messages`, { method: 'POST', headers: { cookie: winner }, body: JSON.stringify(messageBody) });
    const repeatedMessage = await request(`/api/chat/conversations/${pickupConversation.id}/messages`, { method: 'POST', headers: { cookie: winner }, body: JSON.stringify(messageBody) });
    expect(repeatedMessage.body.id).toBe(firstMessage.body.id);
    const unrelated = await request(`/api/chat/conversations/${pickupConversation.id}/messages`, { headers: { cookie: loser } });
    expect(unrelated.response.status).toBe(404);
    const joined = await asAdmin(`/api/admin/chat/conversations/${pickupConversation.id}/join`, { method: 'POST' });
    expect(joined.body.adminJoinedAt).toBeTruthy();
    const started = await request(`/api/recovery/pickups/${pickup.body.id}/start-transit`, { method: 'POST', headers: { cookie: winner } });
    expect(started.body.status).toBe('IN_TRANSIT');
    const handedOff = await request(`/api/recovery/pickups/${pickup.body.id}/complete-handoff`, { method: 'POST', headers: { cookie: winner } });
    expect(handedOff.body.status).toBe('AWAITING_PROVIDER_CONFIRMATION');
    const confirmed = await request(`/api/pickups/${pickup.body.id}/confirm`, { method: 'POST', headers: providerHeaders });
    expect(confirmed.body.status).toBe('COLLECTED');
    expect(confirmed.body.collectionAddress).toBe('12 Service Road, Coimbatore 641001');
  });
});
