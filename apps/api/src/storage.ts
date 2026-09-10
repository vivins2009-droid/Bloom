import { createHash, createHmac } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

type MediaType = 'image/jpeg' | 'image/png' | 'image/webp';

const driver = process.env.ATTACHMENT_DRIVER || (process.env.NODE_ENV === 'production' ? 'r2' : 'file');
const localRoot = resolve(process.cwd(), process.env.ATTACHMENT_PATH || 'data/attachments');

const hmac = (key: Buffer | string, value: string) => createHmac('sha256', key).update(value).digest();
const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const encodePath = (value: string) => value.split('/').map(encodeURIComponent).join('/');

function r2Config() {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKey = process.env.R2_ACCESS_KEY_ID;
  const secretKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET;
  if (!accountId || !accessKey || !secretKey || !bucket) throw new Error('R2 storage is selected but its credentials are incomplete.');
  return { accountId, accessKey, secretKey, bucket };
}

async function signedR2Request(method: 'GET' | 'PUT' | 'DELETE', key: string, body?: Buffer, mediaType?: MediaType) {
  const config = r2Config();
  const host = `${config.accountId}.r2.cloudflarestorage.com`;
  const path = `/${encodeURIComponent(config.bucket)}/${encodePath(key)}`;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const payloadHash = sha256(body ?? Buffer.alloc(0));
  const headers: Record<string, string> = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  if (mediaType) headers['content-type'] = mediaType;
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${headers[name]}\n`).join('');
  const canonicalRequest = [method, path, '', canonicalHeaders, signedHeaderNames.join(';'), payloadHash].join('\n');
  const scope = `${date}/auto/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${config.secretKey}`, date), 'auto'), 's3'), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKey}/${scope}, SignedHeaders=${signedHeaderNames.join(';')}, Signature=${signature}`;
  const response = await fetch(`https://${host}${path}`, { method, headers, body: body ? new Uint8Array(body) : undefined });
  if (!response.ok) throw new Error(`R2 ${method} failed with status ${response.status}.`);
  return response;
}

export async function putAttachment(key: string, content: Buffer, mediaType: MediaType) {
  if (driver === 'r2') { await signedR2Request('PUT', key, content, mediaType); return; }
  if (driver !== 'file') throw new Error(`Unsupported ATTACHMENT_DRIVER: ${driver}`);
  const path = resolve(localRoot, key);
  if (!path.startsWith(`${localRoot}/`)) throw new Error('Invalid attachment key.');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

export async function getAttachment(key: string) {
  if (driver === 'r2') return Buffer.from(await (await signedR2Request('GET', key)).arrayBuffer());
  const path = resolve(localRoot, key);
  if (!path.startsWith(`${localRoot}/`)) throw new Error('Invalid attachment key.');
  return readFile(path);
}

export async function deleteAttachment(key: string) {
  if (driver === 'r2') { await signedR2Request('DELETE', key); return; }
  const path = resolve(localRoot, key);
  if (!path.startsWith(`${localRoot}/`)) throw new Error('Invalid attachment key.');
  await unlink(path).catch(() => undefined);
}

export function validateImage(content: Buffer, declared: string): MediaType {
  if (content.length > 5 * 1024 * 1024) throw new Error('Each image must be 5 MB or smaller.');
  const jpeg = content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff;
  const png = content.length >= 8 && content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const webp = content.length >= 12 && content.subarray(0, 4).toString() === 'RIFF' && content.subarray(8, 12).toString() === 'WEBP';
  const actual: MediaType | undefined = jpeg ? 'image/jpeg' : png ? 'image/png' : webp ? 'image/webp' : undefined;
  if (!actual || actual !== declared) throw new Error('The image contents do not match its declared JPEG, PNG, or WebP type.');
  return actual;
}
