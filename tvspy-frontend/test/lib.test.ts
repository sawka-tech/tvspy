import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, query } from '../src/lib/api';
import {
  formatBitrate,
  formatBytes,
  formatClock,
  formatDateTime,
  formatDuration,
  localDay,
} from '../src/lib/format';

describe('formatting', () => {
  it('formats durations, sizes and rates', () => {
    expect([0, 59, 60, 3599, 3600, 3720, 172_800, 180_000].map(formatDuration)).toEqual([
      '0 s',
      '59 s',
      '1 min',
      '59 min',
      '1 h',
      '1 h 2 min',
      '2 d',
      '2 d 2 h',
    ]);
    expect([42, 125, 3725].map(formatClock)).toEqual(['0:42', '2:05', '1:02:05']);
    expect([999, 1500, 2_500_000, 45_000_000, 3_210_000_000, 9.1e12].map(formatBytes)).toEqual([
      '999 B',
      '2 kB',
      '2.5 MB',
      '45 MB',
      '3.21 GB',
      '9.10 TB',
    ]);
    expect([0, 640_000, 4_830_000].map(formatBitrate)).toEqual(['0 Mbit/s', '640 kbit/s', '4.8 Mbit/s']);
  });

  it('shows times in the server zone and finds local days across the DST change', () => {
    expect(formatDateTime('2026-10-07T19:03:00Z', 'Europe/Warsaw', new Date('2026-10-08T00:00:00Z'))).toBe(
      '7 Oct 21:03',
    );
    // 23:30 UTC on New Year's Eve is already 2026 in Warsaw: same year as "now", so no year shown.
    expect(formatDateTime('2025-12-31T23:30:00Z', 'Europe/Warsaw', new Date('2026-10-08T00:00:00Z'))).toBe(
      '1 Jan 00:30',
    );
    expect(formatDateTime('2025-12-31T12:00:00Z', 'Europe/Warsaw', new Date('2026-10-08T00:00:00Z'))).toBe(
      '31 Dec 2025 13:00',
    );
    // 2026-10-25 has 25 hours in Warsaw; 23:30 UTC is already the 26th locally.
    const late = Date.parse('2026-10-25T23:30:00Z');
    expect(localDay('Europe/Warsaw', late)).toBe('2026-10-26');
    expect(localDay('Europe/Warsaw', late, -6)).toBe('2026-10-20');
  });
});

describe('API client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends JSON with the CSRF header on writes only', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    await api('GET', '/api/status');
    await api('PATCH', '/api/settings', { tvh: { url: 'http://x' } });
    expect(calls).toHaveLength(2);
    const [get, patch] = calls as [(typeof calls)[0], (typeof calls)[0]];
    expect((get.init.headers as Record<string, string>)['X-Tvspy-Csrf']).toBeUndefined();
    expect(patch.init.headers).toMatchObject({ 'X-Tvspy-Csrf': '1', 'Content-Type': 'application/json' });
    expect(patch.init.body).toBe('{"tvh":{"url":"http://x"}}');
    expect(patch.init.credentials).toBe('same-origin');
  });

  it('turns error bodies into ApiError with field messages', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'VALIDATION',
              message: 'Invalid settings',
              fields: { 'tvh.url': 'Use http(s)://host:port' },
            },
          }),
          { status: 400 },
        ),
    );
    const err = (await api('PATCH', '/api/settings', {}).catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 400,
      code: 'VALIDATION',
      fields: { 'tvh.url': 'Use http(s)://host:port' },
    });
  });

  it('reports an unreachable server and handles empty answers', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(api('GET', '/api/live')).rejects.toMatchObject({ code: 'NETWORK', status: 0 });
    vi.stubGlobal('fetch', async () => new Response(null, { status: 204 }));
    await expect(api('PUT', '/api/auth/password', {})).resolves.toBeUndefined();
  });

  it('builds query strings from set values only', () => {
    expect(query({ page: 2, user: '', q: 'a b', ended: true, kind: undefined, short: false })).toBe(
      '?page=2&q=a+b&ended=true',
    );
    expect(query({})).toBe('');
  });
});
