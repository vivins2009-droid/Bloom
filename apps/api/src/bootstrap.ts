import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AdminAuditEvent } from '@bloom/contracts';
import { hashPassphrase, type Repository, type StoredAccount } from './repository.js';

const tokenHash = (value: string) => createHash('sha256').update(value).digest('hex');

export async function bootstrapProductionAdmin(repository: Repository, frontendOrigin: string) {
  if (process.env.NODE_ENV !== 'production') return;
  await repository.mutate((db) => {
    if (db.accounts.some((account) => account.role === 'ADMIN')) return;
    const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
    if (!email || !email.includes('@')) throw new Error('BOOTSTRAP_ADMIN_EMAIL is required until the first administrator account has been created.');
    const now = new Date().toISOString();
    const account: StoredAccount = {
      id: randomUUID(), role: 'ADMIN', accessCode: `ADM-${randomBytes(4).toString('hex').toUpperCase()}`,
      passphraseHash: hashPassphrase(randomBytes(32).toString('base64url')),
      displayName: process.env.BOOTSTRAP_ADMIN_NAME?.trim() || 'Bloom Administrator',
      organizationName: process.env.BOOTSTRAP_ADMIN_ORGANIZATION?.trim() || 'Bloom Operations',
      contact: email, email, status: 'ACTIVE', firstLogin: true, createdAt: now
    };
    const token = randomBytes(32).toString('base64url');
    db.accounts.push(account);
    db.accountTokens.push({ id: randomUUID(), accountId: account.id, purpose: 'SETUP', tokenHash: tokenHash(token), createdAt: now, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() });
    db.emailJobs.push({
      id: randomUUID(), to: email, subject: 'Set up the first Bloom administrator',
      text: `Your Bloom administrator access code is ${account.accessCode}.\n\nChoose your passphrase using this single-use link: ${frontendOrigin}/setup-account?token=${encodeURIComponent(token)}\n\nThis link expires in 24 hours.`,
      attempts: 0, nextAttemptAt: now, createdAt: now
    });
    const audit: AdminAuditEvent = {
      id: randomUUID(), actorId: account.id, actorName: account.displayName, action: 'ACCOUNT_CREATED', objectType: 'ACCOUNT',
      objectId: account.id, objectLabel: account.organizationName, summary: 'Created the initial administrator account.', createdAt: now
    };
    db.auditEvents.unshift(audit);
  });
}
