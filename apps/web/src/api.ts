import type { ApiError } from '@bloom/contracts';

const apiOrigin = (((import.meta as unknown as { env: Record<string, string | undefined> }).env.VITE_API_URL) ?? '').replace(/\/$/, '');
let csrfToken = '';

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const response = await fetch(`${apiOrigin}/api${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(csrfToken && !['GET', 'HEAD'].includes(method) ? { 'X-CSRF-Token': csrfToken } : {}),
      ...init?.headers
    }
  });
  const nextCsrf = response.headers.get('x-csrf-token');
  if (nextCsrf) csrfToken = nextCsrf;
  if (!response.ok) {
    const body = await response.json().catch(() => null) as ApiError | null;
    throw new Error(body?.error.message || 'Bloom could not complete that request. Try again.');
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const apiBaseUrl = apiOrigin;
export const chatSocketUrl = `${apiOrigin || window.location.origin}`.replace(/^http/, 'ws') + '/api/chat/socket';

export const today = () => new Date().toISOString().slice(0, 10);
export const formatDate = (value: string, options?: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-IN', options ?? { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${value}T00:00:00`));
