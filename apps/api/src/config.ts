import { z } from 'zod';

const httpsUrl = z.string().url().refine((value) => value.startsWith('https://'), 'must use HTTPS');

export function validateRuntimeConfig() {
  if (process.env.NODE_ENV !== 'production') return;
  const schema = z.object({
    DATA_DRIVER: z.literal('postgres'),
    DATABASE_URL: z.string().min(1),
    WEB_ORIGINS: z.string().min(1).refine((value) => value.split(',').every((origin) => httpsUrl.safeParse(origin.trim()).success), 'must contain only HTTPS origins'),
    API_PUBLIC_URL: httpsUrl,
    ATTACHMENT_DRIVER: z.literal('r2'),
    ATTACHMENT_SIGNING_SECRET: z.string().min(32),
    R2_ACCOUNT_ID: z.string().min(1),
    R2_BUCKET: z.string().min(3),
    R2_ACCESS_KEY_ID: z.string().min(1),
    R2_SECRET_ACCESS_KEY: z.string().min(1),
    RESEND_API_KEY: z.string().min(1),
    EMAIL_FROM: z.string().min(3)
  });
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const missing = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Production configuration is invalid: ${missing}`);
  }
}
