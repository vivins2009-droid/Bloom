import { afterEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { bootstrapProductionAdmin } from './bootstrap.js';
import { validateRuntimeConfig } from './config.js';
import { normalizeDatabase, type Repository } from './repository.js';
import { sanitizeImage } from './storage.js';

const originalEnvironment = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
  Object.assign(process.env, originalEnvironment);
});

describe('production readiness', () => {
  it('decodes and re-encodes uploaded images instead of trusting client metadata', async () => {
    const source = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#74d3ae' } }).jpeg().toBuffer();
    const result = await sanitizeImage(source, 'image/jpeg');
    const metadata = await sharp(result.content).metadata();
    expect(result.mediaType).toBe('image/webp');
    expect([result.width, result.height]).toEqual([32, 24]);
    expect(metadata.format).toBe('webp');
    expect(metadata.exif).toBeUndefined();
  });

  it('rejects production startup when required private services are missing', () => {
    process.env.NODE_ENV = 'production';
    process.env.DATA_DRIVER = 'postgres';
    process.env.CHAT_ENABLED = 'false';
    process.env.EMAIL_ENABLED = 'false';
    delete process.env.DATABASE_URL;
    expect(() => validateRuntimeConfig()).toThrow(/DATABASE_URL/);
  });

  it('starts the core production API when deferred integrations are explicitly disabled', () => {
    process.env.NODE_ENV = 'production';
    process.env.DATA_DRIVER = 'postgres';
    process.env.DATABASE_URL = 'postgresql://example.invalid/bloom';
    process.env.WEB_ORIGINS = 'https://web.example.org';
    process.env.API_PUBLIC_URL = 'https://api.example.org';
    process.env.CHAT_ENABLED = 'false';
    process.env.EMAIL_ENABLED = 'false';
    expect(() => validateRuntimeConfig()).not.toThrow();
  });

  it('requires the private integrations before production chat can be enabled', () => {
    process.env.NODE_ENV = 'production';
    process.env.DATA_DRIVER = 'postgres';
    process.env.DATABASE_URL = 'postgresql://example.invalid/bloom';
    process.env.WEB_ORIGINS = 'https://web.example.org';
    process.env.API_PUBLIC_URL = 'https://api.example.org';
    process.env.CHAT_ENABLED = 'true';
    process.env.EMAIL_ENABLED = 'false';
    expect(() => validateRuntimeConfig()).toThrow(/ATTACHMENT_DRIVER/);
  });

  it('requires Resend credentials before production email can be enabled', () => {
    process.env.NODE_ENV = 'production';
    process.env.DATA_DRIVER = 'postgres';
    process.env.DATABASE_URL = 'postgresql://example.invalid/bloom';
    process.env.WEB_ORIGINS = 'https://web.example.org';
    process.env.API_PUBLIC_URL = 'https://api.example.org';
    process.env.CHAT_ENABLED = 'false';
    process.env.EMAIL_ENABLED = 'true';
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;
    expect(() => validateRuntimeConfig()).toThrow(/RESEND_API_KEY/);
  });

  it('creates the first administrator once and queues a setup email without storing the link token', async () => {
    let state = normalizeDatabase({ organizationTypes: [] });
    const repository: Repository = {
      read: async () => state,
      mutate: async (work) => { const value = work(state); state = normalizeDatabase(state); return value; }
    };
    process.env.NODE_ENV = 'production';
    process.env.EMAIL_ENABLED = 'true';
    process.env.BOOTSTRAP_ADMIN_EMAIL = 'owner@example.org';
    await bootstrapProductionAdmin(repository, 'https://web.example.org');
    await bootstrapProductionAdmin(repository, 'https://web.example.org');
    const saved = await repository.read();
    const admins = saved.accounts.filter((account) => account.role === 'ADMIN');
    expect(admins).toHaveLength(1);
    expect(admins[0].accessCode).toMatch(/^ADM-[A-F0-9]{8}$/);
    expect(saved.emailJobs).toHaveLength(1);
    expect(saved.emailJobs[0].text).toContain('https://web.example.org/setup-account?token=');
    expect(JSON.stringify(saved.accountTokens)).not.toContain(saved.emailJobs[0].text.split('token=')[1]?.split('\n')[0]);
  });
});
