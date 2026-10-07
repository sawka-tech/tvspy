import type { AuthState } from '@tvspy/shared';
import { type Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { AuthError, PASSWORD_MAX, SESSION_COOKIE, SESSION_DAYS, USERNAME_MAX } from '../../auth/service.js';
import { ApiError, type AppDeps, type AppEnv, clientAccess, displayIp, readJson } from '../support.js';

const username = z.string().trim().min(1, 'Enter a user name').max(USERNAME_MAX);
const password = z.string().min(1, 'Enter a password').max(PASSWORD_MAX);

const isHttps = (c: Context<AppEnv>) =>
  c.req.header('x-forwarded-proto') === 'https' || new URL(c.req.url).protocol === 'https:';

export function setSessionCookie(c: Context<AppEnv>, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Strict',
    path: '/',
    maxAge: SESSION_DAYS * 86400,
    secure: isHttps(c),
  });
}

function weakPassword(err: unknown, field: string): never {
  if (err instanceof AuthError && err.reason === 'weak_password') {
    throw new ApiError(400, 'VALIDATION', err.message, { [field]: err.message });
  }
  throw err;
}

/** GET /api/auth, login and logout: public. */
export function authRoutes(d: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/', (c) => {
    const { ip, trusted } = clientAccess(c, d);
    const session = d.auth.session(getCookie(c, SESSION_COOKIE));
    const body: AuthState = {
      authenticated: trusted || session !== null,
      trustedNetwork: trusted,
      loginAvailable: d.auth.hasAdmin(),
      username: session?.username ?? null,
      address: ip === 'unknown' ? null : displayIp(ip),
    };
    return c.json(body);
  });

  app.post('/login', async (c) => {
    const body = await readJson(c, z.object({ username, password }));
    const { ip, trusted } = clientAccess(c, d);
    if (!d.auth.hasAdmin()) {
      throw new ApiError(401, 'UNAUTHENTICATED', 'No password is set; open tvspy from your home network');
    }
    const now = d.now();
    const wait = d.limiter.retryAfter(ip, now);
    if (wait > 0) {
      throw new ApiError(
        429,
        'RATE_LIMITED',
        `Too many failed attempts; try again in ${Math.ceil(wait / 60)} min`,
        undefined,
        { 'Retry-After': String(wait) },
      );
    }
    let token: string;
    try {
      token = await d.auth.login(body.username, body.password, {
        ip,
        userAgent: c.req.header('user-agent') ?? null,
      });
    } catch (err) {
      if (!(err instanceof AuthError)) throw err;
      d.limiter.fail(ip, now);
      d.log.warn(`Failed login from ${displayIp(ip)}`);
      throw new ApiError(401, 'UNAUTHENTICATED', err.message);
    }
    d.limiter.succeed(ip);
    setSessionCookie(c, token);
    d.log.info(`Login from ${displayIp(ip)}`);
    const state: AuthState = {
      authenticated: true,
      trustedNetwork: trusted,
      loginAvailable: true,
      username: d.auth.adminName(),
      address: displayIp(ip),
    };
    return c.json(state);
  });

  app.post('/logout', (c) => {
    d.auth.logout(getCookie(c, SESSION_COOKIE));
    deleteCookie(c, SESSION_COOKIE, { path: '/', secure: isHttps(c) });
    const { ip, trusted } = clientAccess(c, d);
    const state: AuthState = {
      authenticated: trusted,
      trustedNetwork: trusted,
      loginAvailable: d.auth.hasAdmin(),
      username: null,
      address: displayIp(ip),
    };
    return c.json(state);
  });

  return app;
}

/** PUT/DELETE /api/auth/password, behind the access guard. */
export function passwordRoute(d: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.put('/', async (c) => {
    const body = await readJson(
      c,
      z.object({
        username: username.optional(),
        currentPassword: password.optional(),
        newPassword: password,
      }),
    );
    if (c.get('trusted')) {
      // At home anyone can use tvspy anyway, so setting the password needs no old one.
      const name = body.username ?? d.auth.adminName() ?? 'admin';
      try {
        await d.auth.setPassword(name, body.newPassword);
      } catch (err) {
        weakPassword(err, 'newPassword');
      }
      d.log.info(`Password for other networks set for "${name}"`);
      return c.body(null, 204);
    }
    const token = c.get('token');
    if (!token) throw new ApiError(401, 'UNAUTHENTICATED', 'Please log in');
    if (!body.currentPassword) {
      throw new ApiError(400, 'VALIDATION', 'Enter your current password', {
        currentPassword: 'Enter your current password',
      });
    }
    try {
      await d.auth.changePassword(token, body.currentPassword, body.newPassword);
    } catch (err) {
      if (err instanceof AuthError && err.reason === 'bad_credentials') {
        throw new ApiError(400, 'VALIDATION', err.message, { currentPassword: err.message });
      }
      weakPassword(err, 'newPassword');
    }
    d.log.info('Password changed; other sessions ended');
    return c.body(null, 204);
  });

  app.delete('/', (c) => {
    if (!c.get('trusted')) {
      throw new ApiError(403, 'FORBIDDEN', 'The password can only be removed from your home network');
    }
    d.auth.removeAdmin();
    d.log.info('Password removed; tvspy now only opens from trusted networks');
    return c.body(null, 204);
  });

  return app;
}
