import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { z } from 'zod';
import type { Account, AccountRole, AccessRequest, AdminAuditAction, ChatConversation, ChatMessage, DailyWasteLog, MealAssignment, Pickup, PickupStatus, PublicAccountRole, RecoveryRole } from '@bloom/contracts';
import { ACTIVE_PICKUP_STATUSES, calculateInsights, calculateRecommendation, reconcilePickups, recurrenceDates, roleCanRecoverPickup } from './domain.js';
import { createAccessCode, createPassphrase, createRepository, hashPassphrase, verifyPassphrase, type Repository } from './repository.js';
import { getAttachment, putAttachment, validateImage } from './storage.js';
import { processEmailQueue } from './email.js';
import { cleanExpiredChatContent } from './retention.js';

const app = express();
const port = Number(process.env.PORT || 5002);
const allowedOrigins = (process.env.WEB_ORIGINS || process.env.WEB_ORIGIN || 'http://localhost:5175').split(',').map((value) => value.trim()).filter(Boolean);
const repository = await createRepository();
const SESSION_MS = 12 * 60 * 60 * 1000;
const tokenHash = (value: string) => createHash('sha256').update(value).digest('hex');
const makeToken = () => randomBytes(32).toString('base64url');
const rateBuckets = new Map<string, { count: number; resetsAt: number }>();
const rateLimit = (name: string, max: number, windowMs: number) => (req: AuthedRequest, res: Response, next: NextFunction) => {
  const now = Date.now(); const keys = [`${name}:ip:${req.ip}`, ...(req.account ? [`${name}:account:${req.account.id}`] : [])]; let blockedUntil = 0;
  for (const key of keys) { const current = rateBuckets.get(key); const bucket = !current || current.resetsAt <= now ? { count: 0, resetsAt: now + windowMs } : current; bucket.count += 1; rateBuckets.set(key, bucket); if (bucket.count > max) blockedUntil = Math.max(blockedUntil, bucket.resetsAt); }
  if (blockedUntil) { res.setHeader('Retry-After', String(Math.ceil((blockedUntil - now) / 1000))); res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many attempts. Wait a moment and try again.' } }); return; }
  next();
};
const realtimeClients = new Map<string, Set<Duplex>>();
const websocketFrame = (text: string) => {
  const body = Buffer.from(text); const header = body.length < 126 ? Buffer.from([0x81, body.length]) : Buffer.from([0x81, 126, body.length >> 8, body.length & 255]); return Buffer.concat([header, body]);
};
const broadcast = (accountIds: string[], event: object) => {
  const frame = websocketFrame(JSON.stringify(event));
  new Set(accountIds).forEach((accountId) => realtimeClients.get(accountId)?.forEach((socket) => { if (!socket.destroyed) socket.write(frame); }));
};

app.use(cors({ origin: (requestOrigin, callback) => callback(null, !requestOrigin || allowedOrigins.includes(requestOrigin)), credentials: true, exposedHeaders: ['x-csrf-token', 'x-trace-id'] }));
app.use(express.json({ limit: '24mb' }));
app.use(cookieParser());
app.use((req, res, next) => { const requestOrigin = req.headers.origin; if (process.env.NODE_ENV === 'production' && requestOrigin && !allowedOrigins.includes(requestOrigin)) { res.status(403).json({ error: { code: 'ORIGIN_REJECTED', message: 'This request origin is not allowed.' } }); return; } next(); });

type AuthedRequest = Request & { account?: Account; traceId?: string; sessionTokenHash?: string };
app.use((req: AuthedRequest, res, next) => {
  req.traceId = randomUUID();
  res.setHeader('x-trace-id', req.traceId);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
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
  const hash = token ? tokenHash(token) : '';
  const db = await repository.read();
  const session = db.sessions.find((item) => item.tokenHash === hash && !item.revokedAt);
  if (!session || new Date(session.expiresAt).getTime() < Date.now()) {
    if (session) await repository.mutate((state) => { const current = state.sessions.find((item) => item.tokenHash === hash); if (current) current.revokedAt = new Date().toISOString(); });
    res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' } });
    return;
  }
  const account = db.accounts.find((item) => item.id === session.accountId);
  if (!account || account.status === 'SUSPENDED') {
    await repository.mutate((state) => { const current = state.sessions.find((item) => item.tokenHash === hash); if (current) current.revokedAt = new Date().toISOString(); });
    res.status(401).json({ error: { code: 'SESSION_INVALID', message: 'Your session is no longer valid. Sign in again.' } });
    return;
  }
  if (process.env.NODE_ENV === 'production' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && tokenHash(String(req.headers['x-csrf-token'] ?? '')) !== session.csrfHash) {
    res.status(403).json({ error: { code: 'CSRF_INVALID', message: 'Refresh the page and try again.' } });
    return;
  }
  req.sessionTokenHash = hash;
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

const addAudit = (db: Awaited<ReturnType<Repository['read']>>, actor: Account, input: { action: AdminAuditAction; objectType: 'ACCESS_REQUEST' | 'ACCOUNT' | 'ORGANIZATION_TYPE' | 'ORGANIZATION_NAME_REQUEST' | 'PICKUP' | 'CHAT_CONVERSATION' | 'CHAT_MESSAGE'; objectId: string; objectLabel: string; summary: string; reason?: string }) => {
  db.auditEvents.unshift({ id: randomUUID(), actorId: actor.id, actorName: actor.displayName, createdAt: new Date().toISOString(), ...input });
};

const conversationAccess = (conversation: ChatConversation, account: Account) => account.role === 'ADMIN' || conversation.participantAccountIds.includes(account.id);
const conversationIsReadOnly = (conversation: ChatConversation) => Boolean(conversation.terminalAt && Date.now() - new Date(conversation.terminalAt).getTime() >= 7 * 86400000);
const closePickupConversation = (db: Awaited<ReturnType<Repository['read']>>, pickupId: string, at: string) => {
  for (const conversation of db.chatConversations.filter((item) => item.pickupId === pickupId && !item.terminalAt)) {
    conversation.terminalAt = at;
    conversation.updatedAt = at;
  }
};
const decorateConversation = (db: Awaited<ReturnType<Repository['read']>>, conversation: ChatConversation, account: Account): ChatConversation => {
  const messages = db.chatMessages.filter((message) => message.conversationId === conversation.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const participant = db.chatParticipants.find((item) => item.conversationId === conversation.id && item.accountId === account.id);
  const unreadCount = account.role === 'ADMIN' && !participant
    ? messages.filter((message) => message.kind === 'MESSAGE').length
    : messages.filter((message) => message.kind === 'MESSAGE' && message.senderAccountId !== account.id && (!participant?.lastReadAt || message.createdAt > participant.lastReadAt)).length;
  return { ...conversation, state: conversationIsReadOnly(conversation) ? 'READ_ONLY' : 'OPEN', lastMessage: messages.at(-1), unreadCount };
};
const attachmentSigningSecret = () => process.env.ATTACHMENT_SIGNING_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'local-bloom-attachment-secret');
const signAttachmentAccess = (attachmentId: string, expires: number) => createHmac('sha256', attachmentSigningSecret()).update(`${attachmentId}:${expires}`).digest('base64url');
const queueAccountLink = (db: Awaited<ReturnType<Repository['read']>>, account: Account, purpose: 'SETUP' | 'RESET' | 'VERIFY_EMAIL', minutes: number) => {
  const token = makeToken(); const createdAt = new Date().toISOString(); const path = purpose === 'RESET' ? 'reset-passphrase' : 'setup-account'; const email = account.email || (account.contact.includes('@') ? account.contact : '');
  db.accountTokens.push({ id: randomUUID(), accountId: account.id, purpose, tokenHash: tokenHash(token), createdAt, expiresAt: new Date(Date.now() + minutes * 60000).toISOString() });
  if (email) db.emailJobs.push({ id: randomUUID(), to: email, subject: purpose === 'RESET' ? 'Reset your Bloom passphrase' : 'Set up your Bloom account', text: `${purpose === 'RESET' ? 'Reset' : 'Set up'} your Bloom account using this single-use link: ${allowedOrigins[0]}/${path}?token=${encodeURIComponent(token)}\n\nThis link expires ${purpose === 'RESET' ? 'in 30 minutes' : 'in 24 hours'}.`, attempts: 0, nextAttemptAt: createdAt, createdAt });
  return { token, email };
};
const rotateSession = async (accountId: string, res: Response) => {
  const token = makeToken(); const csrf = makeToken(); const now = new Date();
  await repository.mutate((db) => { db.sessions.forEach((session) => { if (session.accountId === accountId) session.revokedAt = now.toISOString(); }); db.sessions.push({ tokenHash: tokenHash(token), csrfHash: tokenHash(csrf), accountId, createdAt: now.toISOString(), lastActivityAt: now.toISOString(), expiresAt: new Date(now.getTime() + SESSION_MS).toISOString() }); });
  res.cookie('bloom_session', token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: SESSION_MS }); res.setHeader('x-csrf-token', csrf);
};

const requestSchema = z.object({
  applicantName: z.string().trim().min(2).max(80),
  role: z.enum(['FOOD_PROVIDER', 'FARMER_COLLECTOR', 'COMPOSTER']),
  organizationTypeId: z.string().trim().min(1),
  organizationName: z.string().trim().min(2).max(120),
  contact: z.string().trim().email().max(120),
  note: z.string().trim().max(500).default('')
});

app.get('/api/health', asyncRoute(async (_req, res) => {
  await repository.read();
  const chatEnabled = process.env.NODE_ENV !== 'production' || process.env.CHAT_ENABLED === 'true';
  const services = { database: process.env.DATA_DRIVER === 'postgres' ? 'postgres' : 'file', chat: chatEnabled, attachments: process.env.ATTACHMENT_DRIVER || 'file', email: Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM) };
  const ready = process.env.NODE_ENV !== 'production' || (!chatEnabled || (services.attachments === 'r2' && services.email && Boolean(process.env.ATTACHMENT_SIGNING_SECRET)));
  res.status(ready ? 200 : 503).json({ status: ready ? 'ok' : 'configuration_required', services });
}));

app.get('/api/organization-types', asyncRoute(async (_req, res) => {
  const db = await repository.read();
  const data = db.organizationTypes.filter((item) => item.active).sort((a, b) => a.role.localeCompare(b.role) || a.sortOrder - b.sortOrder);
  res.json({ data });
}));

app.post('/api/access-requests', rateLimit('access-request', 8, 3600000), asyncRoute(async (req, res) => {
  const parsed = requestSchema.parse(req.body);
  const result = await repository.mutate((db) => {
    const organizationType = db.organizationTypes.find((item) => item.id === parsed.organizationTypeId && item.role === parsed.role && item.active);
    if (!organizationType) return { invalidType: true as const };
    const duplicate = db.accessRequests.find((item) => item.contact.toLowerCase() === parsed.contact.toLowerCase() && item.status === 'PENDING');
    if (duplicate) return { duplicate };
    const request: AccessRequest = { id: randomUUID(), ...parsed, email: parsed.contact, organizationTypeName: organizationType.name, status: 'PENDING', createdAt: new Date().toISOString() };
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

app.post('/api/auth/login', rateLimit('login', 12, 15 * 60000), asyncRoute(async (req, res) => {
  const input = z.object({ accessCode: z.string().trim().min(3), passphrase: z.string().min(6) }).parse(req.body);
  const db = await repository.read();
  const stored = db.accounts.find((account) => account.accessCode.toUpperCase() === input.accessCode.toUpperCase());
  if (!stored || !verifyPassphrase(input.passphrase, stored.passphraseHash)) {
    res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'The access code or passphrase is incorrect.' } });
    return;
  }
  if (stored.status === 'SUSPENDED') { res.status(403).json({ error: { code: 'ACCOUNT_SUSPENDED', message: 'This account is suspended. Contact the administrator.' } }); return; }
  if (!stored.passphraseHash.startsWith('scrypt-v1:')) await repository.mutate((state) => { const account = state.accounts.find((item) => item.id === stored.id); if (account) account.passphraseHash = hashPassphrase(input.passphrase); });
  const token = makeToken(); const csrf = makeToken(); const now = new Date();
  await repository.mutate((state) => state.sessions.push({ tokenHash: tokenHash(token), csrfHash: tokenHash(csrf), accountId: stored.id, createdAt: now.toISOString(), lastActivityAt: now.toISOString(), expiresAt: new Date(now.getTime() + SESSION_MS).toISOString() }));
  res.cookie('bloom_session', token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: SESSION_MS });
  res.setHeader('x-csrf-token', csrf);
  res.json(publicAccount(stored));
}));

app.post('/api/auth/request-password-reset', rateLimit('password-reset', 6, 3600000), asyncRoute(async (req, res) => {
  const { email } = z.object({ email: z.string().trim().email().max(120) }).parse(req.body);
  await repository.mutate((db) => { const account = db.accounts.find((item) => (item.email || item.contact).toLowerCase() === email.toLowerCase() && item.status === 'ACTIVE'); if (account) queueAccountLink(db, publicAccount(account), 'RESET', 30); });
  res.status(202).json({ message: 'If that email belongs to an active Bloom account, a reset link has been queued.' });
}));

app.post('/api/auth/complete-account-link', asyncRoute(async (req, res) => {
  const input = z.object({ token: z.string().min(20), passphrase: z.string().min(10).max(128), purpose: z.enum(['SETUP', 'RESET']) }).parse(req.body);
  const completed = await repository.mutate((db) => {
    const token = db.accountTokens.find((item) => item.tokenHash === tokenHash(input.token) && item.purpose === input.purpose && !item.usedAt && new Date(item.expiresAt).getTime() > Date.now()); if (!token) return false;
    const account = db.accounts.find((item) => item.id === token.accountId && item.status === 'ACTIVE'); if (!account) return false;
    const now = new Date().toISOString(); account.passphraseHash = hashPassphrase(input.passphrase); account.firstLogin = false; account.emailVerifiedAt = account.emailVerifiedAt ?? now; token.usedAt = now;
    db.sessions.forEach((session) => { if (session.accountId === account.id) session.revokedAt = now; }); return true;
  });
  if (!completed) { res.status(410).json({ error: { code: 'ACCOUNT_LINK_INVALID', message: 'This link is invalid, expired, or has already been used.' } }); return; }
  res.json({ message: 'Your passphrase is ready. You can now sign in with your access code.' });
}));

app.get('/api/auth/me', authenticate, asyncRoute(async (req, res) => {
  const csrf = makeToken();
  await repository.mutate((state) => { const session = state.sessions.find((item) => item.tokenHash === req.sessionTokenHash); if (session) { session.csrfHash = tokenHash(csrf); session.lastActivityAt = new Date().toISOString(); } });
  res.setHeader('x-csrf-token', csrf); res.json(req.account);
}));
app.post('/api/auth/logout', authenticate, asyncRoute(async (req, res) => {
  await repository.mutate((state) => { const session = state.sessions.find((item) => item.tokenHash === req.sessionTokenHash); if (session) session.revokedAt = new Date().toISOString(); });
  res.clearCookie('bloom_session');
  res.json({ success: true });
}));

app.post('/api/auth/change-passphrase', authenticate, asyncRoute(async (req, res) => {
  const input = z.object({ passphrase: z.string().min(10).max(128) }).parse(req.body);
  const updated = await repository.mutate((db) => {
    const account = db.accounts.find((item) => item.id === req.account!.id)!;
    account.passphraseHash = hashPassphrase(input.passphrase);
    account.firstLogin = false;
    db.sessions.forEach((session) => { if (session.accountId === account.id && session.tokenHash !== req.sessionTokenHash) session.revokedAt = new Date().toISOString(); });
    return publicAccount(account);
  });
  await rotateSession(updated.id, res);
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

app.patch('/api/account/collection-profile', authenticate, requireRole('FOOD_PROVIDER'), asyncRoute(async (req, res) => {
  const input = z.object({
    locality: z.string().trim().min(2).max(100),
    collectionAddress: z.string().trim().min(8).max(240),
    collectionInstructions: z.string().trim().max(400).default('')
  }).parse(req.body);
  const updated = await repository.mutate((db) => {
    const account = db.accounts.find((item) => item.id === req.account!.id)!;
    Object.assign(account, input);
    db.pickups.filter((pickup) => pickup.providerId === account.id && pickup.status === 'AVAILABLE' && !pickup.collectionAddress).forEach((pickup) => {
      pickup.locality = input.locality; pickup.collectionAddress = input.collectionAddress; pickup.collectionInstructions = input.collectionInstructions; pickup.updatedAt = new Date().toISOString();
    });
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
    db.sessions.forEach((session) => { if (session.accountId === account.id && session.tokenHash !== req.sessionTokenHash) session.revokedAt = new Date().toISOString(); });
    addAudit(db, req.account!, { action: 'ACCOUNT_PASSPHRASE_CHANGED', objectType: 'ACCOUNT', objectId: account.id, objectLabel: account.organizationName, summary: 'Changed the account passphrase.' });
    return publicAccount(account);
  });
  if (!result) { res.status(401).json({ error: { code: 'CURRENT_PASSPHRASE_INCORRECT', message: 'The current passphrase is incorrect.' } }); return; }
  await rotateSession(result.id, res);
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
    const account = { id: randomUUID(), role: request.role, accessCode, passphraseHash: hashPassphrase(passphrase), displayName: request.applicantName, organizationName: request.organizationName, contact: request.contact, email: request.email || request.contact, organizationTypeId: organizationType.id, status: 'ACTIVE' as const, firstLogin: true, createdAt: new Date().toISOString() };
    db.accounts.push(account);
    request.status = 'APPROVED';
    request.reviewedAt = new Date().toISOString();
    request.reviewedBy = req.account!.id;
    addAudit(db, req.account!, { action: 'REQUEST_APPROVED', objectType: 'ACCESS_REQUEST', objectId: request.id, objectLabel: request.organizationName, summary: `Approved ${organizationType.name} access and created ${accessCode}.` });
    if (process.env.NODE_ENV === 'production') { const setup = queueAccountLink(db, publicAccount(account), 'SETUP', 24 * 60); return { accessCode, setupEmail: setup.email }; }
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
  contact: z.string().trim().email().max(120)
});

app.get('/api/admin/overview', authenticate, requireRole('ADMIN'), asyncRoute(async (_req, res) => {
  const db = await repository.read();
  const since = Date.now() - 30 * 86400000;
  res.json({
    pendingRequests: db.accessRequests.filter((item) => item.status === 'PENDING').length,
    pendingNameChanges: db.organizationNameRequests.filter((item) => item.status === 'PENDING').length,
    activeOrganizations: db.accounts.filter((item) => item.role !== 'ADMIN' && item.status === 'ACTIVE').length,
    pickupExceptions: db.pickups.filter((item) => item.status === 'CANCELLED' || item.status === 'EXPIRED' || (item.status === 'IN_TRANSIT' && new Date(item.pickupDeadline).getTime() < Date.now())).length,
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
    const stored = { id: randomUUID(), ...input, email: input.contact, accessCode, passphraseHash: hashPassphrase(passphrase), status: 'ACTIVE' as const, firstLogin: true, createdAt: new Date().toISOString() };
    db.accounts.push(stored);
    addAudit(db, req.account!, { action: 'ACCOUNT_CREATED', objectType: 'ACCOUNT', objectId: stored.id, objectLabel: stored.organizationName, summary: `Created ${type.name} account ${accessCode}.` });
    if (process.env.NODE_ENV === 'production') { const setup = queueAccountLink(db, publicAccount(stored), 'SETUP', 24 * 60); return { account: publicAccount(stored), accessCode, setupEmail: setup.email }; }
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
  if (status === 'SUSPENDED') { await repository.mutate((db) => db.sessions.forEach((session) => { if (session.accountId === req.params.id) session.revokedAt = new Date().toISOString(); })); broadcast([String(req.params.id)], { type: 'session.revoked' }); }
  res.json(account);
}));

app.post('/api/admin/accounts/:id/reset-passphrase', authenticate, requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const { reason } = z.object({ reason: z.string().trim().min(3).max(300) }).parse(req.body);
  const result = await repository.mutate((db) => {
    const item = db.accounts.find((entry) => entry.id === req.params.id && entry.role !== 'ADMIN');
    if (!item) return null;
    const passphrase = createPassphrase(); item.passphraseHash = hashPassphrase(passphrase); item.firstLogin = true;
    addAudit(db, req.account!, { action: 'ACCOUNT_PASSPHRASE_RESET', objectType: 'ACCOUNT', objectId: item.id, objectLabel: item.organizationName, summary: 'Issued a new one-time passphrase.', reason });
    if (process.env.NODE_ENV === 'production') { const setup = queueAccountLink(db, publicAccount(item), 'RESET', 30); return { accessCode: item.accessCode, setupEmail: setup.email }; }
    return { accessCode: item.accessCode, passphrase };
  });
  if (!result) { res.status(404).json({ error: { code: 'ACCOUNT_NOT_FOUND', message: 'That account could not be found.' } }); return; }
  await repository.mutate((db) => db.sessions.forEach((session) => { if (session.accountId === req.params.id) session.revokedAt = new Date().toISOString(); }));
  broadcast([String(req.params.id)], { type: 'session.revoked' });
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
  const data = await repository.mutate((db) => {
    reconcilePickups(db.pickups);
    return req.account!.role === 'ADMIN' ? db.pickups : db.pickups.filter((pickup) => pickup.providerId === req.account!.id);
  });
  res.json({ data, pagination: { page: 1, pageSize: 100, totalItems: data.length, totalPages: 1 } });
}));

app.post('/api/waste-logs/:id/publish-pickup', authenticate, requireRole('FOOD_PROVIDER'), asyncRoute(async (req, res) => {
  const input = z.object({
    eligibleRoles: z.array(z.enum(['FARMER_COLLECTOR', 'COMPOSTER'])).min(1).max(2).transform((roles) => [...new Set(roles)] as RecoveryRole[]),
    availableFrom: z.iso.datetime(),
    pickupDeadline: z.iso.datetime(),
    instructions: z.string().trim().max(400).default('')
  }).parse(req.body);
  if (new Date(input.pickupDeadline) <= new Date(input.availableFrom) || new Date(input.pickupDeadline) <= new Date()) {
    res.status(422).json({ error: { code: 'INVALID_PICKUP_WINDOW', message: 'The collection deadline must be after the start time and in the future.' } }); return;
  }
  const result = await repository.mutate((db) => {
    const log = db.logs.find((item) => item.id === req.params.id && item.providerId === req.account!.id);
    const provider = db.accounts.find((item) => item.id === req.account!.id)!;
    if (!provider.collectionAddress?.trim() || !provider.locality?.trim()) return { kind: 'address' as const };
    if (!log || !log.suitableForCollection || log.pickupId || log.leftoverKg <= 0) return { kind: 'unavailable' as const };
    const now = new Date();
    const created: Pickup = {
      id: randomUUID(), providerId: provider.id, providerName: provider.organizationName, wasteLogId: log.id,
      estimatedWeightKg: log.leftoverKg, eligibleRoles: input.eligibleRoles, status: 'AVAILABLE',
      availableFrom: input.availableFrom, pickupDeadline: input.pickupDeadline,
      locality: provider.locality, collectionAddress: provider.collectionAddress,
      collectionInstructions: input.instructions || provider.collectionInstructions || '',
      activity: [], createdAt: now.toISOString(), updatedAt: now.toISOString()
    };
    db.pickups.push(created); log.pickupId = created.id; return { kind: 'created' as const, pickup: created };
  });
  if (result.kind === 'address') { res.status(422).json({ error: { code: 'COLLECTION_ADDRESS_REQUIRED', message: 'Add a collection address in Settings before publishing this pickup.' } }); return; }
  if (result.kind === 'unavailable') { res.status(409).json({ error: { code: 'PICKUP_NOT_AVAILABLE', message: 'This log cannot be published or already has a pickup.' } }); return; }
  res.status(201).json(result.pickup);
}));

app.post('/api/pickups/:id/confirm', authenticate, requireRole('FOOD_PROVIDER'), asyncRoute(async (req, res) => {
  const pickup = await repository.mutate((db) => {
    reconcilePickups(db.pickups);
    const item = db.pickups.find((entry) => entry.id === req.params.id && entry.providerId === req.account!.id);
    if (!item || item.status !== 'AWAITING_PROVIDER_CONFIRMATION') return null;
    const now = new Date().toISOString();
    item.activity.push({ id: randomUUID(), actorId: req.account!.id, actorName: req.account!.organizationName, fromStatus: item.status, toStatus: 'COLLECTED', createdAt: now });
    item.status = 'COLLECTED'; item.updatedAt = now; closePickupConversation(db, item.id, now); return item;
  });
  if (!pickup) { res.status(409).json({ error: { code: 'PICKUP_NOT_CONFIRMABLE', message: 'This pickup is not awaiting provider confirmation.' } }); return; }
  broadcast([pickup.providerId, ...(pickup.reservedByAccountId ? [pickup.reservedByAccountId] : [])], { type: 'pickup.updated', payload: { pickupId: pickup.id, status: pickup.status } });
  res.json(pickup);
}));

const recoveryRoles: AccountRole[] = ['FARMER_COLLECTOR', 'COMPOSTER'];
const addPickupEvent = (pickup: Pickup, actor: Account, toStatus: PickupStatus, reason?: string) => {
  const now = new Date().toISOString();
  pickup.activity.push({ id: randomUUID(), actorId: actor.id, actorName: actor.organizationName, fromStatus: pickup.status, toStatus, reason, createdAt: now });
  pickup.status = toStatus;
  pickup.updatedAt = now;
};

app.get('/api/recovery/overview', authenticate, requireRole(...recoveryRoles), asyncRoute(async (req, res) => {
  const overview = await repository.mutate((db) => {
    reconcilePickups(db.pickups);
    const eligible = db.pickups.filter((pickup) => roleCanRecoverPickup(req.account!.role, pickup));
    const since = Date.now() - 30 * 86400000;
    const completed = eligible.filter((pickup) => pickup.status === 'COLLECTED' && pickup.reservedByAccountId === req.account!.id && new Date(pickup.updatedAt).getTime() >= since);
    return {
      availablePickups: eligible.filter((pickup) => pickup.status === 'AVAILABLE' && new Date(pickup.availableFrom).getTime() <= Date.now() && pickup.collectionAddress).length,
      activePickup: eligible.find((pickup) => pickup.reservedByAccountId === req.account!.id && ACTIVE_PICKUP_STATUSES.includes(pickup.status)),
      collectedKgLast30Days: completed.reduce((sum, pickup) => sum + pickup.estimatedWeightKg, 0),
      completedPickupsLast30Days: completed.length
    };
  });
  res.json(overview);
}));

app.get('/api/recovery/pickups', authenticate, requireRole(...recoveryRoles), asyncRoute(async (req, res) => {
  const scope = z.enum(['available', 'active', 'history']).default('available').parse(req.query.scope);
  const data = await repository.mutate((db) => {
    reconcilePickups(db.pickups);
    const eligible = db.pickups.filter((pickup) => roleCanRecoverPickup(req.account!.role, pickup));
    if (scope === 'active') return eligible.filter((pickup) => pickup.reservedByAccountId === req.account!.id && ACTIVE_PICKUP_STATUSES.includes(pickup.status));
    if (scope === 'history') return eligible.filter((pickup) => pickup.reservedByAccountId === req.account!.id && pickup.status === 'COLLECTED').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return eligible.filter((pickup) => pickup.status === 'AVAILABLE' && new Date(pickup.availableFrom).getTime() <= Date.now() && Boolean(pickup.collectionAddress)).sort((a, b) => a.pickupDeadline.localeCompare(b.pickupDeadline));
  });
  res.json({ data, pagination: { page: 1, pageSize: 100, totalItems: data.length, totalPages: 1 } });
}));

app.post('/api/recovery/pickups/:id/reserve', authenticate, requireRole(...recoveryRoles), asyncRoute(async (req, res) => {
  const result = await repository.mutate((db) => {
    reconcilePickups(db.pickups);
    if (db.pickups.some((pickup) => pickup.reservedByAccountId === req.account!.id && ACTIVE_PICKUP_STATUSES.includes(pickup.status))) return { kind: 'active' as const };
    const pickup = db.pickups.find((item) => item.id === req.params.id);
    if (!pickup || pickup.status !== 'AVAILABLE' || !roleCanRecoverPickup(req.account!.role, pickup) || !pickup.collectionAddress) return { kind: 'unavailable' as const };
    const now = new Date();
    if (new Date(pickup.availableFrom) > now || new Date(pickup.pickupDeadline) <= now) return { kind: 'unavailable' as const };
    pickup.reservedByAccountId = req.account!.id; pickup.reservedByName = req.account!.organizationName;
    pickup.reservedAt = now.toISOString();
    pickup.reservationExpiresAt = new Date(Math.min(now.getTime() + 30 * 60000, new Date(pickup.pickupDeadline).getTime())).toISOString();
    addPickupEvent(pickup, req.account!, 'RESERVED');
    if (!db.chatConversations.some((conversation) => conversation.pickupId === pickup.id && !conversation.terminalAt)) {
      const conversationId = randomUUID(); const createdAt = now.toISOString();
      db.chatConversations.push({ id: conversationId, type: 'PICKUP', state: 'OPEN', pickupId: pickup.id, title: `${pickup.providerName} · ${pickup.estimatedWeightKg} kg pickup`, participantAccountIds: [pickup.providerId, req.account!.id], createdAt, updatedAt: createdAt, unreadCount: 0 });
      db.chatParticipants.push(
        { conversationId, accountId: pickup.providerId, joinedAt: createdAt },
        { conversationId, accountId: req.account!.id, joinedAt: createdAt }
      );
      db.chatMessages.push({ id: randomUUID(), conversationId, kind: 'SYSTEM', senderOrganizationName: 'Bloom', senderDisplayName: 'Bloom', text: 'Pickup reserved. Use this conversation to coordinate the collection.', attachmentIds: [], idempotencyKey: `reservation:${pickup.id}`, createdAt });
    }
    return { kind: 'reserved' as const, pickup };
  });
  if (result.kind === 'active') { res.status(409).json({ error: { code: 'ACTIVE_PICKUP_EXISTS', message: 'Complete or cancel your active pickup before reserving another.' } }); return; }
  if (result.kind === 'unavailable') { res.status(409).json({ error: { code: 'PICKUP_UNAVAILABLE', message: 'This pickup is no longer available.' } }); return; }
  broadcast([result.pickup.providerId, req.account!.id], { type: 'conversation.updated', payload: { pickupId: result.pickup.id } });
  res.json(result.pickup);
}));

const recoveryTransition = (from: PickupStatus, to: PickupStatus) => asyncRoute(async (req, res) => {
  const result = await repository.mutate((db) => {
    reconcilePickups(db.pickups);
    const pickup = db.pickups.find((item) => item.id === req.params.id && item.reservedByAccountId === req.account!.id);
    if (!pickup || pickup.status !== from || !roleCanRecoverPickup(req.account!.role, pickup)) return null;
    addPickupEvent(pickup, req.account!, to); return pickup;
  });
  if (!result) { res.status(409).json({ error: { code: 'INVALID_PICKUP_TRANSITION', message: 'That action is no longer available for this pickup.' } }); return; }
  broadcast([result.providerId, req.account!.id], { type: 'pickup.updated', payload: { pickupId: result.id, status: result.status } });
  res.json(result);
});

app.post('/api/recovery/pickups/:id/start-transit', authenticate, requireRole(...recoveryRoles), recoveryTransition('RESERVED', 'IN_TRANSIT'));
app.post('/api/recovery/pickups/:id/complete-handoff', authenticate, requireRole(...recoveryRoles), recoveryTransition('IN_TRANSIT', 'AWAITING_PROVIDER_CONFIRMATION'));

app.post('/api/recovery/pickups/:id/cancel', authenticate, requireRole(...recoveryRoles), asyncRoute(async (req, res) => {
  const { reason } = z.object({ reason: z.string().trim().min(3).max(300) }).parse(req.body);
  const result = await repository.mutate((db) => {
    reconcilePickups(db.pickups);
    const pickup = db.pickups.find((item) => item.id === req.params.id && item.reservedByAccountId === req.account!.id);
    if (!pickup || !['RESERVED', 'IN_TRANSIT'].includes(pickup.status) || !roleCanRecoverPickup(req.account!.role, pickup)) return null;
    const next: PickupStatus = new Date(pickup.pickupDeadline) > new Date() ? 'AVAILABLE' : 'EXPIRED';
    addPickupEvent(pickup, req.account!, next, reason);
    closePickupConversation(db, pickup.id, pickup.updatedAt);
    delete pickup.reservedByAccountId; delete pickup.reservedByName; delete pickup.reservedAt; delete pickup.reservationExpiresAt;
    return pickup;
  });
  if (!result) { res.status(409).json({ error: { code: 'PICKUP_NOT_CANCELLABLE', message: 'This pickup can no longer be cancelled.' } }); return; }
  broadcast([result.providerId, req.account!.id], { type: 'pickup.updated', payload: { pickupId: result.id, status: result.status } });
  res.json(result);
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
      next = 'AVAILABLE'; auditAction = 'PICKUP_REOPENED'; pickup.pickupDeadline = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
      const provider = db.accounts.find((item) => item.id === pickup.providerId);
      if (!pickup.collectionAddress && provider?.collectionAddress) { pickup.locality = provider.locality ?? ''; pickup.collectionAddress = provider.collectionAddress; pickup.collectionInstructions = provider.collectionInstructions ?? ''; }
    }
    const previousStatus = pickup.status;
    pickup.status = next; pickup.updatedAt = new Date().toISOString();
    pickup.activity.push({ id: randomUUID(), actorId: req.account!.id, actorName: req.account!.displayName, fromStatus: previousStatus, toStatus: next, reason, createdAt: pickup.updatedAt });
    if (next === 'AVAILABLE' || next === 'CANCELLED' || next === 'EXPIRED') { delete pickup.reservedByAccountId; delete pickup.reservedByName; delete pickup.reservedAt; delete pickup.reservationExpiresAt; }
    if (next === 'CANCELLED' || next === 'EXPIRED') closePickupConversation(db, pickup.id, pickup.updatedAt);
    const provider = db.accounts.find((item) => item.id === pickup.providerId);
    addAudit(db, req.account!, { action: auditAction, objectType: 'PICKUP', objectId: pickup.id, objectLabel: provider?.organizationName ?? `${pickup.estimatedWeightKg} kg pickup`, summary: `${action === 'REOPEN' ? 'Reopened' : action === 'EXPIRE' ? 'Expired' : 'Cancelled'} ${pickup.estimatedWeightKg} kg pickup.`, reason });
    return { kind: 'updated' as const, pickup };
  });
  if (result.kind === 'missing') { res.status(404).json({ error: { code: 'PICKUP_NOT_FOUND', message: 'That pickup could not be found.' } }); return; }
  if (result.kind === 'invalid') { res.status(409).json({ error: { code: 'INVALID_PICKUP_OVERRIDE', message: 'That override is not available for the pickup’s current state.' } }); return; }
  res.json(result.pickup);
}));

const requireChatEnabled = (_req: AuthedRequest, res: Response, next: NextFunction) => { if (process.env.NODE_ENV === 'production' && process.env.CHAT_ENABLED !== 'true') { res.status(503).json({ error: { code: 'CHAT_DISABLED', message: 'Chat is not available yet.' } }); return; } next(); };
app.use('/api/chat', requireChatEnabled);
app.use('/api/admin/chat', requireChatEnabled);

app.get('/api/chat/conversations', authenticate, asyncRoute(async (req, res) => {
  const db = await repository.read();
  const data = db.chatConversations
    .filter((conversation) => conversationAccess(conversation, req.account!))
    .map((conversation) => decorateConversation(db, conversation, req.account!))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  res.json({ data });
}));

app.post('/api/chat/support', authenticate, asyncRoute(async (req, res) => {
  const input = z.object({ accountId: z.string().optional() }).parse(req.body ?? {});
  const result = await repository.mutate((db) => {
    const organization = req.account!.role === 'ADMIN'
      ? db.accounts.find((account) => account.id === input.accountId && account.role !== 'ADMIN')
      : db.accounts.find((account) => account.id === req.account!.id);
    if (!organization) return null;
    const existing = db.chatConversations.find((conversation) => conversation.type === 'ADMIN_SUPPORT' && conversation.organizationAccountId === organization.id);
    if (existing) return decorateConversation(db, existing, req.account!);
    const now = new Date().toISOString();
    const conversation: ChatConversation = { id: randomUUID(), type: 'ADMIN_SUPPORT', state: 'OPEN', organizationAccountId: organization.id, title: `${organization.organizationName} · Admin support`, participantAccountIds: [organization.id], createdAt: now, updatedAt: now, unreadCount: 0 };
    db.chatConversations.push(conversation);
    db.chatParticipants.push({ conversationId: conversation.id, accountId: organization.id, joinedAt: now });
    db.chatMessages.push({ id: randomUUID(), conversationId: conversation.id, kind: 'SYSTEM', senderOrganizationName: 'Bloom', senderDisplayName: 'Bloom', text: 'This is a private conversation between your organization and Bloom administrators.', attachmentIds: [], idempotencyKey: `support:${organization.id}`, createdAt: now });
    return decorateConversation(db, conversation, req.account!);
  });
  if (!result) { res.status(404).json({ error: { code: 'ACCOUNT_NOT_FOUND', message: 'That organization could not be found.' } }); return; }
  res.status(201).json(result);
}));

app.get('/api/chat/conversations/:id/messages', authenticate, asyncRoute(async (req, res) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  const before = typeof req.query.before === 'string' ? req.query.before : undefined;
  const db = await repository.read();
  const conversation = db.chatConversations.find((item) => item.id === req.params.id);
  if (!conversation || !conversationAccess(conversation, req.account!)) { res.status(404).json({ error: { code: 'CONVERSATION_NOT_FOUND', message: 'That conversation is not available.' } }); return; }
  const eligible = db.chatMessages.filter((message) => message.conversationId === conversation.id && (!before || message.createdAt < before)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const selected = eligible.slice(0, limit).reverse().map((message) => message.hiddenAt ? { ...message, text: 'Message hidden by a Bloom administrator.', attachmentIds: [] } : message);
  res.json({ data: selected, nextBefore: eligible.length > limit ? selected[0]?.createdAt : undefined, conversation: decorateConversation(db, conversation, req.account!) });
}));

app.post('/api/chat/conversations/:id/messages', authenticate, rateLimit('message', 90, 60000), asyncRoute(async (req, res) => {
  const input = z.object({ text: z.string().trim().max(2000).default(''), attachmentIds: z.array(z.string()).max(4).default([]), idempotencyKey: z.string().trim().min(8).max(120) }).refine((value) => value.text.length > 0 || value.attachmentIds.length > 0, { message: 'Write a message or attach an image.' }).parse(req.body);
  const result = await repository.mutate((db) => {
    const conversation = db.chatConversations.find((item) => item.id === req.params.id);
    if (!conversation || !conversationAccess(conversation, req.account!)) return { kind: 'missing' as const };
    if (req.account!.role === 'ADMIN' && conversation.type === 'PICKUP' && !db.chatParticipants.some((participant) => participant.conversationId === conversation.id && participant.accountId === req.account!.id)) return { kind: 'join' as const };
    if (conversationIsReadOnly(conversation)) return { kind: 'closed' as const };
    const duplicate = db.chatMessages.find((message) => message.conversationId === conversation.id && message.senderAccountId === req.account!.id && message.idempotencyKey === input.idempotencyKey);
    if (duplicate) return { kind: 'sent' as const, message: duplicate, audience: [...conversation.participantAccountIds, ...db.accounts.filter((account) => account.role === 'ADMIN').map((account) => account.id)] };
    const attachments = input.attachmentIds.map((id) => db.chatAttachments.find((attachment) => attachment.id === id && attachment.conversationId === conversation.id && !attachment.messageId));
    if (attachments.some((attachment) => !attachment)) return { kind: 'attachment' as const };
    const createdAt = new Date().toISOString();
    const message: ChatMessage = { id: randomUUID(), conversationId: conversation.id, senderAccountId: req.account!.id, senderOrganizationName: req.account!.organizationName, senderDisplayName: req.account!.displayName, kind: 'MESSAGE', text: input.text, attachmentIds: input.attachmentIds, idempotencyKey: input.idempotencyKey, createdAt };
    db.chatMessages.push(message);
    attachments.forEach((attachment) => { if (attachment) attachment.messageId = message.id; });
    conversation.updatedAt = createdAt;
    const recipients = conversation.participantAccountIds.filter((id) => id !== req.account!.id).map((id) => db.accounts.find((account) => account.id === id)).filter(Boolean);
    if (conversation.type === 'ADMIN_SUPPORT' && req.account!.role !== 'ADMIN') recipients.push(...db.accounts.filter((account) => account.role === 'ADMIN'));
    for (const recipient of recipients) {
      const to = recipient?.email || (recipient?.contact.includes('@') ? recipient.contact : '');
      const readState = recipient && db.chatParticipants.find((participant) => participant.conversationId === conversation.id && participant.accountId === recipient.id);
      if (readState?.lastReadAt && Date.now() - new Date(readState.lastReadAt).getTime() < 5 * 60000) continue;
      const recentlyQueued = db.emailJobs.some((job) => job.conversationId === conversation.id && job.to === to && Date.now() - new Date(job.createdAt).getTime() < 15 * 60000);
      if (to && !recentlyQueued) db.emailJobs.push({ id: randomUUID(), to, subject: `New Bloom message from ${req.account!.organizationName}`, text: `A new message is waiting in “${conversation.title}”. Sign in to Bloom to read and reply.`, conversationId: conversation.id, attempts: 0, nextAttemptAt: createdAt, createdAt });
    }
    return { kind: 'sent' as const, message, audience: [...conversation.participantAccountIds, ...db.accounts.filter((account) => account.role === 'ADMIN').map((account) => account.id)] };
  });
  if (result.kind === 'missing') { res.status(404).json({ error: { code: 'CONVERSATION_NOT_FOUND', message: 'That conversation is not available.' } }); return; }
  if (result.kind === 'join') { res.status(409).json({ error: { code: 'ADMIN_JOIN_REQUIRED', message: 'Join this pickup conversation visibly before sending a message.' } }); return; }
  if (result.kind === 'closed') { res.status(409).json({ error: { code: 'CONVERSATION_CLOSED', message: 'This conversation is now read-only.' } }); return; }
  if (result.kind === 'attachment') { res.status(422).json({ error: { code: 'INVALID_ATTACHMENT', message: 'One or more attachments are unavailable.' } }); return; }
  broadcast(result.audience, { type: 'message.created', conversationId: result.message.conversationId, payload: { messageId: result.message.id } });
  res.status(201).json(result.message);
}));

app.post('/api/chat/conversations/:id/read', authenticate, asyncRoute(async (req, res) => {
  const updated = await repository.mutate((db) => {
    const conversation = db.chatConversations.find((item) => item.id === req.params.id);
    if (!conversation || !conversationAccess(conversation, req.account!)) return false;
    const latest = db.chatMessages.filter((message) => message.conversationId === conversation.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    let participant = db.chatParticipants.find((item) => item.conversationId === conversation.id && item.accountId === req.account!.id);
    if (!participant && req.account!.role === 'ADMIN' && conversation.type === 'PICKUP') return true;
    if (!participant) { participant = { conversationId: conversation.id, accountId: req.account!.id, joinedAt: new Date().toISOString() }; db.chatParticipants.push(participant); }
    participant.lastReadAt = new Date().toISOString(); participant.lastReadMessageId = latest?.id; return true;
  });
  if (!updated) { res.status(404).json({ error: { code: 'CONVERSATION_NOT_FOUND', message: 'That conversation is not available.' } }); return; }
  res.status(204).end();
}));

app.post('/api/chat/conversations/:id/attachments', authenticate, rateLimit('upload', 20, 60000), asyncRoute(async (req, res) => {
  const input = z.object({ dataUrl: z.string().max(7_500_000), mediaType: z.enum(['image/jpeg', 'image/png', 'image/webp']), width: z.number().int().positive().max(4096), height: z.number().int().positive().max(4096) }).parse(req.body);
  const conversation = (await repository.read()).chatConversations.find((item) => item.id === req.params.id);
  if (!conversation || !conversationAccess(conversation, req.account!)) { res.status(404).json({ error: { code: 'CONVERSATION_NOT_FOUND', message: 'That conversation is not available.' } }); return; }
  if (conversationIsReadOnly(conversation)) { res.status(409).json({ error: { code: 'CONVERSATION_CLOSED', message: 'This conversation is now read-only.' } }); return; }
  const encoded = input.dataUrl.includes(',') ? input.dataUrl.slice(input.dataUrl.indexOf(',') + 1) : input.dataUrl;
  const content = Buffer.from(encoded, 'base64');
  let mediaType: 'image/jpeg' | 'image/png' | 'image/webp';
  try { mediaType = validateImage(content, input.mediaType); } catch (error) { res.status(422).json({ error: { code: 'INVALID_IMAGE', message: error instanceof Error ? error.message : 'The image is invalid.' } }); return; }
  const id = randomUUID(); const extension = mediaType === 'image/jpeg' ? 'jpg' : mediaType === 'image/png' ? 'png' : 'webp'; const objectKey = `chat/${conversation.id}/${id}.${extension}`;
  await putAttachment(objectKey, content, mediaType);
  const attachment = await repository.mutate((db) => {
    const item = { id, conversationId: conversation.id, objectKey, mediaType, width: input.width, height: input.height, byteSize: content.byteLength, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 365 * 86400000).toISOString() };
    db.chatAttachments.push(item); return item;
  });
  res.status(201).json(attachment);
}));

app.get('/api/chat/attachments/:id/access', authenticate, asyncRoute(async (req, res) => {
  const db = await repository.read(); const attachment = db.chatAttachments.find((item) => item.id === req.params.id); const conversation = attachment && db.chatConversations.find((item) => item.id === attachment.conversationId);
  if (!attachment || !conversation || !conversationAccess(conversation, req.account!)) { res.status(404).json({ error: { code: 'ATTACHMENT_NOT_FOUND', message: 'That image is not available.' } }); return; }
  if (!attachmentSigningSecret()) { res.status(503).json({ error: { code: 'ATTACHMENT_SIGNING_UNAVAILABLE', message: 'Image access is not configured.' } }); return; }
  const expires = Date.now() + 5 * 60000; const signature = signAttachmentAccess(attachment.id, expires);
  res.json({ url: `${process.env.API_PUBLIC_URL || ''}/api/chat/attachments/${attachment.id}/content?expires=${expires}&signature=${signature}`, expiresAt: new Date(expires).toISOString() });
}));

app.get('/api/chat/attachments/:id/content', asyncRoute(async (req, res) => {
  const expires = Number(req.query.expires); const signature = String(req.query.signature || '');
  if (!expires || expires < Date.now() || signature !== signAttachmentAccess(String(req.params.id), expires)) { res.status(403).end(); return; }
  const attachment = (await repository.read()).chatAttachments.find((item) => item.id === req.params.id);
  if (!attachment) { res.status(404).end(); return; }
  const content = await getAttachment(attachment.objectKey); res.type(attachment.mediaType).setHeader('Cache-Control', 'private, max-age=300'); res.send(content);
}));

app.post('/api/admin/chat/conversations/:id/join', authenticate, requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const result = await repository.mutate((db) => {
    const conversation = db.chatConversations.find((item) => item.id === req.params.id); if (!conversation) return null;
    const now = new Date().toISOString();
    if (!db.chatParticipants.some((item) => item.conversationId === conversation.id && item.accountId === req.account!.id)) db.chatParticipants.push({ conversationId: conversation.id, accountId: req.account!.id, joinedAt: now });
    if (!conversation.adminJoinedAt) {
      conversation.adminJoinedAt = now; conversation.updatedAt = now;
      db.chatMessages.push({ id: randomUUID(), conversationId: conversation.id, kind: 'SYSTEM', senderOrganizationName: 'Bloom', senderDisplayName: 'Bloom', text: `${req.account!.displayName} joined this conversation as a Bloom administrator.`, attachmentIds: [], idempotencyKey: `admin-join:${conversation.id}`, createdAt: now });
      addAudit(db, req.account!, { action: 'CHAT_ADMIN_JOINED', objectType: 'CHAT_CONVERSATION', objectId: conversation.id, objectLabel: conversation.title, summary: `Joined ${conversation.title}.` });
    }
    return decorateConversation(db, conversation, req.account!);
  });
  if (!result) { res.status(404).json({ error: { code: 'CONVERSATION_NOT_FOUND', message: 'That conversation is not available.' } }); return; }
  res.json(result);
}));

app.post('/api/admin/chat/messages/:id/hide', authenticate, requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const { reason } = z.object({ reason: z.string().trim().min(3).max(300) }).parse(req.body);
  const result = await repository.mutate((db) => {
    const message = db.chatMessages.find((item) => item.id === req.params.id && item.kind === 'MESSAGE'); if (!message) return null;
    message.hiddenAt = new Date().toISOString(); message.hiddenReason = reason;
    addAudit(db, req.account!, { action: 'CHAT_MESSAGE_HIDDEN', objectType: 'CHAT_MESSAGE', objectId: message.id, objectLabel: 'Conversation message', summary: 'Hid a conversation message.', reason });
    return message;
  });
  if (!result) { res.status(404).json({ error: { code: 'MESSAGE_NOT_FOUND', message: 'That message is not available.' } }); return; }
  res.json(result);
}));

app.use((error: unknown, req: AuthedRequest, res: Response, _next: NextFunction) => {
  console.error(JSON.stringify({ traceId: req.traceId, error }));
  if (error instanceof z.ZodError) {
    res.status(422).json({ error: { code: 'VALIDATION_FAILED', message: 'Check the highlighted information and try again.', details: error.issues } });
    return;
  }
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Bloom could not complete that request. Try again.' } });
});

if (process.env.NODE_ENV !== 'test') {
  const server = createServer(app);
  server.on('upgrade', async (request, socket) => {
    try {
      if (request.url !== '/api/chat/socket' || request.headers.upgrade?.toLowerCase() !== 'websocket' || (process.env.NODE_ENV === 'production' && (!request.headers.origin || !allowedOrigins.includes(request.headers.origin)))) { socket.destroy(); return; }
      const key = request.headers['sec-websocket-key']; if (!key) { socket.destroy(); return; }
      const cookies = Object.fromEntries(String(request.headers.cookie ?? '').split(';').map((part) => part.trim().split('=').map(decodeURIComponent)).filter((part) => part.length === 2));
      const sessionHash = cookies.bloom_session ? tokenHash(cookies.bloom_session) : '';
      const db = await repository.read(); const session = db.sessions.find((item) => item.tokenHash === sessionHash && !item.revokedAt && new Date(item.expiresAt).getTime() > Date.now()); const account = session && db.accounts.find((item) => item.id === session.accountId && item.status === 'ACTIVE');
      if (!account) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
      const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      const clients = realtimeClients.get(account.id) ?? new Set<Duplex>(); clients.add(socket); realtimeClients.set(account.id, clients);
      const remove = () => { clients.delete(socket); if (!clients.size) realtimeClients.delete(account.id); };
      socket.on('close', remove); socket.on('error', remove); socket.on('data', (data) => { if ((data[0] & 0x0f) === 0x08) socket.end(); });
    } catch { socket.destroy(); }
  });
  server.listen(port, () => console.log(`Bloom API listening at http://localhost:${port} (${process.env.DATA_DRIVER})`));
  void processEmailQueue(repository); setInterval(() => void processEmailQueue(repository), 30000).unref();
  void cleanExpiredChatContent(repository); setInterval(() => void cleanExpiredChatContent(repository), 24 * 3600000).unref();
}

export { app, repository as repositoryInstance };
