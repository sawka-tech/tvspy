// Builds the real service graph on an in-memory database with a controllable clock, and a request helper
// that behaves like the browser frontend (CSRF header, JSON, session cookie).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FetchLike } from '../../src/alerts/telegram.js';
import { migrate } from '../../src/db/migrate.js';
import { openDb } from '../../src/db/open.js';
import type { AppEnv } from '../../src/http/support.js';
import { createLogger } from '../../src/log.js';
import { createServices } from '../../src/services.js';
import { SettingsStore } from '../../src/settings/store.js';

export const T0 = Date.parse('2026-10-07T18:00:00Z') / 1000;

export interface HarnessOptions {
  publicDir?: string | null;
  telegramAllowed?: boolean;
  telegramFetch?: FetchLike;
}

export interface CallOptions {
  body?: unknown;
  cookie?: string | null;
  csrf?: boolean;
  origin?: string;
  contentType?: string;
  ip?: string;
  headers?: Record<string, string>;
}

export function harness(opts: HarnessOptions = {}) {
  const db = openDb(':memory:');
  migrate(db);
  const dataDir = mkdtempSync(join(tmpdir(), 'tvspy-test-'));
  const clock = { now: T0 };
  const settings = new SettingsStore(db);
  const log = createLogger('error');
  const services = createServices({
    db,
    settings,
    log,
    dataDir,
    tz: 'Europe/Warsaw',
    version: '4.0.0-test',
    commit: 'abc1234',
    telegramAllowed: opts.telegramAllowed ?? true,
    publicDir: opts.publicDir ?? null,
    now: () => clock.now,
    scryptCost: 1024,
    telegramFetch: opts.telegramFetch,
  });

  let cookie: string | null = null;
  const call = async (method: string, path: string, o: CallOptions = {}) => {
    const headers: Record<string, string> = { host: 'tvspy.local', ...o.headers };
    if (o.csrf ?? true) headers['x-tvspy-csrf'] = '1';
    if (o.origin) headers.origin = o.origin;
    const body =
      o.body === undefined ? undefined : typeof o.body === 'string' ? o.body : JSON.stringify(o.body);
    if (body !== undefined) {
      headers['content-type'] = o.contentType ?? 'application/json';
      headers['content-length'] = String(Buffer.byteLength(body));
    }
    const sendCookie = o.cookie === undefined ? cookie : o.cookie;
    if (sendCookie) headers.cookie = `tvspy_session=${sendCookie}`;
    const env = {
      incoming: { socket: { remoteAddress: o.ip ?? '192.168.1.20' } },
    } as unknown as AppEnv['Bindings'];
    const res = await services.app.request(`http://tvspy.local${path}`, { method, headers, body }, env);
    const set = res.headers.get('set-cookie');
    const m = set ? /tvspy_session=([^;]*)/.exec(set) : null;
    if (m) cookie = m[1] || null;
    return res;
  };

  /** Creates the admin and keeps its session cookie for later calls. */
  const login = async () => {
    const code = services.auth.pendingSetupCode();
    if (code) {
      await call('POST', '/api/auth/setup', {
        body: { setupCode: code, username: 'kacper', password: 'long enough pw' },
      });
    } else {
      await call('POST', '/api/auth/login', { body: { username: 'kacper', password: 'long enough pw' } });
    }
    return cookie;
  };

  return {
    ...services,
    db,
    settings,
    log,
    dataDir,
    clock,
    call,
    login,
    get cookie() {
      return cookie;
    },
    cleanup: () => {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export type Harness = ReturnType<typeof harness>;
