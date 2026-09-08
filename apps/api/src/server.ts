import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Account, AccountRole, AccessRequest, AdminAuditAction, DailyWasteLog, MealAssignment, PickupStatus, PublicAccountRole } from '@bloom/contracts';
import { calculateInsights, calculateRecommendation, recurrenceDates } from './domain.js';
import { createAccessCode, createPassphrase, createRepository, hashPassphrase, verifyPassphrase, type Repository } from './repository.js';

const app = express();
const port = Number(process.env.PORT || 5002);
const origin = process.env.WEB_ORIGIN || 'http://localhost:5175';
const sessions = new Map<string, { accountId: string; expiresAt: number }>();
const repository = await createRepository();

app.use(cors({ origin, credentials: true }));
app.use(express.json({ limit: '200kb' }));
app.use(cookieParser());

type AuthedRequest = Request & { account?: Account; traceId?: string };
app.use((req: AuthedRequest, res, next) => {
  req.traceId = randomUUID();
  res.setHeader('x-trace-id', req.traceId);
  next();
});

const asyncRoute = (handler: (req: AuthedRequest, res: Response, next: NextFunction) => Promise<void>) =>
  (req: AuthedRequest, res: Response, next: NextFunction) => handler(req, res, next).catch(next);

const publicAccount = (account: any): Account => {
  const { passphraseHash: _passphraseHash, ...safe } = account;
  return safe;
};

const authenticate = asyncRoute(async (req, res, next) => {
  const token = req.cookies.bloom_session;
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    if (token) sessions.delete(token);
    res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' } });
    return;
  }
  const db = await repository.read();
  const account = db.accounts.find((item) => item.id === session.accountId);
  if (!account || account.status === 'SUSPENDED') {
    sessions.delete(token);
    res.status(401).json({ error: { code: 'SESSION_INVALID', message: 'Your session is no longer valid. Sign in again.' } });
    return;
  }
  req.account = publicAccount(account);
  next();
});

const requireRole = (...roles: AccountRole[]) => (req: AuthedRequest, res: Response, next: NextFunction) => {
  if (!req.account || !roles.includes(req.account.role)) {
    res.status(403).json({ error: { code: 'FORBIDDEN', message: 'This account cannot perform that action.' } });
    return;
  }
  next();
};

const addAudit = (db: Awaited<ReturnType<Repository['read']>>, actor: Account, input: { action: AdminAuditAction; objectType: 'ACCESS_REQUEST' | 'ACCOUNT' | 'ORGANIZATION_TYPE' | 'ORGANIZATION_NAME_REQUEST' | 'PICKUP'; objectId: string; objectLabel: string; summary: string; reason?: string }) => {
  db.auditEvents.unshift({ id: randomUUID(), actorId: actor.id, actorName: actor.displayName, createdAt: new Date().toISOString(), ...input });
};

const requestSchema = z.object({
  applicantName: z.string().trim().min(2).max(80),
  role: z.enum(['FOOD_PROVIDER', 'FARMER_COLLECTOR', 'COMPOSTER']),
  organizationTypeId: z.string().trim().min(1),
  organizationName: z.string().trim().min(2).max(120),
  contact: z.string().trim().min(5).max(120),
  note: z.string().trim().max(500).default('')
});

app.get('/api/health', (_req, res) => res.json({ status: 'ok', driver: process.env.DATA_DRIVER }));

app.get('/api/organization-types', asyncRoute(async (_req, res) => {
  const db = await repository.read();
  const data = db.organizationTypes.filter((item) => item.active).sort((a, b) => a.role.localeCompare(b.role) || a.sortOrder - b.sortOrder);
  res.json({ data });
}));

app.post('/api/access-requests', asyncRoute(async (req, res) => {
  const parsed = requestSchema.parse(req.body);
  const result = await repository.mutate((db) => {
    const organizationType = db.organizationTypes.find((item) => item.id === parsed.organizationTypeId && item.role === parsed.role && item.active);
    if (!organizationType) return { invalidType: true as const };
    const duplicate = db.accessRequests.find((item) => item.contact.toLowerCase() === parsed.contact.toLowerCase() && item.status === 'PENDING');
    if (duplicate) return { duplicate };
    const request: AccessRequest = { id: randomUUID(), ...parsed, organizationTypeName: organizationType.name, status: 'PENDING', createdAt: new Date().toISOString() };
    db.accessRequests.unshift(request);
    return { request };
  });
  if ('invalidType' in result) { res.status(422).json({ error: { code: 'INVALID_ORGANIZATION_TYPE', message: 'Choose an available organization type.' } }); return; }
  if ('duplicate' in result) {
    res.status(409).json({ error: { code: 'REQUEST_EXISTS', message: 'A pending request already exists for this contact.' } });
    return;
  }
  res.status(201).json(result.request);
}));

app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const input = z.object({ accessCode: z.string().trim().min(3), passphrase: z.string().min(6) }).parse(req.body);
  const db = await repository.read();
  const stored = db.accounts.find((account) => account.accessCode.toUpperCase() === input.accessCode.toUpperCase());
  if (!stored || !verifyPassphrase(input.passphrase, stored.passphraseHash)) {
    res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'The access code or passphrase is incorrect.' } });
    return;
  }
  if (stored.status === 'SUSPENDED') { res.status(403).json({ error: { code: 'ACCOUNT_SUSPENDED', message: 'This account is suspended. Contact the administrator.' } }); return; }
  const token = randomUUID();
  sessions.set(token, { accountId: stored.id, expiresAt: Date.now() + 12 * 60 * 60 * 1000 });
  res.cookie('bloom_session', token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 12 * 60 * 60 * 1000 });
  res.json(publicAccount(stored));
}));

app.get('/api/auth/me', authenticate, asyncRoute(async (req, res) => { res.json(req.account); }));
app.post('/api/auth/logout', authenticate, asyncRoute(async (req, res) => {
  sessions.delete(req.cookies.bloom_session);
  res.clearCookie('bloom_session');
  res.json({ success: true });
}));

app.post('/api/auth/change-passphrase', authenticate, asyncRoute(async (req, res) => {
  const input = z.object({ passphrase: z.string().min(10).max(128) }).parse(req.body);
  const updated = await repository.mutate((db) => {
    const account = db.accounts.find((item) => item.id === req.account!.id)!;
    account.passphraseHash = hashPassphrase(input.passphrase);
    account.firstLogin = false;
    return publicAccount(account);
  });
  res.json(updated);
}));

app.patch('/api/account/profile', authenticate, asyncRoute(async (req, res) => {
  const { displayName } = z.object({ displayName: z.string().trim().min(2).max(80) }).parse(req.body);
  const updated = await repository.mutate((db) => {
    const account = db.accounts.find((item) => item.id === req.account!.id)!;
    const previous = account.displayName; account.displayName = displayName;
    addAudit(db, req.account!, { action: 'ACCOUNT_HOLDER_UPDATED', objectType: 'ACCOUNT', objectId: account.id, objectLabel: account.organizationName, summary: `Changed account holder from ${previous} to ${displayName}.` });
    return publicAccount(account);
  });
  res.json(updated);
}));

app.post('/api/account/change-passphrase', authenticate, asyncRoute(async (req, res) => {
  const input = z.object({ currentPassphrase: z.string().min(6).max(128), newPassphrase: z.string().min(10).max(128) }).parse(req.body);
  const result = await repository.mutate((db) => {
    const account = db.accounts.find((item) => item.id === req.account!.id)!;
    if (!verifyPassphrase(input.currentPassphrase, account.passphraseHash)) return null;
    account.passphraseHash = hashPassphrase(input.newPassphrase); account.firstLogin = false;
    addAudit(db, req.account!, { action: 'ACCOUNT_PASSPHRASE_CHANGED', objectType: 'ACCOUNT', objectId: account.id, objectLabel: account.organizationName, summary: 'Changed the account passphrase.' });
    return publicAccount(account);
  });
  if (!result) { res.status(401).json({ error: { code: 'CURRENT_PASSPHRASE_INCORRECT', message: 'The current passphrase is incorrect.' } }); return; }
  res.json(result);
}));

app.get('/api/account/organization-name-request', authenticate, asyncRoute(async (req, res) => {
  const db = await repository.read();
  res.json(db.organizationNameRequests.find((item) => item.accountId === req.account!.id && item.status === 'PENDING') ?? null);
}));

app.post('/api/account/organization-name-request', authenticate, asyncRoute(async (req, res) => {
  const input = z.object({ requestedName: z.string().trim().min(2).max(120), reason: z.string().trim().max(300).default('') }).parse(req.body);
  const result = await repository.mutate((db) => {
    const account = db.accounts.find((item) => item.id === req.account!.id)!;
    if (account.role === 'ADMIN') return { kind: 'forbidden' as const };
    if (input.requestedName.toLowerCase() === account.organizationName.toLowerCase()) return { kind: 'same' as const };
    if (db.organizationNameRequests.some((item) => item.accountId === account.id && item.status === 'PENDING')) return { kind: 'pending' as const };
    const request = { id: randomUUID(), accountId: account.id, currentName: account.organizationName, requestedName: input.requestedName, reason: input.reason, status: 'PENDING' as const, createdAt: new Date().toISOString() };
    db.organizationNameRequests.unshift(request);
    addAudit(db, req.account!, { action: 'ORGANIZATION_NAME_REQUESTED', objectType: 'ORGANIZATION_NAME_REQUEST', objectId: request.id, objectLabel: account.organizationName, summary: `Requested organization name change to ${request.requestedName}.`, reason: request.reason || undefined });
    return { kind: 'created' as const, request };
  });
  if (result.kind === 'forbidden') { res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Administrator organization names are not changed through this request flow.' } }); return; }
  if (result.kind === 'same') { res.status(422).json({ error: { code: 'NAME_UNCHANGED', message: 'Enter a different organization name.' } }); return; }
  if (result.kind === 'pending') { res.status(409).json({ error: { code: 'NAME_REQUEST_PENDING', message: 'A name change request is already awaiting review.' } }); return; }
  res.status(201).json(result.request);
}));

app.get('/api/admin/access-requests', authenticate, requireRole('ADMIN'), asyncRoute(async (_req, res) => {
  const db = await repository.read();
  res.json({ data: db.accessRequests, pagination: { page: 1, pageSize: db.accessRequests.length, totalItems: db.accessRequests.length, totalPages: 1 } });
}));

app.get('/api/admin/organization-name-requests', authenticate, requireRole('ADMIN'), asyncRoute(async (_req, res) => {
  const db = await repository.read();
  res.json({ data: db.organizationNameRequests });
}));

app.post('/api/admin/organization-name-requests/:id/approve', authenticate, requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const result = await repository.mutate((db) => {
    const request = db.organizationNameRequests.find((item) => item.id === req.params.id && item.status === 'PENDING');
    if (!request) return null;
    const account = db.accounts.find((item) => item.id === request.accountId);
    if (!account) return false;
    const previousName = account.organizationName; account.organizationName = request.requestedName;
    request.status = 'APPROVED'; request.reviewedAt = new Date().toISOString(); request.reviewedBy = req.account!.id;
    addAudit(db, req.account!, { action: 'ORGANIZATION_NAME_APPROVED', objectType: 'ORGANIZATION_NAME_REQUEST', objectId: request.id, objectLabel: request.requestedName, summary: `Changed organization name from ${previousName} to ${request.requestedName}.` });
    return { request, account: publicAccount(account) };
  });
  if (result === null) { res.status(409).json({ error: { code: 'NAME_REQUEST_NOT_PENDING', message: 'This name change request has already been reviewed.' } }); return; }
  if (result === false) { res.status(404).json({ error: { code: 'ACCOUNT_NOT_FOUND', message: 'The organization account no longer exists.' } }); return; }
  res.json(result);
}));

app.post('/api/admin/organization-name-requests/:id/reject', authenticate, requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const { reason } = z.object({ reason: z.string().trim().min(3).max(300) }).parse(req.body);
  const result = await repository.mutate((db) => {
    const request = db.organizationNameRequests.find((item) => item.id === req.params.id && item.status === 'PENDING');
    if (!request) return null;
    request.status = 'REJECTED'; request.rejectionReason = reason; request.reviewedAt = new Date().toISOString(); request.reviewedBy = req.account!.id;
    addAudit(db, req.account!, { action: 'ORGANIZATION_NAME_REJECTED', objectType: 'ORGANIZATION_NAME_REQUEST', objectId: request.id, objectLabel: request.currentName, summary: `Declined organization name change to ${request.requestedName}.`, reason });
    return request;
  });
  if (!result) { res.status(409).json({ error: { code: 'NAME_REQUEST_NOT_PENDING', message: 'This name change request has already been reviewed.' } }); return; }
  res.json(result);
}));

app.post('/api/admin/access-requests/:id/approve', authenticate, requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const credentials = await repository.mutate((db) => {
    const request = db.accessRequests.find((item) => item.id === req.params.id);
    if (!request || request.status !== 'PENDING') return null;
    const organizationType = db.organizationTypes.find((item) => item.id === request.organizationTypeId && item.role === request.role && item.active);
    if (!organizationType) return { invalidType: true as const };
    const accessCode = createAccessCode(request.role, db.accounts);
    const passphrase = createPassphrase();
    const account = { id: randomUUID(), role: request.role, accessCode, passphraseHash: hashPassphrase(passphrase), displayName: request.applicantName, organizationName: request.organizationName, contact: request.contact, organizationTypeId: organizationType.id, status: 'ACTIVE' as const, firstLogin: true, createdAt: new Date().toISOString() };
    db.accounts.push(account);
    request.status = 'APPROVED';
    request.reviewedAt = new Date().toISOString();
    request.reviewedBy = req.account!.id;
    addAudit(db, req.account!, { action: 'REQUEST_APPROVED', objectType: 'ACCESS_REQUEST', objectId: request.id, objectLabel: request.organizationName, summary: `Approved ${organizationType.name} access and created ${accessCode}.` });
    return { accessCode, passphrase };
  });
  if (!credentials) { res.status(409).json({ error: { code: 'REQUEST_NOT_PENDING', message: 'This request has already been reviewed.' } }); return; }
  if ('invalidType' in credentials) { res.status(409).json({ error: { code: 'ORGANIZATION_TYPE_INACTIVE', message: 'Reassign this request to an active organization type before approving it.' } }); return; }
  res.json(credentials);
}));

app.patch('/api/admin/access-requests/:id/type', authenticate, requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const { organizationTypeId } = z.object({ organizationTypeId: z.string().min(1) }).parse(req.body);
  const result = await repository.mutate((db) => {
    const request = db.accessRequests.find((item) => item.id === req.params.id && item.status === 'PENDING');
    if (!request) return null;
    const type = db.organizationTypes.find((item) => item.id === organizationTypeId && item.role === request.role && item.active);
    if (!type) return false;
    request.organizationTypeId = type.id; request.organizationTypeName = type.name;
    return request;
  });
  if (result === null) { res.status(404).json({ error: { code: 'REQUEST_NOT_FOUND', message: 'That pending request could not be found.' } }); return; }
  if (result === false) { res.status(422).json({ error: { code: 'INVALID_ORGANIZATION_TYPE', message: 'Choose an active type for this account role.' } }); return; }
  res.json(result);
}));

app.post('/api/admin/access-requests/:id/reject', authenticate, requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const { reason } = z.object({ reason: z.string().trim().min(3).max(300) }).parse(req.body);
  const request = await repository.mutate((db) => {
    const item = db.accessRequests.find((entry) => entry.id === req.params.id);
    if (!item || item.status !== 'PENDING') return null;
    item.status = 'REJECTED'; item.rejectionReason = reason; item.reviewedAt = new Date().toISOString(); item.reviewedBy = req.account!.id;
    addAudit(db, req.account!, { action: 'REQUEST_REJECTED', objectType: 'ACCESS_REQUEST', objectId: item.id, objectLabel: item.organizationName, summary: 'Rejected access request.', reason });
    return item;
  });
  if (!request) { res.status(409).json({ error: { code: 'REQUEST_NOT_PENDING', message: 'This request has already been reviewed.' } }); return; }
  res.json(request);
}));

const publicRoleSchema = z.enum(['FOOD_PROVIDER', 'FARMER_COLLECTOR', 'COMPOSTER']);
const accountInputSchema = z.object({
  role: publicRoleSchema,
  organizationTypeId: z.string().min(1),
  displayName: z.string().trim().min(2).max(80),
  organizationName: z.string().trim().min(2).max(120),
  contact: z.string().trim().min(5).max(120)
});

app.get('/api/admin/overview', authenticate, requireRole('ADMIN'), asyncRoute(async (_req, res) => {
  const db = await repository.read();
  const since = Date.now() - 30 * 86400000;
  res.json({
    pendingRequests: db.accessRequests.filter((item) => item.status === 'PENDING').length,
    pendingNameChanges: db.organizationNameRequests.filter((item) => item.status === 'PENDING').length,
    activeOrganizations: db.accounts.filter((item) => item.role !== 'ADMIN' && item.status === 'ACTIVE').length,
    pickupExceptions: db.pickups.filter((item) => item.status === 'CANCELLED' || item.status === 'EXPIRED').length,
    collectedKgLast30Days: db.pickups.filter((item) => item.status === 'COLLECTED' && new Date(item.updatedAt).getTime() >= since).reduce((total, item) => total + item.estimatedWeightKg, 0),
    recentActivity: db.auditEvents.slice(0, 5)
  });
}));

app.get('/api/admin/accounts', authenticate, requireRole('ADMIN'), asyncRoute(async (_req, res) => {
  const db = await repository.read();
  res.json({ data: db.accounts.filter((item) => item.role !== 'ADMIN').map(publicAccount) });
}));

app.post('/api/admin/accounts', authenticate, requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const input = accountInputSchema.parse(req.body);
  const result = await repository.mutate((db) => {
    const type = db.organizationTypes.find((item) => item.id === input.organizationTypeId && item.role === input.role && item.active);
    if (!type) return null;
    const accessCode = createAccessCode(input.role, db.accounts); const passphrase = createPassphrase();
    const stored = { id: randomUUID(), ...input, accessCode, passphraseHash: hashPassphrase(passphrase), status: 'ACTIVE' as const, firstLogin: true, createdAt: new Date().toISOString() };
    db.accounts.push(stored);
    addAudit(db, req.account!, { action: 'ACCOUNT_CREATED', objectType: 'ACCOUNT', objectId: stored.id, objectLabel: stored.organizationName, summary: `Created ${type.name} account ${accessCode}.` });
    return { account: publicAccount(stored), accessCode, passphrase };
  });
  if (!result) { res.status(422).json({ error: { code: 'INVALID_ORGANIZATION_TYPE', message: 'Choose an active organization type for this role.' } }); return; }
  res.status(201).json(result);
}));

app.patch('/api/admin/accounts/:id/type', authenticate, requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const { organizationTypeId } = z.object({ organizationTypeId: z.string().min(1) }).parse(req.body);
  const result = await repository.mutate((db) => {
    const account = db.accounts.find((item) => item.id === req.params.id && item.role !== 'ADMIN');
    if (!account) return { kind: 'missing' as const };
    const type = db.organizationTypes.find((item) => item.id === organizationTypeId && item.role === account.role && item.active);
    if (!type) return { kind: 'invalid' as const };
    account.organizationTypeId = type.id;
    addAudit(db, req.account!, { action: 'ACCOUNT_TYPE_CHANGED', objectType: 'ACCOUNT', objectId: account.id, objectLabel: account.organizationName, summary: `Changed organization type to ${type.name}.` });
    return { kind: 'updated' as const, account: publicAccount(account) };
  });
  if (result.kind === 'missing') { res.status(404).json({ error: { code: 'ACCOUNT_NOT_FOUND', message: 'That account could not be found.' } }); return; }
  if (result.kind === 'invalid') { res.status(422).json({ error: { code: 'INVALID_ORGANIZATION_TYPE', message: 'Choose an active type for this account role.' } }); return; }
  res.json(result.account);
}));

app.post('/api/admin/accounts/:id/status', authenticate, requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const { status, reason } = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']), reason: z.string().trim().min(3).max(300) }).parse(req.body);
  const account = await repository.mutate((db) => {
    const item = db.accounts.find((entry) => entry.id === req.params.id && entry.role !== 'ADMIN');
    if (!item) return null;
    item.status = status;
    addAudit(db, req.account!, { action: status === 'SUSPENDED' ? 'ACCOUNT_SUSPENDED' : 'ACCOUNT_REACTIVATED', objectType: 'ACCOUNT', objectId: item.id, objectLabel: item.organizationName, summary: status === 'SUSPENDED' ? 'Suspended account access.' : 'Restored account access.', reason });
    return publicAccount(item);
  });
  if (!account) { res.status(404).json({ error: { code: 'ACCOUNT_NOT_FOUND', message: 'That account could not be found.' } }); return; }
  if (status === 'SUSPENDED') for (const [token, session] of sessions) if (session.accountId === req.params.id) sessions.delete(token);
  res.json(account);
}));

app.post('/api/admin/accounts/:id/reset-passphrase', authenticate, requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const { reason } = z.object({ reason: z.string().trim().min(3).max(300) }).parse(req.body);
  const result = await repository.mutate((db) => {
    const item = db.accounts.find((entry) => entry.id === req.params.id && entry.role !== 'ADMIN');
    if (!item) return null;
    const passphrase = createPassphrase(); item.passphraseHash = hashPassphrase(passphrase); item.firstLogin = true;
    addAudit(db, req.account!, { action: 'ACCOUNT_PASSPHRASE_RESET', objectType: 'ACCOUNT', objectId: item.id, objectLabel: item.organizationName, summary: 'Issued a new one-time passphrase.', reason });
    return { accessCode: item.accessCode, passphrase };
  });
  if (!result) { res.status(404).json({ error: { code: 'ACCOUNT_NOT_FOUND', message: 'That account could not be found.' } }); return; }
  for (const [token, session] of sessions) if (session.accountId === req.params.id) sessions.delete(token);
  res.json(result);
}));

app.get('/api/admin/organization-types', authenticate, requireRole('ADMIN'), asyncRoute(async (_req, res) => {
  const db = await repository.read(); res.json({ data: db.organizationTypes.sort((a, b) => a.role.localeCompare(b.role) || a.sortOrder - b.sortOrder) });
}));

app.post('/api/admin/organization-types', authenticate, requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const input = z.object({ role: publicRoleSchema, name: z.string().trim().min(2).max(60) }).parse(req.body);
  const result = await repository.mutate((db) => {
    if (db.organizationTypes.some((item) => item.role === input.role && item.name.toLowerCase() === input.name.toLowerCase())) return null;
    const siblings = db.organizationTypes.filter((item) => item.role === input.role);
    const type = { id: randomUUID(), ...input, active: true, sortOrder: siblings.length ? Math.max(...siblings.map((item) => item.sortOrder)) + 1 : 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    db.organizationTypes.push(type);
    addAudit(db, req.account!, { action: 'ORGANIZATION_TYPE_CREATED', objectType: 'ORGANIZATION_TYPE', objectId: type.id, objectLabel: type.name, summary: `Added ${type.name} to public signup.` });
    return type;
  });
  if (!result) { res.status(409).json({ error: { code: 'TYPE_EXISTS', message: 'That organization type already exists for this role.' } }); return; }
  res.status(201).json(result);
}));

app.patch('/api/admin/organization-types/:id', authenticate, requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const input = z.object({ name: z.string().trim().min(2).max(60).optional(), active: z.boolean().optional(), sortOrder: z.number().int().min(0).optional() }).refine((value) => Object.keys(value).length > 0).parse(req.body);
  const result = await repository.mutate((db) => {
    const type = db.organizationTypes.find((item) => item.id === req.params.id); if (!type) return null;
    if (input.name && db.organizationTypes.some((item) => item.id !== type.id && item.role === type.role && item.name.toLowerCase() === input.name!.toLowerCase())) return false;
    const requestedOrder = input.sortOrder;
    Object.assign(type, { name: input.name ?? type.name, active: input.active ?? type.active, updatedAt: new Date().toISOString() });
    if (requestedOrder !== undefined) {
      const siblings = db.organizationTypes.filter((item) => item.role === type.role && item.id !== type.id).sort((a, b) => a.sortOrder - b.sortOrder);
      siblings.splice(Math.min(requestedOrder, siblings.length), 0, type);
      siblings.forEach((item, index) => { item.sortOrder = index; });
    }
    addAudit(db, req.account!, { action: input.active === false ? 'ORGANIZATION_TYPE_ARCHIVED' : 'ORGANIZATION_TYPE_UPDATED', objectType: 'ORGANIZATION_TYPE', objectId: type.id, objectLabel: type.name, summary: input.active === false ? 'Removed this option from new access requests.' : 'Updated signup option.' });
    return type;
  });
  if (result === null) { res.status(404).json({ error: { code: 'TYPE_NOT_FOUND', message: 'That organization type could not be found.' } }); return; }
  if (result === false) { res.status(409).json({ error: { code: 'TYPE_EXISTS', message: 'That organization type name is already in use.' } }); return; }
  res.json(result);
}));

app.delete('/api/admin/organization-types/:id', authenticate, requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const result = await repository.mutate((db) => {
    const type = db.organizationTypes.find((item) => item.id === req.params.id); if (!type) return { kind: 'missing' as const };
    const referenced = db.accounts.some((item) => item.organizationTypeId === type.id) || db.accessRequests.some((item) => item.organizationTypeId === type.id);
    if (referenced) { type.active = false; type.updatedAt = new Date().toISOString(); addAudit(db, req.account!, { action: 'ORGANIZATION_TYPE_ARCHIVED', objectType: 'ORGANIZATION_TYPE', objectId: type.id, objectLabel: type.name, summary: 'Archived referenced signup option.' }); return { kind: 'archived' as const, type }; }
    db.organizationTypes = db.organizationTypes.filter((item) => item.id !== type.id);
    addAudit(db, req.account!, { action: 'ORGANIZATION_TYPE_DELETED', objectType: 'ORGANIZATION_TYPE', objectId: type.id, objectLabel: type.name, summary: 'Deleted unused signup option.' });
    return { kind: 'deleted' as const };
  });
  if (result.kind === 'missing') { res.status(404).json({ error: { code: 'TYPE_NOT_FOUND', message: 'That organization type could not be found.' } }); return; }
  res.json(result);
}));

app.get('/api/admin/audit-events', authenticate, requireRole('ADMIN'), asyncRoute(async (_req, res) => {
  const db = await repository.read(); res.json({ data: db.auditEvents });
}));

app.get('/api/meals', authenticate, requireRole('FOOD_PROVIDER'), asyncRoute(async (req, res) => {
  const db = await repository.read();
  res.json({ data: db.meals.filter((meal) => meal.providerId === req.account!.id), pagination: { page: 1, pageSize: 100, totalItems: db.meals.length, totalPages: 1 } });
}));

app.post('/api/meals', authenticate, requireRole('FOOD_PROVIDER'), asyncRoute(async (req, res) => {
  const { name } = z.object({ name: z.string().trim().min(2).max(140) }).parse(req.body);
  const meal = await repository.mutate((db) => {
    if (db.meals.some((item) => item.providerId === req.account!.id && item.name.toLowerCase() === name.toLowerCase())) return null;
    const created = { id: randomUUID(), providerId: req.account!.id, name, createdAt: new Date().toISOString() };
    db.meals.push(created); return created;
  });
  if (!meal) { res.status(409).json({ error: { code: 'MEAL_EXISTS', message: 'That meal is already in your library.' } }); return; }
  res.status(201).json(meal);
}));

app.delete('/api/meals/:id', authenticate, requireRole('FOOD_PROVIDER'), asyncRoute(async (req, res) => {
  const removed = await repository.mutate((db) => {
    const before = db.meals.length;
    db.meals = db.meals.filter((meal) => meal.id !== req.params.id || meal.providerId !== req.account!.id);
    db.assignments.forEach((assignment) => { if (assignment.providerId === req.account!.id) assignment.mealIds = assignment.mealIds.filter((id) => id !== req.params.id); });
    return before !== db.meals.length;
  });
  if (!removed) { res.status(404).json({ error: { code: 'MEAL_NOT_FOUND', message: 'That meal could not be found.' } }); return; }
  res.status(204).end();
}));

app.get('/api/meal-assignments', authenticate, requireRole('FOOD_PROVIDER'), asyncRoute(async (req, res) => {
  const db = await repository.read();
  const data = db.assignments.filter((item) => item.providerId === req.account!.id);
  res.json({ data, pagination: { page: 1, pageSize: 100, totalItems: data.length, totalPages: 1 } });
}));

app.post('/api/meal-assignments', authenticate, requireRole('FOOD_PROVIDER'), asyncRoute(async (req, res) => {
  const input = z.object({ date: z.iso.date(), mealIds: z.array(z.string()).min(1), recurrence: z.object({ frequency: z.enum(['NONE', 'WEEKLY', 'BIWEEKLY']), endDate: z.iso.date().optional() }) }).parse(req.body);
  const assignments = await repository.mutate((db) => recurrenceDates(input.date, input.recurrence.frequency, input.recurrence.endDate).map((date) => {
    const existing = db.assignments.find((item) => item.providerId === req.account!.id && item.date === date);
    if (existing) { existing.mealIds = input.mealIds; existing.recurrence = input.recurrence; return existing; }
    const created: MealAssignment = { id: randomUUID(), providerId: req.account!.id, date, mealIds: input.mealIds, recurrence: input.recurrence, createdAt: new Date().toISOString() };
    db.assignments.push(created); return created;
  }));
  res.status(201).json({ data: assignments });
}));

app.post('/api/recommendations', authenticate, requireRole('FOOD_PROVIDER'), asyncRoute(async (req, res) => {
  const input = z.object({ expectedAttendance: z.number().int().min(1).max(5000), mealIds: z.array(z.string()).min(1) }).parse(req.body);
  const db = await repository.read();
  res.json(calculateRecommendation({ ...input, logs: db.logs.filter((log) => log.providerId === req.account!.id) }));
}));

app.get('/api/waste-logs', authenticate, requireRole('FOOD_PROVIDER'), asyncRoute(async (req, res) => {
  const db = await repository.read(); const data = db.logs.filter((log) => log.providerId === req.account!.id).sort((a, b) => b.date.localeCompare(a.date));
  res.json({ data, pagination: { page: 1, pageSize: 100, totalItems: data.length, totalPages: 1 } });
}));

app.post('/api/waste-logs', authenticate, requireRole('FOOD_PROVIDER'), asyncRoute(async (req, res) => {
  const input = z.object({ date: z.iso.date(), mealIds: z.array(z.string()).min(1), actualAttendance: z.number().int().min(1), servingsPrepared: z.number().int().min(1), leftoverKg: z.number().min(0).max(500), reason: z.enum(['LOW_ATTENDANCE', 'MENU_PREFERENCE', 'OVERPRODUCTION', 'PREPARATION_WASTE', 'OTHER']), suitableForCollection: z.boolean(), notes: z.string().trim().max(500) }).parse(req.body);
  const result = await repository.mutate((db) => {
    const log: DailyWasteLog = { id: randomUUID(), providerId: req.account!.id, ...input, createdAt: new Date().toISOString() };
    db.logs.push(log); return log;
  });
  res.status(201).json(result);
}));

const editableLogInput = z.object({ date: z.iso.date(), mealIds: z.array(z.string()).min(1), actualAttendance: z.number().int().min(1), servingsPrepared: z.number().int().min(1), leftoverKg: z.number().min(0).max(500), reason: z.enum(['LOW_ATTENDANCE', 'MENU_PREFERENCE', 'OVERPRODUCTION', 'PREPARATION_WASTE', 'OTHER']), suitableForCollection: z.boolean(), notes: z.string().trim().max(500) });
const lockedPickupStatuses: PickupStatus[] = ['RESERVED', 'IN_TRANSIT', 'AWAITING_PROVIDER_CONFIRMATION', 'COLLECTED'];

app.put('/api/waste-logs/:id', authenticate, requireRole('FOOD_PROVIDER'), asyncRoute(async (req, res) => {
  const input = editableLogInput.parse(req.body);
  const result = await repository.mutate((db) => {
    const log = db.logs.find((item) => item.id === req.params.id && item.providerId === req.account!.id);
    if (!log) return { kind: 'missing' as const };
    const pickup = log.pickupId ? db.pickups.find((item) => item.id === log.pickupId) : undefined;
    if (pickup && lockedPickupStatuses.includes(pickup.status)) return { kind: 'locked' as const };
    Object.assign(log, input);
    if (pickup && !input.suitableForCollection) { db.pickups = db.pickups.filter((item) => item.id !== pickup.id); delete log.pickupId; }
    else if (pickup) { pickup.estimatedWeightKg = input.leftoverKg; pickup.updatedAt = new Date().toISOString(); }
    return { kind: 'updated' as const, log };
  });
  if (result.kind === 'missing') { res.status(404).json({ error: { code: 'LOG_NOT_FOUND', message: 'This daily log no longer exists.' } }); return; }
  if (result.kind === 'locked') { res.status(409).json({ error: { code: 'LOG_LOCKED', message: 'This log cannot be edited after its pickup has been accepted.' } }); return; }
  res.json(result.log);
}));

app.delete('/api/waste-logs/:id', authenticate, requireRole('FOOD_PROVIDER'), asyncRoute(async (req, res) => {
  const result = await repository.mutate((db) => {
    const index = db.logs.findIndex((item) => item.id === req.params.id && item.providerId === req.account!.id);
    if (index < 0) return 'missing' as const;
    const log = db.logs[index];
    const pickup = log.pickupId ? db.pickups.find((item) => item.id === log.pickupId) : undefined;
    if (pickup && lockedPickupStatuses.includes(pickup.status)) return 'locked' as const;
    if (pickup) db.pickups = db.pickups.filter((item) => item.id !== pickup.id);
    db.logs.splice(index, 1);
    return 'deleted' as const;
  });
  if (result === 'missing') { res.status(404).json({ error: { code: 'LOG_NOT_FOUND', message: 'This daily log no longer exists.' } }); return; }
  if (result === 'locked') { res.status(409).json({ error: { code: 'LOG_LOCKED', message: 'This log cannot be deleted after its pickup has been accepted.' } }); return; }
  res.status(204).end();
}));

app.get('/api/insights', authenticate, requireRole('FOOD_PROVIDER'), asyncRoute(async (req, res) => {
  const db = await repository.read();
  res.json(calculateInsights(db.logs.filter((log) => log.providerId === req.account!.id), db.meals.filter((meal) => meal.providerId === req.account!.id)));
}));

app.get('/api/pickups', authenticate, requireRole('FOOD_PROVIDER', 'ADMIN'), asyncRoute(async (req, res) => {
  const db = await repository.read();
  const data = req.account!.role === 'ADMIN' ? db.pickups : db.pickups.filter((pickup) => pickup.providerId === req.account!.id);
  res.json({ data, pagination: { page: 1, pageSize: 100, totalItems: data.length, totalPages: 1 } });
}));

app.post('/api/waste-logs/:id/publish-pickup', authenticate, requireRole('FOOD_PROVIDER'), asyncRoute(async (req, res) => {
  const pickup = await repository.mutate((db) => {
    const log = db.logs.find((item) => item.id === req.params.id && item.providerId === req.account!.id);
    if (!log || !log.suitableForCollection || log.pickupId) return null;
    const now = new Date();
    const created = { id: randomUUID(), providerId: req.account!.id, wasteLogId: log.id, estimatedWeightKg: log.leftoverKg, destination: 'LIVESTOCK_OR_COMPOST' as const, status: 'AVAILABLE' as const, expiresAt: new Date(now.getTime() + 12 * 60 * 60 * 1000).toISOString(), createdAt: now.toISOString(), updatedAt: now.toISOString() };
    db.pickups.push(created); log.pickupId = created.id; return created;
  });
  if (!pickup) { res.status(409).json({ error: { code: 'PICKUP_NOT_AVAILABLE', message: 'This log cannot be published or already has a pickup.' } }); return; }
  res.status(201).json(pickup);
}));

app.post('/api/pickups/:id/confirm', authenticate, requireRole('FOOD_PROVIDER'), asyncRoute(async (req, res) => {
  const pickup = await repository.mutate((db) => {
    const item = db.pickups.find((entry) => entry.id === req.params.id && entry.providerId === req.account!.id);
    if (!item || item.status !== 'AWAITING_PROVIDER_CONFIRMATION') return null;
    item.status = 'COLLECTED'; item.updatedAt = new Date().toISOString(); return item;
  });
  if (!pickup) { res.status(409).json({ error: { code: 'PICKUP_NOT_CONFIRMABLE', message: 'This pickup is not awaiting provider confirmation.' } }); return; }
  res.json(pickup);
}));

app.post('/api/admin/pickups/:id/override', authenticate, requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const { action, reason } = z.object({ action: z.enum(['CANCEL', 'EXPIRE', 'REOPEN']), reason: z.string().trim().min(3).max(300) }).parse(req.body);
  const result = await repository.mutate((db) => {
    const pickup = db.pickups.find((entry) => entry.id === req.params.id); if (!pickup) return { kind: 'missing' as const };
    let next: PickupStatus; let auditAction: AdminAuditAction;
    if (action === 'CANCEL') {
      if (['COLLECTED', 'CANCELLED', 'EXPIRED'].includes(pickup.status)) return { kind: 'invalid' as const };
      next = 'CANCELLED'; auditAction = 'PICKUP_CANCELLED';
    } else if (action === 'EXPIRE') {
      if (pickup.status !== 'AVAILABLE') return { kind: 'invalid' as const };
      next = 'EXPIRED'; auditAction = 'PICKUP_EXPIRED';
    } else {
      if (!['CANCELLED', 'EXPIRED'].includes(pickup.status)) return { kind: 'invalid' as const };
      const log = db.logs.find((item) => item.id === pickup.wasteLogId);
      const replacement = db.pickups.some((item) => item.id !== pickup.id && item.wasteLogId === pickup.wasteLogId && !['CANCELLED', 'EXPIRED'].includes(item.status));
      if (!log?.suitableForCollection || replacement) return { kind: 'invalid' as const };
      next = 'AVAILABLE'; auditAction = 'PICKUP_REOPENED'; pickup.expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
    }
    pickup.status = next; pickup.updatedAt = new Date().toISOString();
    const provider = db.accounts.find((item) => item.id === pickup.providerId);
    addAudit(db, req.account!, { action: auditAction, objectType: 'PICKUP', objectId: pickup.id, objectLabel: provider?.organizationName ?? `${pickup.estimatedWeightKg} kg pickup`, summary: `${action === 'REOPEN' ? 'Reopened' : action === 'EXPIRE' ? 'Expired' : 'Cancelled'} ${pickup.estimatedWeightKg} kg pickup.`, reason });
    return { kind: 'updated' as const, pickup };
  });
  if (result.kind === 'missing') { res.status(404).json({ error: { code: 'PICKUP_NOT_FOUND', message: 'That pickup could not be found.' } }); return; }
  if (result.kind === 'invalid') { res.status(409).json({ error: { code: 'INVALID_PICKUP_OVERRIDE', message: 'That override is not available for the pickup’s current state.' } }); return; }
  res.json(result.pickup);
}));

app.use((error: unknown, req: AuthedRequest, res: Response, _next: NextFunction) => {
  console.error(JSON.stringify({ traceId: req.traceId, error }));
  if (error instanceof z.ZodError) {
    res.status(422).json({ error: { code: 'VALIDATION_FAILED', message: 'Check the highlighted information and try again.', details: error.issues } });
    return;
  }
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Bloom could not complete that request. Try again.' } });
});

if (process.env.NODE_ENV !== 'test') app.listen(port, () => console.log(`Bloom API listening at http://localhost:${port} (${process.env.DATA_DRIVER})`));

export { app, repository as repositoryInstance };
