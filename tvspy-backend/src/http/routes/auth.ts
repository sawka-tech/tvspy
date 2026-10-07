import type { AuthState } from '@tvspy/shared';
import { type Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { AuthError, PASSWORD_MAX, SESSION_COOKIE, SESSION_DAYS, USERNAME_MAX } from '../../auth/service.js';
import { ApiError, type AppDeps, type AppEnv, clientIp, readJson } from '../support.js';

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

function authError(err: unknown, passwordField: string): never {
  if (!(err instanceof AuthError)) throw err;
  switch (err.reason) {
    case 'weak_password':
      throw new ApiError(400, 'VALIDATION', err.message, { [passwordField]: err.message });
    case 'already_set_up':
      throw new ApiError(409, 'CONFLICT', err.message);
    default:
      throw new ApiError(401, 'UNAUTHENTICATED', err.message);
  }
}

export function authRoutes(d: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  const state = (c: Context<AppEnv>): AuthState => {
    const s = d.auth.session(getCookie(c, SESSION_COOKIE));
    return {
      authenticated: s !== null,
      setupRequired: d.auth.setupRequired(),
      username: s?.username ?? null,
    };
  };

  /** Login and setup share the limiter: both are guesses at a secret. */
  const limited = async (c: Context<AppEnv>, attempt: () => Promise<string>, passwordField: string) => {
    const ip = clientIp(c);
    const now = d.now();
    const wait = d.limiter.retryAfter(ip, now);
    if (wait > 0) {
      throw new ApiError(
        429,
        'RATE_LIMITED',
        `Too many failed attempts; try again in ${Math.ceil(wait / 60)} min`,
        undefined,
        {
          'Retry-After': String(wait),
        },
      );
    }
    let token: string;
    try {
      token = await attempt();
    } catch (err) {
      if (err instanceof AuthError && (err.reason === 'bad_credentials' || err.reason === 'bad_setup_code')) {
        d.limiter.fail(ip, now);
        d.log.warn(`Failed ${err.reason === 'bad_setup_code' ? 'setup' : 'login'} from ${ip}`);
      }
      authError(err, passwordField);
    }
    d.limiter.succeed(ip);
    setSessionCookie(c, token);
  };

  app.get('/', (c) => c.json(state(c)));

  app.post('/login', async (c) => {
    const body = await readJson(c, z.object({ username, password }));
    await limited(
      c,
      () =>
        d.auth.login(body.username, body.password, {
          ip: clientIp(c),
          userAgent: c.req.header('user-agent') ?? null,
        }),
      'password',
    );
    d.log.info(`Login from ${clientIp(c)}`);
    return c.json({ authenticated: true, setupRequired: false, username: body.username } satisfies AuthState);
  });

  app.post('/setup', async (c) => {
    const body = await readJson(
      c,
      z.object({ setupCode: z.string().trim().min(1, 'Enter the setup code').max(20), username, password }),
    );
    await limited(
      c,
      () =>
        d.auth.setup(body.setupCode, body.username, body.password, {
          ip: clientIp(c),
          userAgent: c.req.header('user-agent') ?? null,
        }),
      'password',
    );
    d.log.info(`Admin account "${body.username}" created from ${clientIp(c)}`);
    return c.json({ authenticated: true, setupRequired: false, username: body.username } satisfies AuthState);
  });

  app.post('/logout', (c) => {
    d.auth.logout(getCookie(c, SESSION_COOKIE));
    deleteCookie(c, SESSION_COOKIE, { path: '/', secure: isHttps(c) });
    return c.json({
      authenticated: false,
      setupRequired: d.auth.setupRequired(),
      username: null,
    } satisfies AuthState);
  });

  return app;
}

/** PUT /api/auth/password, mounted behind the auth guard. */
export function passwordRoute(d: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.put('/', async (c) => {
    const body = await readJson(c, z.object({ currentPassword: password, newPassword: password }));
    try {
      await d.auth.changePassword(c.get('token'), body.currentPassword, body.newPassword);
    } catch (err) {
      if (err instanceof AuthError && err.reason === 'bad_credentials') {
        throw new ApiError(400, 'VALIDATION', err.message, { currentPassword: err.message });
      }
      authError(err, 'newPassword');
    }
    d.log.info('Admin password changed; other sessions ended');
    return c.body(null, 204);
  });
  return app;
}
