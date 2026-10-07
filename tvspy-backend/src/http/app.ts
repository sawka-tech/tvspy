// The HTTP application: security headers, CSRF and auth guards, the API routes and the frontend.

import type { ApiErrorBody } from '@tvspy/shared';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie } from 'hono/cookie';
import { SESSION_COOKIE } from '../auth/service.js';
import { authRoutes, passwordRoute, setSessionCookie } from './routes/auth.js';
import { sessionRoutes } from './routes/sessions.js';
import { settingsRoutes } from './routes/settings.js';
import { systemRoutes } from './routes/system.js';
import { serveFrontend } from './static.js';
import { ApiError, type AppDeps, type AppEnv, clientAccess } from './support.js';

export const CSRF_HEADER = 'x-tvspy-csrf';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const errorBody = (code: ApiErrorBody['error']['code'], message: string, fields?: Record<string, string>) =>
  ({ error: fields ? { code, message, fields } : { code, message } }) satisfies ApiErrorBody;

export function createApp(d: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    await next();
    c.header('Content-Security-Policy', CSP);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Cross-Origin-Opener-Policy', 'same-origin');
    c.header('Cross-Origin-Resource-Policy', 'same-origin');
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (c.req.path.startsWith('/api/') && !c.res.headers.has('Cache-Control'))
      c.header('Cache-Control', 'no-store');
  });

  app.use(
    '/api/*',
    bodyLimit({
      maxSize: 64 * 1024,
      onError: () => {
        throw new ApiError(413, 'VALIDATION', 'The request is too large');
      },
    }),
  );

  // CSRF: state-changing requests need our custom header (a cross-site form or fetch cannot send it
  // without a CORS preflight, which we never approve), JSON bodies, and a same-origin Origin if present.
  app.use('/api/*', async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) return next();
    if (c.req.header(CSRF_HEADER) !== '1') throw new ApiError(403, 'FORBIDDEN', 'Missing CSRF header');
    const origin = c.req.header('origin');
    if (origin) {
      let originHost: string | null = null;
      try {
        originHost = new URL(origin).host;
      } catch {
        originHost = null;
      }
      const host = c.req.header('x-forwarded-host') ?? c.req.header('host') ?? new URL(c.req.url).host;
      if (originHost !== host) throw new ApiError(403, 'FORBIDDEN', 'Cross-origin request refused');
    }
    const type = c.req.header('content-type');
    const hasBody =
      Number(c.req.header('content-length') ?? 0) > 0 || c.req.header('transfer-encoding') !== undefined;
    if ((hasBody || type !== undefined) && !(type ?? '').toLowerCase().startsWith('application/json')) {
      throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send JSON');
    }
    return next();
  });

  app.get('/api/health', (c) =>
    c.json({ ok: true, version: d.version, commit: d.commit, tvhConnected: d.tvh.connected }),
  );
  app.route('/api/auth', authRoutes(d));

  // Everything below: open from trusted networks, otherwise only after logging in with the password.
  app.use('/api/*', async (c, next) => {
    const { trusted } = clientAccess(c, d);
    const token = getCookie(c, SESSION_COOKIE);
    const session = d.auth.session(token);
    if (!trusted && (!session || !token)) {
      throw new ApiError(
        401,
        'UNAUTHENTICATED',
        d.auth.hasAdmin() ? 'Please log in' : 'tvspy only opens from your home network',
      );
    }
    if (session?.renewed && token) setSessionCookie(c, token);
    c.set('trusted', trusted);
    c.set('username', session?.username ?? null);
    c.set('token', session ? (token ?? null) : null);
    return next();
  });

  app.route('/api/auth/password', passwordRoute(d));
  app.route('/api', systemRoutes(d));
  app.route('/api/sessions', sessionRoutes(d));
  app.route('/api/settings', settingsRoutes(d));

  if (d.publicDir) app.use('*', serveFrontend(d.publicDir));

  app.notFound((c) => c.json(errorBody('NOT_FOUND', 'Not found'), 404));
  app.onError((err, c) => {
    if (err instanceof ApiError) {
      for (const [k, v] of Object.entries(err.headers ?? {})) c.header(k, v);
      return c.json(errorBody(err.code, err.message, err.fields), err.status);
    }
    d.log.error(`${c.req.method} ${c.req.path} failed`, err);
    return c.json(errorBody('INTERNAL', 'Internal error'), 500);
  });

  return app;
}
