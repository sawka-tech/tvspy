import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AuthState, Live, Sessions, Settings, Status, Tuners } from '@tvspy/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/App';

const NOW = '2026-10-07T19:00:00.000Z';

const status: Status = {
  version: '4.0.0',
  commit: 'abc1234',
  timezone: 'Europe/Warsaw',
  serverTime: NOW,
  thresholds: { snrGoodDb: 26, snrCriticalDb: 20 },
  tvh: { configured: true, connected: true, lastOkAt: NOW, downSince: null, error: null, version: '4.3' },
  tuners: { inUse: 1, detected: 2, expected: 2 },
  activeStreams: 1,
  telegram: { enabled: false, configured: false, blocked: 'Telegram is not configured' },
};

const live: Live = {
  serverTime: NOW,
  tvh: status.tvh,
  sessions: [
    {
      id: 7,
      kind: 'playback',
      user: 'kapi',
      channel: { id: null, name: 'TVP1' },
      mux: { name: '490MHz', label: 'MUX-3', freqMHz: 490 },
      tuner: 'Si2168 #0',
      app: {
        app: 'SparkleTV',
        version: '1.9.6',
        device: 'Fire TV Stick 4K',
        platform: 'Android 7.1.2',
        raw: 'SparkleTV/1.9.6',
      },
      source: { ip: null, route: 'proxy', country: null },
      startedAt: '2026-10-07T18:00:00.000Z',
      rateBps: 4_800_000,
      bytes: 2_100_000_000,
      errors: 0,
      rateHistory: [4e6, 5e6, 4.8e6],
      title: 'HTTP',
    },
  ],
};

const tuners: Tuners = {
  serverTime: NOW,
  expected: 2,
  tuners: [
    {
      name: 'Silicon Labs Si2168 #0 : DVB-T #0',
      label: 'Si2168 #0',
      state: 'streaming',
      mux: { name: '490MHz', label: 'MUX-3', freqMHz: 490 },
      locked: true,
      subscriptions: 1,
      snrDb: 31.5,
      signalDbm: -54,
      snrPct: null,
      signalPct: null,
      rateBps: 5_000_000,
      snrHistory: [[Date.parse(NOW) / 1000 - 10, 31.5]],
    },
    {
      name: 'Old : DVB-T #0',
      label: 'Old',
      state: 'missing',
      mux: null,
      locked: null,
      subscriptions: 0,
      snrDb: null,
      signalDbm: null,
      snrPct: null,
      signalPct: null,
      rateBps: null,
      snrHistory: [],
    },
  ],
};

const settings = { monitoring: { minSessionSec: 10 } } as Settings;
const empty: Sessions = {
  items: [],
  total: 0,
  page: 1,
  pageSize: 6,
  summary: { sessions: 0, visits: 0, watchSec: 0, bytes: 0 },
};

function serve(auth: AuthState, extra: Record<string, unknown> = {}) {
  const routes: Record<string, unknown> = {
    '/api/auth': auth,
    '/api/status': status,
    '/api/live': live,
    '/api/tuners': tuners,
    '/api/settings': settings,
    '/api/sessions': empty,
    ...extra,
  };
  const calls: { method: string; path: string; body?: unknown }[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const path = url.split('?')[0] as string;
    calls.push({
      method: init.method ?? 'GET',
      path,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    const body = routes[`${init.method ?? 'GET'} ${path}`] ?? routes[path];
    if (body === undefined)
      return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'nope' } }), { status: 404 });
    return new Response(JSON.stringify(body), { status: 200 });
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('app', () => {
  it('asks for the setup code before anything else', async () => {
    const calls = serve(
      { authenticated: false, setupRequired: true, username: null },
      { 'POST /api/auth/setup': { authenticated: true, setupRequired: false, username: 'kacper' } },
    );
    render(<App client={createQueryClient()} />);
    expect(await screen.findByRole('heading', { name: 'Create the admin account' })).toBeTruthy();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Setup code'), 'abcd-efgh');
    await user.type(screen.getByLabelText('User name'), 'kacper');
    await user.type(screen.getByLabelText('Password'), 'long enough pw');
    await user.type(screen.getByLabelText('Repeat password'), 'long enough pw');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.path === '/api/auth/setup')).toBe(true),
    );
    expect(calls.find((c) => c.path === '/api/auth/setup')?.body).toEqual({
      setupCode: 'abcd-efgh',
      username: 'kacper',
      password: 'long enough pw',
    });
  });

  it('shows the live view with streams and tuners once logged in', async () => {
    serve({ authenticated: true, setupRequired: false, username: 'kacper' });
    render(<App client={createQueryClient()} />);
    expect(await screen.findByRole('heading', { name: 'Live' })).toBeTruthy();
    expect(await screen.findByText('kapi')).toBeTruthy();
    expect(screen.getByText('HTTPS proxy')).toBeTruthy();
    expect(screen.getByText('SparkleTV 1.9.6')).toBeTruthy();
    expect(await screen.findByText('31.5 dB')).toBeTruthy();
    expect(screen.getByText('Missing')).toBeTruthy();
    expect(screen.getByText('1 of 2')).toBeTruthy();
  });
});
