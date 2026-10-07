import { beforeEach, describe, expect, it } from 'vitest';
import { SessionTracker, type TrackedSession, type TrackerContext } from '../../src/collect/sessions.js';
import type { TvhSubscription } from '../../src/core/tvhParse.js';
import { migrate } from '../../src/db/migrate.js';
import { type DB, openDb } from '../../src/db/open.js';

const WAW = 'Europe/Warsaw';
const T0 = Date.parse('2026-10-07T21:59:00Z') / 1000; // 23:59 local

const ctx = (): TrackerContext => ({
  tz: WAW,
  proxyCidrs: ['172.17.0.0/16'],
  lanCidrs: ['192.168.0.0/16'],
  visitGapSec: 60,
  channelMux: (channel) => (channel === 'TVN' ? '530MHz' : null),
});

function sub(over: Partial<TvhSubscription> = {}): TvhSubscription {
  return {
    id: 7,
    start: T0,
    hostname: '77.65.111.65',
    username: 'kapi',
    client: 'SparkleTV/1.9.6 (AFTMM, Android 7.1.2)',
    title: 'HTTP',
    channel: 'TVP1',
    service: 'Silicon Labs Si2168 #0 : DVB-T #0/dvb-t/490MHz/TVP1',
    profile: 'pass',
    errors: 0,
    rateIn: 500_000,
    rateOut: 0,
    totalIn: 0,
    totalOut: 0,
    ...over,
  };
}

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
});

const row = (id: number) =>
  db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown>;
const usage = (id: number) =>
  db
    .prepare('SELECT day, hour, watch_s, bytes FROM usage_hourly WHERE session_id = ? ORDER BY hour_start')
    .all(id);

describe('live session tracking', () => {
  it('opens a session with device, route, tuner and mux', () => {
    const tracker = new SessionTracker(db, ctx);
    const { started } = tracker.update([sub()], T0 + 3);
    expect(started).toHaveLength(1);
    expect(row((started[0] as TrackedSession).id)).toMatchObject({
      source: 'live',
      kind: 'stream',
      username: 'kapi',
      app: 'SparkleTV',
      device: 'Fire TV Stick 4K',
      route: 'direct',
      tuner: 'Silicon Labs Si2168 #0 : DVB-T #0',
      mux: '490MHz',
      start_day: '2026-10-07',
      visit_id: (started[0] as TrackedSession).id,
      ended_at: null,
    });
  });

  it('accounts time and data per local hour, across midnight', () => {
    const tracker = new SessionTracker(db, ctx);
    const id = (tracker.update([sub({ totalIn: 1_000 })], T0 + 30).started[0] as TrackedSession).id;
    tracker.update([sub({ totalIn: 9_000 })], T0 + 90); // crosses 00:00 local at T0 + 60
    tracker.flush();
    expect(usage(id)).toEqual([
      { day: '2026-10-07', hour: 23, watch_s: 60, bytes: 1_000 + 4_000 },
      { day: '2026-10-08', hour: 0, watch_s: 30, bytes: 4_000 },
    ]);
    expect(row(id)).toMatchObject({ last_seen_at: T0 + 90, bytes: 9_000 });
  });

  it('closes a vanished session at the time it was last seen', () => {
    const ended: string[] = [];
    const tracker = new SessionTracker(db, ctx, {
      onEnd: (s, _at, outcome) => ended.push(`${s.id}:${outcome}`),
    });
    const id = (tracker.update([sub({ totalIn: 5_000_000 })], T0 + 30).started[0] as TrackedSession).id;
    tracker.update([], T0 + 33);
    expect(row(id)).toMatchObject({ ended_at: T0 + 30, outcome: 'ok', bytes: 5_000_000 });
    expect(ended).toEqual([`${id}:ok`]);
    expect(tracker.open.size).toBe(0);
  });

  it('marks a stream that delivered almost nothing as a failed start', () => {
    const tracker = new SessionTracker(db, ctx);
    const id = (tracker.update([sub({ totalIn: 1_000 })], T0 + 20).started[0] as TrackedSession).id;
    tracker.update([], T0 + 23);
    expect(row(id)).toMatchObject({ outcome: 'failed' });
  });

  it('resumes from the stored watermark after a restart', () => {
    const first = new SessionTracker(db, ctx);
    const id = (first.update([sub({ totalIn: 3_000 })], T0 + 30).started[0] as TrackedSession).id;
    first.flush();
    // tvspy restarts; TVH kept streaming meanwhile.
    const second = new SessionTracker(db, ctx);
    expect(second.open.size).toBe(1);
    second.update([sub({ totalIn: 9_000 })], T0 + 50);
    second.flush();
    expect(row(id)).toMatchObject({ last_seen_at: T0 + 50, bytes: 9_000 });
    const totals = db
      .prepare('SELECT SUM(watch_s) s, SUM(bytes) b FROM usage_hourly WHERE session_id = ?')
      .get(id);
    expect(totals).toEqual({ s: 50, b: 9_000 });
  });

  it('counts a reset volume counter from zero instead of going negative', () => {
    const tracker = new SessionTracker(db, ctx);
    const id = (tracker.update([sub({ totalIn: 10_000 })], T0 + 10).started[0] as TrackedSession).id;
    tracker.update([sub({ totalIn: 2_000 })], T0 + 20);
    tracker.flush();
    expect(row(id)).toMatchObject({ bytes: 12_000 });
  });

  it('ignores TVH-internal subscriptions and records DVR recordings', () => {
    const tracker = new SessionTracker(db, ctx);
    const { started } = tracker.update(
      [
        sub({ id: 1, hostname: null, title: 'epggrab', username: null }),
        sub({ id: 2, hostname: null, title: 'DVR: Fakty', username: 'admin', channel: 'TVN', service: null }),
      ],
      T0 + 5,
    );
    expect(started.map((s) => [s.kind, s.mux])).toEqual([['recording', '530MHz']]);
  });

  it('joins zapping into the previous visit and flags first-time devices and addresses', () => {
    const tracker = new SessionTracker(db, ctx);
    const a = tracker.update([sub({ id: 1, channel: 'TVN' })], T0 + 10).started[0] as TrackedSession;
    tracker.update([], T0 + 13);
    const b = tracker.update([sub({ id: 2, start: T0 + 40, channel: 'TVP1' })], T0 + 43)
      .started[0] as TrackedSession;
    expect(row(b.id).visit_id).toBe(a.id);
    expect([a.newDevice, a.newIp, b.newDevice, b.newIp]).toEqual([true, true, false, false]);
    const proxied = tracker.update([sub({ id: 3, start: T0 + 50, hostname: '172.17.0.7' })], T0 + 52)
      .started[0] as TrackedSession;
    expect(proxied.route).toBe('proxy');
  });
});
