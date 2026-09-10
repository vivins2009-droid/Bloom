import { z } from 'zod';

const httpsUrl = z.string().url().refine((value) => value.startsWith('https://'), 'must use HTTPS');

export function validateRuntimeConfig() {
  if (process.env.NODE_ENV !== 'production') return;
  const coreSchema = z.object({
    DATA_DRIVER: z.literal('postgres'),
    DATABASE_URL: z.string().min(1),
    WEB_ORIGINS: z.string().min(1).refine((value) => value.split(',').every((origin) => httpsUrl.safeParse(origin.trim()).success), 'must contain only HTTPS origins'),
    API_PUBLIC_URL: httpsUrl,
    CHAT_ENABLED: z.enum(['true', 'false']),
    EMAIL_ENABLED: z.enum(['true', 'false'])
  });
  const chatSchema = z.object({
    ATTACHMENT_DRIVER: z.literal('r2'),
    ATTACHMENT_SIGNING_SECRET: z.string().min(32),
    R2_ACCOUNT_ID: z.string().min(1),
    R2_BUCKET: z.string().min(3),
    R2_ACCESS_KEY_ID: z.string().min(1),
    R2_SECRET_ACCESS_KEY: z.string().min(1),
  });
  const emailSchema = z.object({
    RESEND_API_KEY: z.string().min(1),
    EMAIL_FROM: z.string().min(3)
  });
  const core = coreSchema.safeParse(process.env);
  const chat = process.env.CHAT_ENABLED === 'true' ? chatSchema.safeParse(process.env) : undefined;
  const email = process.env.EMAIL_ENABLED === 'true' ? emailSchema.safeParse(process.env) : undefined;
  const issues = [
    ...(core.success ? [] : core.error.issues),
    ...(chat && !chat.success ? chat.error.issues : []),
    ...(email && !email.success ? email.error.issues : [])
  ];
  if (issues.length) {
    const missing = issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Production configuration is invalid: ${missing}`);
  }
}
