import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Live } from '@tvspy/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CH_TVN,
  CH_TVP1,
  catalogFixture,
  type FakeTvh,
  idleInput,
  input,
  startFakeTvh,
  subscription,
  TUNER_A,
  TUNER_B,
} from '../support/fakeTvh.js';
import { type Harness, harness, T0 } from '../support/harness.js';

let tvh: FakeTvh;
let h: Harness;
beforeEach(async () => {
  tvh = await startFakeTvh(catalogFixture());
  h = harness();
  h.settings.update({ 'tvh.url': tvh.url, 'tvh.username': 'spy', 'tvh.password': 'secret-pass' });
});
afterEach(async () => {
  await h.monitor.stop();
  h.cleanup();
  await tvh.close();
});

describe('monitor against a TVHeadend', () => {
  it('reads streams, tuners, the catalog and logos with Digest auth', async () => {
    tvh.state.subscriptions = [subscription({ id: 5, start: T0 - 30, total_out: 2_000_000 })];
    tvh.state.inputs = [
      input(),
      idleInput(TUNER_B),
      input({ input: 'IPTV', stream: 'VOX FM in radio', snr: 0, snr_scale: 0, signal_scale: 0 }),
    ];
    await h.monitor.pollSubscriptions();
    await h.monitor.pollServerInfo();
    await h.monitor.refreshCatalog();
    await h.monitor.pollInputs();

    expect(h.tvh).toMatchObject({ connected: true, version: '4.3-2345~gabcdef' });
    expect(h.tracker.open.size).toBe(1);
    expect(h.tuners.snapshots(T0).map((t) => t.name)).toEqual([TUNER_A, TUNER_B]); // not the IPTV input
    expect(h.db.prepare('SELECT name, mux FROM channels ORDER BY name').all()).toEqual([
      { name: 'TVN', mux: '530MHz' },
      { name: 'TVP1', mux: '490MHz' },
      { name: 'VOX FM', mux: 'VOX FM' },
    ]);
    // The internet radio (IPTV, no frequency) has a channel but no reception to monitor.
    expect(h.catalog.monitoredMuxes().map((m) => [m.name, m.freqMHz])).toEqual([
      ['490MHz', 490],
      ['530MHz', 530],
    ]);
    // One challenge, then every request is authenticated.
    expect(tvh.state.requests.filter((r) => r.authorization === null)).toHaveLength(1);
    expect(tvh.state.requests.filter((r) => r.authorization?.startsWith('Digest '))).toHaveLength(6);
    const live = (await (await h.call('GET', '/api/live')).json()) as Live;
    expect(live.sessions[0]?.channel).toEqual({ id: CH_TVP1, name: 'TVP1' });

    const icon = await h.call('GET', `/api/channels/${CH_TVP1}/icon`);
    expect(icon.status).toBe(200);
    expect(icon.headers.get('content-type')).toBe('image/png');
    expect(existsSync(join(h.dataDir, 'cache', 'logos', CH_TVP1))).toBe(true);
    expect((await h.call('GET', `/api/channels/${CH_TVN}/icon`)).status).toBe(404); // SVG refused
    expect((await h.call('GET', '/api/channels/not-a-uuid/icon')).status).toBe(404);
    const fetched = tvh.state.requests.filter((r) => r.path.startsWith('/imagecache/')).length;
    await h.call('GET', `/api/channels/${CH_TVP1}/icon`);
    expect(tvh.state.requests.filter((r) => r.path.startsWith('/imagecache/')).length).toBe(fetched); // cached
  });

  it('keeps sessions open while TVHeadend is down and closes them at their last sighting', async () => {
    const sub = subscription({ id: 5, start: T0 - 30, total_out: 1_000_000 });
    tvh.state.subscriptions = [sub];
    await h.monitor.pollSubscriptions();
    h.clock.now = T0 + 3;
    sub.total_out = 2_000_000;
    await h.monitor.pollSubscriptions();

    tvh.state.down = true;
    h.clock.now = T0 + 6;
    await h.monitor.pollSubscriptions();
    expect(h.tvh.connected).toBe(false);
    expect(h.tvh.downSince).toBe(T0 + 6);
    expect(h.tracker.open.size).toBe(1);

    tvh.state.down = false;
    tvh.state.subscriptions = [];
    h.clock.now = T0 + 60;
    await h.monitor.pollSubscriptions();
    expect(h.tracker.open.size).toBe(0);
    expect(h.db.prepare('SELECT started_at, ended_at, bytes, outcome FROM sessions').get()).toEqual({
      started_at: T0 - 30,
      ended_at: T0 + 3,
      bytes: 2_000_000,
      outcome: 'ok',
    });
    const usage = h.db.prepare('SELECT SUM(watch_s) AS s, SUM(bytes) AS b FROM usage_hourly').get();
    expect(usage).toEqual({ s: 33, b: 2_000_000 });
  });

  it('reports a rejected login and recovers when the password is fixed', async () => {
    h.settings.update({ 'tvh.password': 'wrong' });
    await h.monitor.pollSubscriptions();
    expect(h.tvh).toMatchObject({ connected: false, errorKind: 'auth' });
    h.settings.update({ 'tvh.password': 'secret-pass' });
    await h.monitor.pollSubscriptions();
    expect(h.tvh.connected).toBe(true);
  });

  it('runs on its own timers and flushes everything when stopped', async () => {
    tvh.state.subscriptions = [subscription({ id: 9, start: T0 - 10, total_out: 500_000 })];
    h.monitor.start();
    for (let i = 0; i < 50 && h.tracker.open.size === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(h.tracker.open.size).toBe(1);
    await h.monitor.stop();
    expect(h.db.prepare('SELECT bytes, last_seen_at FROM sessions').get()).toEqual({
      bytes: 500_000,
      last_seen_at: T0,
    });
    expect(h.db.prepare('SELECT SUM(watch_s) AS s FROM usage_hourly').get()).toEqual({ s: 10 });
  });
});
