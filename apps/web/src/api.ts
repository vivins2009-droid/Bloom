import type { ApiError } from '@bloom/contracts';

const configuredApiOrigin = (((import.meta as unknown as { env: Record<string, string | undefined> }).env.VITE_API_URL) ?? '').replace(/\/$/, '');
// Production HTTP requests use Vercel's same-origin proxy. This keeps account
// setup and sign-in available while the API remains on Railway and avoids
// coupling browser access to Railway's deployment-specific CORS snapshot.
const usesProductionProxy = ['bloom-co.in', 'www.bloom-co.in'].includes(window.location.hostname);
const apiOrigin = usesProductionProxy ? '' : configuredApiOrigin;
let csrfToken = '';
const responseCache = new Map<string, { expiresAt: number; value: unknown }>();
const pendingRequests = new Map<string, Promise<unknown>>();

const cacheDuration = (path: string) => path === '/organization-types' ? 5 * 60_000 : 2 * 60_000;

export function clearApiCache() {
  responseCache.clear();
  pendingRequests.clear();
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method === 'GET') {
    const cached = responseCache.get(path);
    if (cached && cached.expiresAt > Date.now()) return cached.value as T;
    const pending = pendingRequests.get(path);
    if (pending) return pending as Promise<T>;
  }
  const request = fetch(`${apiOrigin}/api${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(csrfToken && !['GET', 'HEAD'].includes(method) ? { 'X-CSRF-Token': csrfToken } : {}),
      ...init?.headers
    }
  }).then(async (response) => {
    const nextCsrf = response.headers.get('x-csrf-token');
    if (nextCsrf) csrfToken = nextCsrf;
    if (!response.ok) {
      const body = await response.json().catch(() => null) as ApiError | null;
      throw new Error(body?.error.message || 'Bloom could not complete that request. Try again.');
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }).then((value) => {
    if (method === 'GET') responseCache.set(path, { expiresAt: Date.now() + cacheDuration(path), value });
    else clearApiCache();
    return value;
  }).finally(() => { if (method === 'GET') pendingRequests.delete(path); });
  if (method === 'GET') pendingRequests.set(path, request);
  return request;
}

export const apiBaseUrl = apiOrigin;
export const chatSocketUrl = `${configuredApiOrigin || window.location.origin}`.replace(/^http/, 'ws') + '/api/chat/socket';

export const today = () => new Date().toISOString().slice(0, 10);
export const formatDate = (value: string, options?: Intl.DateTimeFormatOptions | boolean) => new Intl.DateTimeFormat('en-IN', options === true ? { dateStyle: 'medium', timeStyle: 'short' } : options || { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(value.includes('T') ? value : `${value}T00:00:00`));
