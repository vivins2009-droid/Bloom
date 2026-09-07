import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Account, AccountRole, AccessRequest, DailyWasteLog, MealAssignment, PickupStatus } from '@bloom/contracts';
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
  if (!account) {
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

const requestSchema = z.object({
  applicantName: z.string().trim().min(2).max(80),
  role: z.enum(['SCHOOL', 'FARMER_COLLECTOR', 'COMPOSTER']),
  organizationName: z.string().trim().min(2).max(120),
  contact: z.string().trim().min(5).max(120),
  note: z.string().trim().max(500).default('')
});

app.get('/api/health', (_req, res) => res.json({ status: 'ok', driver: process.env.DATA_DRIVER }));

app.post('/api/access-requests', asyncRoute(async (req, res) => {
  const parsed = requestSchema.parse(req.body);
  const result = await repository.mutate((db) => {
    const duplicate = db.accessRequests.find((item) => item.contact.toLowerCase() === parsed.contact.toLowerCase() && item.status === 'PENDING');
    if (duplicate) return { duplicate };
    const request: AccessRequest = { id: randomUUID(), ...parsed, status: 'PENDING', createdAt: new Date().toISOString() };
    db.accessRequests.unshift(request);
    return { request };
  });
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

app.get('/api/admin/access-requests', authenticate, requireRole('ADMIN'), asyncRoute(async (_req, res) => {
  const db = await repository.read();
  res.json({ data: db.accessRequests, pagination: { page: 1, pageSize: db.accessRequests.length, totalItems: db.accessRequests.length, totalPages: 1 } });
}));

app.post('/api/admin/access-requests/:id/approve', authenticate, requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const credentials = await repository.mutate((db) => {
    const request = db.accessRequests.find((item) => item.id === req.params.id);
    if (!request || request.status !== 'PENDING') return null;
    const accessCode = createAccessCode(request.role, db.accounts);
    const passphrase = createPassphrase();
    db.accounts.push({ id: randomUUID(), role: request.role, accessCode, passphraseHash: hashPassphrase(passphrase), displayName: request.applicantName, organizationName: request.organizationName, firstLogin: true, createdAt: new Date().toISOString() });
    request.status = 'APPROVED';
    request.reviewedAt = new Date().toISOString();
    return { accessCode, passphrase };
  });
  if (!credentials) { res.status(409).json({ error: { code: 'REQUEST_NOT_PENDING', message: 'This request has already been reviewed.' } }); return; }
  res.json(credentials);
}));

app.post('/api/admin/access-requests/:id/reject', authenticate, requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const { reason } = z.object({ reason: z.string().trim().max(300).default('') }).parse(req.body);
  const request = await repository.mutate((db) => {
    const item = db.accessRequests.find((entry) => entry.id === req.params.id);
    if (!item || item.status !== 'PENDING') return null;
    item.status = 'REJECTED'; item.rejectionReason = reason; item.reviewedAt = new Date().toISOString();
    return item;
  });
  if (!request) { res.status(409).json({ error: { code: 'REQUEST_NOT_PENDING', message: 'This request has already been reviewed.' } }); return; }
  res.json(request);
}));

app.get('/api/meals', authenticate, requireRole('SCHOOL'), asyncRoute(async (req, res) => {
  const db = await repository.read();
  res.json({ data: db.meals.filter((meal) => meal.schoolId === req.account!.id), pagination: { page: 1, pageSize: 100, totalItems: db.meals.length, totalPages: 1 } });
}));

app.post('/api/meals', authenticate, requireRole('SCHOOL'), asyncRoute(async (req, res) => {
  const { name } = z.object({ name: z.string().trim().min(2).max(140) }).parse(req.body);
  const meal = await repository.mutate((db) => {
    if (db.meals.some((item) => item.schoolId === req.account!.id && item.name.toLowerCase() === name.toLowerCase())) return null;
    const created = { id: randomUUID(), schoolId: req.account!.id, name, createdAt: new Date().toISOString() };
    db.meals.push(created); return created;
  });
  if (!meal) { res.status(409).json({ error: { code: 'MEAL_EXISTS', message: 'That meal is already in your library.' } }); return; }
  res.status(201).json(meal);
}));

app.delete('/api/meals/:id', authenticate, requireRole('SCHOOL'), asyncRoute(async (req, res) => {
  const removed = await repository.mutate((db) => {
    const before = db.meals.length;
    db.meals = db.meals.filter((meal) => meal.id !== req.params.id || meal.schoolId !== req.account!.id);
    db.assignments.forEach((assignment) => { if (assignment.schoolId === req.account!.id) assignment.mealIds = assignment.mealIds.filter((id) => id !== req.params.id); });
    return before !== db.meals.length;
  });
  if (!removed) { res.status(404).json({ error: { code: 'MEAL_NOT_FOUND', message: 'That meal could not be found.' } }); return; }
  res.status(204).end();
}));

app.get('/api/meal-assignments', authenticate, requireRole('SCHOOL'), asyncRoute(async (req, res) => {
  const db = await repository.read();
  const data = db.assignments.filter((item) => item.schoolId === req.account!.id);
  res.json({ data, pagination: { page: 1, pageSize: 100, totalItems: data.length, totalPages: 1 } });
}));

app.post('/api/meal-assignments', authenticate, requireRole('SCHOOL'), asyncRoute(async (req, res) => {
  const input = z.object({ date: z.iso.date(), mealIds: z.array(z.string()).min(1), recurrence: z.object({ frequency: z.enum(['NONE', 'WEEKLY', 'BIWEEKLY']), endDate: z.iso.date().optional() }) }).parse(req.body);
  const assignments = await repository.mutate((db) => recurrenceDates(input.date, input.recurrence.frequency, input.recurrence.endDate).map((date) => {
    const existing = db.assignments.find((item) => item.schoolId === req.account!.id && item.date === date);
    if (existing) { existing.mealIds = input.mealIds; existing.recurrence = input.recurrence; return existing; }
    const created: MealAssignment = { id: randomUUID(), schoolId: req.account!.id, date, mealIds: input.mealIds, recurrence: input.recurrence, createdAt: new Date().toISOString() };
    db.assignments.push(created); return created;
  }));
  res.status(201).json({ data: assignments });
}));

app.post('/api/recommendations', authenticate, requireRole('SCHOOL'), asyncRoute(async (req, res) => {
  const input = z.object({ expectedAttendance: z.number().int().min(1).max(5000), mealIds: z.array(z.string()).min(1) }).parse(req.body);
  const db = await repository.read();
  res.json(calculateRecommendation({ ...input, logs: db.logs.filter((log) => log.schoolId === req.account!.id) }));
}));

app.get('/api/waste-logs', authenticate, requireRole('SCHOOL'), asyncRoute(async (req, res) => {
  const db = await repository.read(); const data = db.logs.filter((log) => log.schoolId === req.account!.id).sort((a, b) => b.date.localeCompare(a.date));
  res.json({ data, pagination: { page: 1, pageSize: 100, totalItems: data.length, totalPages: 1 } });
}));

app.post('/api/waste-logs', authenticate, requireRole('SCHOOL'), asyncRoute(async (req, res) => {
  const input = z.object({ date: z.iso.date(), mealIds: z.array(z.string()).min(1), actualAttendance: z.number().int().min(1), servingsPrepared: z.number().int().min(1), leftoverKg: z.number().min(0).max(500), reason: z.enum(['LOW_ATTENDANCE', 'MENU_PREFERENCE', 'OVERPRODUCTION', 'PREPARATION_WASTE', 'OTHER']), suitableForCollection: z.boolean(), notes: z.string().trim().max(500) }).parse(req.body);
  const result = await repository.mutate((db) => {
    if (db.logs.some((log) => log.schoolId === req.account!.id && log.date === input.date)) return null;
    const log: DailyWasteLog = { id: randomUUID(), schoolId: req.account!.id, ...input, createdAt: new Date().toISOString() };
    db.logs.push(log); return log;
  });
  if (!result) { res.status(409).json({ error: { code: 'LOG_EXISTS', message: 'A daily log already exists for this date.' } }); return; }
  res.status(201).json(result);
}));

const editableLogInput = z.object({ date: z.iso.date(), mealIds: z.array(z.string()).min(1), actualAttendance: z.number().int().min(1), servingsPrepared: z.number().int().min(1), leftoverKg: z.number().min(0).max(500), reason: z.enum(['LOW_ATTENDANCE', 'MENU_PREFERENCE', 'OVERPRODUCTION', 'PREPARATION_WASTE', 'OTHER']), suitableForCollection: z.boolean(), notes: z.string().trim().max(500) });
const lockedPickupStatuses: PickupStatus[] = ['RESERVED', 'IN_TRANSIT', 'AWAITING_SCHOOL_CONFIRMATION', 'COLLECTED'];

app.put('/api/waste-logs/:id', authenticate, requireRole('SCHOOL'), asyncRoute(async (req, res) => {
  const input = editableLogInput.parse(req.body);
  const result = await repository.mutate((db) => {
    const log = db.logs.find((item) => item.id === req.params.id && item.schoolId === req.account!.id);
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

app.delete('/api/waste-logs/:id', authenticate, requireRole('SCHOOL'), asyncRoute(async (req, res) => {
  const result = await repository.mutate((db) => {
    const index = db.logs.findIndex((item) => item.id === req.params.id && item.schoolId === req.account!.id);
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

app.get('/api/insights', authenticate, requireRole('SCHOOL'), asyncRoute(async (req, res) => {
  const db = await repository.read();
  res.json(calculateInsights(db.logs.filter((log) => log.schoolId === req.account!.id), db.meals.filter((meal) => meal.schoolId === req.account!.id)));
}));

app.get('/api/pickups', authenticate, requireRole('SCHOOL', 'ADMIN'), asyncRoute(async (req, res) => {
  const db = await repository.read();
  const data = req.account!.role === 'ADMIN' ? db.pickups : db.pickups.filter((pickup) => pickup.schoolId === req.account!.id);
  res.json({ data, pagination: { page: 1, pageSize: 100, totalItems: data.length, totalPages: 1 } });
}));

app.post('/api/waste-logs/:id/publish-pickup', authenticate, requireRole('SCHOOL'), asyncRoute(async (req, res) => {
  const pickup = await repository.mutate((db) => {
    const log = db.logs.find((item) => item.id === req.params.id && item.schoolId === req.account!.id);
    if (!log || !log.suitableForCollection || log.pickupId) return null;
    const now = new Date();
    const created = { id: randomUUID(), schoolId: req.account!.id, wasteLogId: log.id, estimatedWeightKg: log.leftoverKg, destination: 'LIVESTOCK_OR_COMPOST' as const, status: 'AVAILABLE' as const, expiresAt: new Date(now.getTime() + 12 * 60 * 60 * 1000).toISOString(), createdAt: now.toISOString(), updatedAt: now.toISOString() };
    db.pickups.push(created); log.pickupId = created.id; return created;
  });
  if (!pickup) { res.status(409).json({ error: { code: 'PICKUP_NOT_AVAILABLE', message: 'This log cannot be published or already has a pickup.' } }); return; }
  res.status(201).json(pickup);
}));

app.post('/api/pickups/:id/confirm', authenticate, requireRole('SCHOOL'), asyncRoute(async (req, res) => {
  const pickup = await repository.mutate((db) => {
    const item = db.pickups.find((entry) => entry.id === req.params.id && entry.schoolId === req.account!.id);
    if (!item || item.status !== 'AWAITING_SCHOOL_CONFIRMATION') return null;
    item.status = 'COLLECTED'; item.updatedAt = new Date().toISOString(); return item;
  });
  if (!pickup) { res.status(409).json({ error: { code: 'PICKUP_NOT_CONFIRMABLE', message: 'This pickup is not awaiting school confirmation.' } }); return; }
  res.json(pickup);
}));

app.patch('/api/admin/pickups/:id/status', authenticate, requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const { status } = z.object({ status: z.enum(['AVAILABLE', 'RESERVED', 'IN_TRANSIT', 'AWAITING_SCHOOL_CONFIRMATION', 'CANCELLED', 'EXPIRED']) }).parse(req.body) as { status: PickupStatus };
  const pickup = await repository.mutate((db) => { const item = db.pickups.find((entry) => entry.id === req.params.id); if (!item) return null; item.status = status; item.updatedAt = new Date().toISOString(); return item; });
  if (!pickup) { res.status(404).json({ error: { code: 'PICKUP_NOT_FOUND', message: 'That pickup could not be found.' } }); return; }
  res.json(pickup);
}));

app.use((error: unknown, req: AuthedRequest, res: Response, _next: NextFunction) => {
  console.error(JSON.stringify({ traceId: req.traceId, error }));
  if (error instanceof z.ZodError) {
    res.status(422).json({ error: { code: 'VALIDATION_FAILED', message: 'Check the highlighted information and try again.', details: error.issues } });
    return;
  }
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Bloom could not complete that request. Try again.' } });
});

app.listen(port, () => console.log(`Bloom API listening at http://localhost:${port} (${process.env.DATA_DRIVER})`));

export { app, repository as repositoryInstance };
