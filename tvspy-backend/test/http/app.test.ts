import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Live, Sessions, Settings, Status, TestResult, Tuners } from '@tvspy/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  parseInput,
  parseSubscription,
  type TvhInput,
  type TvhSubscription,
} from '../../src/core/tvhParse.js';
import { type FakeTvh, input, startFakeTvh, subscription, TUNER_A, TUNER_B } from '../support/fakeTvh.js';
import { type Harness, harness, T0 } from '../support/harness.js';

let h: Harness;
afterEach(() => h?.cleanup());

const OUTSIDE = '203.0.113.7';
const PROXY = '172.17.0.5'; // Nginx Proxy Manager on the Docker bridge

describe('access', () => {
  beforeEach(() => {
    h = harness();
  });

  it('opens from the home network without any login', async () => {
    expect(await (await h.call('GET', '/api/auth')).json()).toEqual({
      authenticated: true,
      trustedNetwork: true,
      loginAvailable: false,
      username: null,
      address: '192.168.1.20',
    });
    expect((await h.call('GET', '/api/status')).status).toBe(200);
    // Node reports IPv4 clients of a dual-stack socket as ::ffff:a.b.c.d.
    expect((await h.call('GET', '/api/status', { ip: '::ffff:192.168.1.20' })).status).toBe(200);
    expect((await h.call('GET', '/api/status', { ip: '10.253.0.2' })).status).toBe(200); // VPN
  });

  it('refuses other networks, including the proxy, while no password is set', async () => {
    expect((await h.call('GET', '/api/health', { ip: OUTSIDE })).status).toBe(200);
    for (const ip of [OUTSIDE, PROXY]) {
      const res = await h.call('GET', '/api/status', { ip });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        error: { code: 'UNAUTHENTICATED', message: 'tvspy only opens from your home network' },
      });
    }
    expect(await (await h.call('GET', '/api/auth', { ip: PROXY })).json()).toMatchObject({
      authenticated: false,
      trustedNetwork: false,
      loginAvailable: false,
    });
    const login = await h.call('POST', '/api/auth/login', {
      body: { username: 'admin', password: 'whatever pw' },
      ip: OUTSIDE,
    });
    expect(login.status).toBe(401);
  });

  it('does not let a website reach it under its own host name (DNS rebinding)', async () => {
    const rebound = await h.call('GET', '/api/settings', { headers: { host: 'evil.example:8183' } });
    expect(rebound.status).toBe(401);
    await h.call('PATCH', '/api/settings', { body: { access: { hostnames: ['tower.local'] } } });
    expect((await h.call('GET', '/api/status', { headers: { host: 'TOWER.local:8183' } })).status).toBe(200);
    expect((await h.call('GET', '/api/status', { headers: { host: '[fd00::10]:8183' } })).status).toBe(200);
  });

  it('refuses access changes that would lock out the browser making them', async () => {
    const fields = async (body: unknown, headers?: Record<string, string>) => {
      const res = await h.call('PATCH', '/api/settings', { body, headers });
      expect(res.status).toBe(400);
      return ((await res.json()) as { error: { fields: Record<string, string> } }).error.fields;
    };
    expect(await fields({ access: { openNetworks: ['10.0.0.0/8'] } })).toEqual({
      'access.openNetworks': 'This would lock you out: your address 192.168.1.20 is not in the list',
    });
    await h.call('PATCH', '/api/settings', { body: { access: { hostnames: ['tower.local'] } } });
    expect(await fields({ access: { hostnames: [] } }, { host: 'tower.local:8183' })).toHaveProperty([
      'access.hostnames',
    ]);
    expect(await fields({ access: { openNetworks: ['not-a-network'] } })).toHaveProperty([
      'access.openNetworks',
    ]);
    const ok = await h.call('PATCH', '/api/settings', {
      body: { access: { openNetworks: ['192.168.1.0/24'] } },
    });
    expect(((await ok.json()) as Settings).access).toEqual({
      openNetworks: ['192.168.1.0/24'],
      hostnames: ['tower.local'],
    });
  });

  it('sets a password at home that then works from outside, with a strict cookie', async () => {
    expect(
      (await h.call('PUT', '/api/auth/password', { body: { username: 'kacper', newPassword: 'short' } }))
        .status,
    ).toBe(400);
    expect(
      (
        await h.call('PUT', '/api/auth/password', {
          body: { username: 'kacper', newPassword: 'long enough pw' },
        })
      ).status,
    ).toBe(204);
    expect(await (await h.call('GET', '/api/auth', { ip: OUTSIDE })).json()).toMatchObject({
      authenticated: false,
      loginAvailable: true,
    });
    const res = await h.call('POST', '/api/auth/login', {
      body: { username: 'kacper', password: 'long enough pw' },
      ip: OUTSIDE,
    });
    expect(res.status).toBe(200);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Max-Age=2592000/);
    expect(cookie).not.toMatch(/Secure/);
    expect((await h.call('GET', '/api/status', { ip: OUTSIDE })).status).toBe(200);
    expect((await h.call('GET', '/api/status', { ip: OUTSIDE, cookie: null })).status).toBe(401);
  });

  it('marks the cookie Secure behind an HTTPS proxy', async () => {
    await h.call('PUT', '/api/auth/password', {
      body: { username: 'kacper', newPassword: 'long enough pw' },
    });
    const res = await h.call('POST', '/api/auth/login', {
      body: { username: 'kacper', password: 'long enough pw' },
      ip: PROXY,
      headers: { 'x-forwarded-proto': 'https' },
    });
    expect(res.headers.get('set-cookie')).toMatch(/Secure/);
  });

  it('locks an address out after five wrong passwords', async () => {
    await h.call('PUT', '/api/auth/password', {
      body: { username: 'kacper', newPassword: 'long enough pw' },
    });
    const wrong = { username: 'kacper', password: 'wrong password' };
    for (let i = 0; i < 5; i++) {
      expect((await h.call('POST', '/api/auth/login', { body: wrong, ip: OUTSIDE })).status).toBe(401);
    }
    const res = await h.call('POST', '/api/auth/login', {
      body: { username: 'kacper', password: 'long enough pw' },
      ip: OUTSIDE,
    });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(800);
    const other = await h.call('POST', '/api/auth/login', {
      body: { username: 'kacper', password: 'long enough pw' },
      ip: '198.51.100.9',
    });
    expect(other.status).toBe(200);
  });

  it('changes the password from outside only with the current one; removes it only from home', async () => {
    await h.loginFromOutside();
    const missing = await h.call('PUT', '/api/auth/password', {
      body: { newPassword: 'another long pw' },
      ip: OUTSIDE,
    });
    expect(missing.status).toBe(400);
    const wrong = await h.call('PUT', '/api/auth/password', {
      body: { currentPassword: 'nope', newPassword: 'another long pw' },
      ip: OUTSIDE,
    });
    expect(
      ((await wrong.json()) as { error: { fields: Record<string, string> } }).error.fields,
    ).toHaveProperty('currentPassword');
    const changed = await h.call('PUT', '/api/auth/password', {
      body: { currentPassword: 'long enough pw', newPassword: 'another long pw' },
      ip: OUTSIDE,
    });
    expect(changed.status).toBe(204);
    expect((await h.call('DELETE', '/api/auth/password', { ip: OUTSIDE })).status).toBe(403);
    expect((await h.call('DELETE', '/api/auth/password')).status).toBe(204);
    expect((await h.call('GET', '/api/status', { ip: OUTSIDE })).status).toBe(401);
    expect(
      ((await (await h.call('GET', '/api/auth')).json()) as { loginAvailable: boolean }).loginAvailable,
    ).toBe(false);
  });

  it('logs out from outside', async () => {
    await h.loginFromOutside();
    expect((await h.call('POST', '/api/auth/logout', { ip: OUTSIDE })).status).toBe(200);
    expect((await h.call('GET', '/api/status', { ip: OUTSIDE })).status).toBe(401);
  });
});

describe('request guards', () => {
  beforeEach(async () => {
    h = harness();
  });

  it('refuses cross-origin and non-JSON writes', async () => {
    const body = { telegram: { chatId: '1' } };
    expect((await h.call('PATCH', '/api/settings', { body, origin: 'http://evil.example' })).status).toBe(
      403,
    );
    expect(
      (await h.call('PATCH', '/api/settings', { body, origin: 'http://192.168.1.10:8183' })).status,
    ).toBe(200);
    const form = await h.call('PATCH', '/api/settings', {
      body: 'a=1',
      contentType: 'application/x-www-form-urlencoded',
    });
    expect(form.status).toBe(415);
    expect((await h.call('PATCH', '/api/settings', { body: '{nope' })).status).toBe(400);
  });

  it('sends security headers and never caches API answers', async () => {
    const res = await h.call('GET', '/api/status');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('settings', () => {
  beforeEach(async () => {
    h = harness();
  });

  const SECRET = 'Sup3r-Secret-Passw0rd';
  const TOKEN = '987654:AAH-very_secret_token';

  it('never returns or logs secrets', async () => {
    const res = await h.call('PATCH', '/api/settings', {
      body: {
        tvh: { url: 'http://192.168.1.10:9981', username: 'spy', password: SECRET },
        telegram: { enabled: true, chatId: '42', botToken: TOKEN },
      },
    });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(TOKEN);
    const settings = (await (await h.call('GET', '/api/settings')).json()) as Settings;
    expect(settings.tvh).toEqual({ url: 'http://192.168.1.10:9981', username: 'spy', passwordSet: true });
    expect(settings.telegram).toEqual({ enabled: true, chatId: '42', botTokenSet: true });
    expect(JSON.stringify(settings)).not.toContain(SECRET);
    expect(h.log.recent().join('\n')).not.toContain(SECRET);

    await h.call('PATCH', '/api/settings', { body: { tvh: { password: null } } });
    expect(((await (await h.call('GET', '/api/settings')).json()) as Settings).tvh.passwordSet).toBe(false);
  });

  it('validates values and reports them by field', async () => {
    const bad = async (body: unknown) => {
      const res = await h.call('PATCH', '/api/settings', { body });
      expect(res.status).toBe(400);
      return ((await res.json()) as { error: { fields: Record<string, string> } }).error.fields;
    };
    expect(await bad({ tvh: { url: 'ftp://x' } })).toHaveProperty(['tvh.url']);
    expect(await bad({ monitoring: { lanCidrs: ['10.0.0.0/33'] } })).toHaveProperty(['monitoring.lanCidrs']);
    expect(await bad({ monitoring: { snrCriticalDb: 30 } })).toHaveProperty(['monitoring.snrCriticalDb']);
    expect(await bad({ rules: { longWatch: { limitMinutes: 0 } } })).toHaveProperty([
      'rules.longWatch.limitMinutes',
    ]);
    expect(await bad({ admin: true })).toBeDefined();
    expect(await bad({ tvh: { url: 'http://x', extra: 1 } })).toBeDefined();
    const after = (await (await h.call('GET', '/api/settings')).json()) as Settings;
    expect(after.tvh.url).toBe(''); // nothing applied
  });

  it('maps every field both ways', async () => {
    const patch = {
      monitoring: {
        tunersExpected: 4,
        snrGoodDb: 27,
        snrCriticalDb: 21,
        minSessionSec: 15,
        trustedIps: ['1.2.3.4'],
      },
      rules: {
        playbackStart: true,
        longWatch: { enabled: true, limitMinutes: 90 },
        tvhDown: false,
        muxStale: false,
      },
    };
    const s = (await (await h.call('PATCH', '/api/settings', { body: patch })).json()) as Settings;
    expect(s.monitoring).toMatchObject(patch.monitoring);
    expect(s.rules).toMatchObject({
      playbackStart: true,
      longWatch: { enabled: true, limitMinutes: 90 },
      tvhDown: false,
    });
    expect(h.settings.get('stats.minSessionSec')).toBe(15);
    expect(h.settings.get('reception.snrCriticalDb')).toBe(21);
  });
});

describe('history', () => {
  beforeEach(async () => {
    h = harness();
    const insert = h.db.prepare(
      `INSERT INTO sessions (id, sub_key, source, kind, username, channel, app, ip, route, started_at, start_day,
         last_seen_at, ended_at, bytes, errors, outcome, quality, visit_id)
       VALUES (?, ?, 'live', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    );
    insert.run(
      1,
      'a',
      'stream',
      'kapi',
      'TVP1',
      'SparkleTV',
      '77.65.1.1',
      'direct',
      T0,
      '2026-10-07',
      T0 + 600,
      T0 + 600,
      300e6,
      'ok',
      null,
      1,
    );
    insert.run(
      2,
      'b',
      'stream',
      'kapi',
      'TVN',
      'SparkleTV',
      '77.65.1.1',
      'direct',
      T0 + 610,
      '2026-10-07',
      T0 + 700,
      T0 + 700,
      50e6,
      'ok',
      null,
      1,
    );
    insert.run(
      3,
      'c',
      'stream',
      'ola',
      '50% Polsat',
      'VLC',
      '172.17.0.9',
      'proxy',
      T0 - 86400,
      '2026-10-06',
      T0,
      T0,
      5e9,
      'ok',
      'end_estimated',
      3,
    );
    insert.run(
      4,
      'd',
      'recording',
      null,
      'TVN',
      null,
      null,
      'none',
      T0 + 5,
      '2026-10-07',
      T0 + 9,
      T0 + 9,
      0,
      'failed',
      null,
      null,
    );
  });

  const get = async (q: string) => {
    const res = await h.call('GET', `/api/sessions${q}`);
    expect(res.status).toBe(200);
    return (await res.json()) as Sessions;
  };

  it('pages, sorts and summarises', async () => {
    const all = await get('');
    expect(all.items.map((s) => s.id)).toEqual([2, 4, 1, 3]);
    expect(all.summary).toEqual({ sessions: 4, visits: 2, watchSec: 600 + 90 + 86400 + 4, bytes: 5.35e9 });
    expect((await get('?sort=bytes&dir=asc&pageSize=2&page=2')).items.map((s) => s.id)).toEqual([1, 3]);
    expect((await get('?sort=durationSec')).items[0]?.durationSec).toBe(86400);
    const row = all.items.find((s) => s.id === 3);
    expect(row).toMatchObject({ estimated: true, source: { ip: null, route: 'proxy', country: null } });
  });

  it('filters', async () => {
    expect((await get('?kind=recording')).items.map((s) => s.id)).toEqual([4]);
    expect((await get('?user=kapi&channel=TVN')).items.map((s) => s.id)).toEqual([2]);
    expect((await get('?from=2026-10-07&to=2026-10-07&outcome=ok')).total).toBe(2);
    expect((await get('?minSec=100')).total).toBe(2);
    expect((await get('?q=50%25')).items.map((s) => s.id)).toEqual([3]); // literal %, not a wildcard
    expect((await get('?q=_')).total).toBe(0);
    expect((await get('?visit=1')).total).toBe(2);
  });

  it('treats injection attempts as data or rejects them', async () => {
    expect((await get(`?q=${encodeURIComponent("x' OR 1=1 --")}`)).total).toBe(0);
    expect((await get(`?user=${encodeURIComponent("kapi' OR '1'='1")}`)).total).toBe(0);
    for (const q of [
      '?sort=bytes;DROP TABLE sessions',
      '?dir=sideways',
      '?from=2026-13-01',
      '?pageSize=100000',
      '?page=0',
    ]) {
      expect((await h.call('GET', `/api/sessions${q}`)).status).toBe(400);
    }
    expect((await get('')).total).toBe(4);
  });

  it('returns single sessions and lookups', async () => {
    expect(((await (await h.call('GET', '/api/sessions/3')).json()) as { id: number }).id).toBe(3);
    expect((await h.call('GET', '/api/sessions/99')).status).toBe(404);
    expect((await h.call('GET', '/api/sessions/abc')).status).toBe(404);
    const lookups = await (await h.call('GET', '/api/lookups')).json();
    expect(lookups).toEqual({
      users: ['kapi', 'ola'],
      channels: [
        { id: null, name: '50% Polsat' },
        { id: null, name: 'TVN' },
        { id: null, name: 'TVP1' },
      ],
      apps: ['SparkleTV', 'VLC'],
      dataFrom: '2026-10-06',
    });
  });
});

describe('live view', () => {
  beforeEach(async () => {
    h = harness();
  });

  it('shows open sessions, hiding the proxy address', async () => {
    const subs = [
      subscription({ id: 1, start: T0 - 60, hostname: '77.65.111.65', total_out: 1e6 }),
      subscription({ id: 2, start: T0 - 30, hostname: '172.17.0.5', username: 'ola', channel: 'TVN' }),
    ].map((s) => parseSubscription(s) as TvhSubscription);
    h.tvh.markOk(T0);
    h.tracker.update(subs, T0);
    const live = (await (await h.call('GET', '/api/live')).json()) as Live;
    expect(live.tvh.connected).toBe(true);
    expect(live.sessions.map((s) => [s.user, s.source.route, s.source.ip])).toEqual([
      ['ola', 'proxy', null],
      ['kapi', 'direct', '77.65.111.65'],
    ]);
    expect(live.sessions[1]).toMatchObject({
      kind: 'playback',
      channel: { name: 'TVP1' },
      mux: { name: '490MHz', freqMHz: 490 },
      app: { app: 'SparkleTV', device: 'Fire TV Stick 4K' },
    });
    const status = (await (await h.call('GET', '/api/status')).json()) as Status;
    expect(status).toMatchObject({ activeStreams: 2, timezone: 'Europe/Warsaw', commit: 'abc1234' });
  });

  it('lists tuners with their state, including one that disappeared', async () => {
    h.db
      .prepare('INSERT INTO tuners (name, first_seen, last_seen) VALUES (?, ?, ?)')
      .run('Old stick : DVB-T #0', T0 - 86400, T0 - 3600);
    const inputs = [input(), input({ input: TUNER_B, stream: '530MHz in dvb-t', weight: 4 })].map(
      (i) => parseInput(i) as TvhInput,
    );
    h.tuners.update(inputs, T0);
    const tuners = (await (await h.call('GET', '/api/tuners')).json()) as Tuners;
    expect(tuners.tuners.map((t) => [t.label, t.state, t.snrDb])).toEqual([
      ['Old stick', 'missing', null],
      ['Si2168 #0', 'streaming', 34.5],
      ['Si2168 #1', 'internal', 34.5],
    ]);
    expect(tuners.expected).toBe(2);
    expect(tuners.tuners[1]?.snrHistory).toEqual([[T0, 34.5]]);
    expect(TUNER_A).toContain('Si2168 #0');
  });
});

describe('connection tests', () => {
  let tvh: FakeTvh;
  let other: FakeTvh;
  beforeEach(async () => {
    tvh = await startFakeTvh();
    other = await startFakeTvh({ auth: 'basic' });
  });
  afterEach(async () => {
    await tvh.close();
    await other.close();
  });

  it('tests TVHeadend with Digest auth and reports what it found', async () => {
    h = harness();
    tvh.state.inputs = [input(), input({ input: TUNER_B })];
    tvh.state.channels = [{ uuid: 'a'.repeat(32), name: 'TVP1', enabled: true, services: [] }];
    const res = (await (
      await h.call('POST', '/api/settings/tvh/test', {
        body: { url: tvh.url, username: 'spy', password: 'secret-pass' },
      })
    ).json()) as TestResult;
    expect(res).toEqual({
      ok: true,
      detail: 'TVHeadend 4.3-2345~gabcdef: 2 tuners, 1 channels',
      tvh: { version: '4.3-2345~gabcdef', tuners: 2, channels: 1, admin: true },
    });
    tvh.state.admin = false;
    const limited = (await (
      await h.call('POST', '/api/settings/tvh/test', {
        body: { url: tvh.url, username: 'spy', password: 'secret-pass' },
      })
    ).json()) as TestResult;
    expect(limited).toMatchObject({ ok: false, message: expect.stringContaining('admin rights') });
    const wrong = (await (
      await h.call('POST', '/api/settings/tvh/test', {
        body: { url: tvh.url, username: 'spy', password: 'nope' },
      })
    ).json()) as TestResult;
    expect(wrong).toMatchObject({ ok: false, message: expect.stringContaining('401') });
  });

  it('sends the stored password only to the stored server', async () => {
    h = harness();
    await h.call('PATCH', '/api/settings', {
      body: { tvh: { url: tvh.url, username: 'spy', password: 'secret-pass' } },
    });
    expect(
      ((await (await h.call('POST', '/api/settings/tvh/test', { body: {} })).json()) as TestResult).ok,
    ).toBe(true);
    await h.call('POST', '/api/settings/tvh/test', { body: { url: other.url } });
    const sent = other.state.requests.map((r) =>
      Buffer.from((r.authorization ?? 'Basic ').slice(6), 'base64').toString(),
    );
    expect(sent.join('|')).not.toContain('secret-pass');
  });

  it('tests Telegram, unless switched off for the container', async () => {
    const calls: string[] = [];
    h = harness({
      telegramFetch: async (url) => {
        calls.push(url);
        return new Response(JSON.stringify({ ok: true }));
      },
    });
    const ok = (await (
      await h.call('POST', '/api/settings/telegram/test', { body: { botToken: '1:abc', chatId: '42' } })
    ).json()) as TestResult;
    expect(ok).toEqual({ ok: true, detail: 'Test message sent' });
    expect(calls).toEqual(['https://api.telegram.org/bot1:abc/sendMessage']);
    h.cleanup();
    h = harness({ telegramAllowed: false });
    const off = (await (
      await h.call('POST', '/api/settings/telegram/test', { body: { botToken: '1:abc', chatId: '42' } })
    ).json()) as TestResult;
    expect(off).toMatchObject({ ok: false });
  });
});

describe('frontend files', () => {
  let dir: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tvspy-public-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>tvspy</title>');
    writeFileSync(join(dir, 'assets', 'app-abc123.js'), 'console.log(1)');
    h = harness({ publicDir: dir });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('serves the app shell for client routes and caches hashed assets', async () => {
    const index = await h.call('GET', '/');
    expect(index.headers.get('cache-control')).toBe('no-cache');
    expect(index.headers.get('content-type')).toContain('text/html');
    expect(index.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(await (await h.call('GET', '/history?user=kapi')).text()).toContain('<title>tvspy</title>');
    const asset = await h.call('GET', '/assets/app-abc123.js');
    expect(asset.headers.get('cache-control')).toContain('immutable');
    expect(asset.headers.get('content-type')).toContain('text/javascript');
    expect((await h.call('GET', '/assets/missing.js')).status).toBe(404);
    // Encoded slashes survive URL parsing and must not escape the directory.
    expect((await h.call('GET', '/assets/..%2f..%2f..%2f..%2fetc%2fpasswd')).status).toBe(404);
    // Encoded dots are normalised by URL parsing to /etc/passwd, which is just a client route here.
    expect(await (await h.call('GET', '/%2e%2e/%2e%2e/etc/passwd')).text()).toContain('<title>tvspy</title>');
    expect((await h.call('GET', '/api/unknown')).status).toBe(404);
    expect((await h.call('GET', '/api/unknown', { ip: '203.0.113.7' })).status).toBe(401);
  });
});
