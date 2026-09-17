export const config = { runtime: 'edge' };

const forwardedRequestHeaders = new Set(['accept', 'content-type', 'cookie', 'user-agent', 'x-csrf-token', 'x-forwarded-for']);
const forwardedResponseHeaders = new Set(['content-type', 'set-cookie', 'x-csrf-token', 'x-trace-id']);

export default async function handler(request) {
  const incoming = new URL(request.url);
  const path = incoming.searchParams.get('path') ?? '';
  incoming.searchParams.delete('path');

  const headers = new Headers();
  for (const [key, value] of request.headers) if (forwardedRequestHeaders.has(key)) headers.set(key, value);

  const hasBody = !['GET', 'HEAD'].includes(request.method);
  const upstream = await fetch(`https://api.bloom-co.in/api/${path}${incoming.search}`, {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    redirect: 'manual'
  });

  const responseHeaders = new Headers();
  for (const [key, value] of upstream.headers) if (forwardedResponseHeaders.has(key)) responseHeaders.set(key, value);
  responseHeaders.set('cache-control', 'private, no-store');
  responseHeaders.set('x-content-type-options', 'nosniff');
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}
