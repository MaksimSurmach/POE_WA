import type { FastifyRequest } from 'fastify';

/** Direct loopback only: no reverse-proxy identity or browser secret is trusted. */
export function isLocalAdmin(request: Pick<FastifyRequest, 'headers' | 'ip'>) {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.ip))
    return false;
  if (
    Object.keys(request.headers).some(
      (key) => key === 'forwarded' || key.startsWith('x-forwarded-'),
    )
  )
    return false;
  const host = request.headers.host;
  if (!host || !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/.test(host))
    return false;
  const origin = request.headers.origin;
  if (origin) {
    try {
      const url = new URL(origin);
      if (!['http:', 'https:'].includes(url.protocol) || url.host !== host)
        return false;
    } catch {
      return false;
    }
  }
  const site = request.headers['sec-fetch-site'];
  return site === undefined || site === 'same-origin' || site === 'none';
}

export function isCollectorOperatorRoute(method: string, path: string) {
  return (
    (path === '/api/run' && method === 'POST') ||
    (path === '/api/collector/status' && ['GET', 'HEAD'].includes(method)) ||
    (path === '/api/admin/market/settings' &&
      ['GET', 'HEAD', 'PATCH'].includes(method)) ||
    (['/api/admin/market/pause', '/api/admin/market/resume'].includes(path) &&
      method === 'POST')
  );
}

export function needsAdminAccess(method: string, path: string) {
  return (
    isCollectorOperatorRoute(method, path) ||
    path.startsWith('/api/admin/') ||
    (!['GET', 'HEAD', 'OPTIONS'].includes(method) &&
      (path === '/api/refresh' || path.startsWith('/api/market/')))
  );
}
