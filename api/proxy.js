const skippedRequestHeaders = new Set(['connection', 'content-length', 'host', 'origin', 'referer']);
const forwardedResponseHeaders = new Set(['content-type', 'set-cookie', 'x-csrf-token', 'x-trace-id']);

export default async function handler(request, response) {
  const path = Array.isArray(request.query.path) ? request.query.path.join('/') : request.query.path;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(request.query)) {
    if (key === 'path') continue;
    for (const item of Array.isArray(value) ? value : [value]) query.append(key, item);
  }

  const headers = {};
  for (const [key, value] of Object.entries(request.headers)) {
    if (!skippedRequestHeaders.has(key) && value !== undefined) headers[key] = value;
  }

  const hasBody = !['GET', 'HEAD'].includes(request.method);
  const body = hasBody && request.body !== undefined
    ? (typeof request.body === 'string' || Buffer.isBuffer(request.body) ? request.body : JSON.stringify(request.body))
    : undefined;
  const upstream = await fetch(`https://api.bloom-co.in/api/${path}${query.size ? `?${query}` : ''}`, {
    method: request.method,
    headers,
    body,
    redirect: 'manual'
  });

  for (const [key, value] of upstream.headers) {
    if (forwardedResponseHeaders.has(key)) response.setHeader(key, value);
  }
  response.status(upstream.status).send(Buffer.from(await upstream.arrayBuffer()));
}
