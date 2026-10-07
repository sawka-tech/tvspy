import { beforeEach, describe, expect, it } from 'vitest';
import { DailyCounters } from '../../src/collect/dailyCounters.js';
import { TunerMonitor } from '../../src/collect/tuners.js';
import { parseInput, type TvhInput } from '../../src/core/tvhParse.js';
import { migrate } from '../../src/db/migrate.js';
import { type DB, openDb } from '../../src/db/open.js';
import { idleInput, input, TUNER_A, TUNER_B } from '../support/fakeTvh.js';

const T0 = Date.parse('2026-10-07T18:00:00Z') / 1000; // a minute boundary
const inp = (over: Record<string, unknown> = {}) => parseInput(input(over)) as TvhInput;
const idle = (tuner: string) => parseInput(idleInput(tuner)) as TvhInput;

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
});

const minutes = () =>
  db
    .prepare(
      'SELECT mux, tuner, ts, n, n_locked, subs_max, weight_max, snr_min, snr_avg, snr_max, sig_med, unc, te, cc, bps_avg FROM reception_minute ORDER BY ts, tuner',
    )
    .all();

describe('tuner monitor', () => {
  it('reports the current state per tuner and counts only user streams as busy', () => {
    const m = new TunerMonitor();
    m.update([inp(), idle(TUNER_B)], T0);
    expect(m.snapshots(T0).map((t) => [t.name, t.input.mux])).toEqual([
      [TUNER_A, '490MHz'],
      [TUNER_B, null],
    ]);
    expect(m.busyForUsers(T0)).toBe(1);
    m.update([inp({ weight: 4 }), idle(TUNER_B)], T0 + 5); // EPG grab
    expect(m.busyForUsers(T0 + 5)).toBe(0);
    expect(m.snapshots(T0 + 60)).toEqual([]); // stale after 30 s without polls
  });

  it('prefers the tuned entry when TVH lists a tuner twice', () => {
    const m = new TunerMonitor();
    m.update([idle(TUNER_A), inp()], T0);
    expect(m.snapshots(T0)[0]?.input.mux).toBe('490MHz');
  });

  it('aggregates polls into one row per minute, mux and tuner', () => {
    const m = new TunerMonitor();
    m.update([inp({ snr: 34_000, signal: -56_000, bps: 4_000_000 })], T0);
    m.update([inp({ snr: 35_000, signal: -55_000, bps: 6_000_000 })], T0 + 5);
    m.update([inp({ snr: 0, snr_scale: 0, bps: 0, signal: -70_000 })], T0 + 10); // lost lock
    m.flush(db, T0 + 30);
    expect(minutes()).toEqual([]); // minute still running
    m.update([inp()], T0 + 61);
    m.flush(db, T0 + 61);
    expect(minutes()).toEqual([
      {
        mux: '490MHz',
        tuner: TUNER_A,
        ts: T0,
        n: 3,
        n_locked: 2,
        subs_max: 1,
        weight_max: 150,
        snr_min: 34,
        snr_avg: 34.5,
        snr_max: 35,
        sig_med: -56,
        unc: 0,
        te: 0,
        cc: 0,
        bps_avg: 3_333_333,
      },
    ]);
    m.flush(db, T0 + 70, true); // shutdown writes the minute in progress
    expect(minutes()).toHaveLength(2);
    expect(db.prepare('SELECT name FROM tuners').all()).toEqual([{ name: TUNER_A }]);
  });

  it('counts error deltas, starting over on a retune and after a counter reset', () => {
    const m = new TunerMonitor();
    m.update([inp({ unc: 100, te: 7 })], T0); // history unknown: nothing counted
    m.update([inp({ unc: 130, te: 7 })], T0 + 5); // +30
    m.update([inp({ unc: 5, te: 0 })], T0 + 10); // reset: +5
    m.update([inp({ stream: '530MHz in dvb-t', unc: 2 })], T0 + 15); // new mux instance: +2
    m.update([idle(TUNER_A)], T0 + 20);
    m.update([inp({ unc: 4 })], T0 + 25); // tuned again after idle: +4
    m.flush(db, T0 + 60);
    const rows = minutes() as { mux: string; unc: number; te: number }[];
    expect(rows.map((r) => [r.mux, r.unc, r.te])).toEqual([
      ['490MHz', 39, 0],
      ['530MHz', 2, 0],
    ]);
  });

  it('keeps 15 minutes of SNR history with gaps while unlocked', () => {
    const m = new TunerMonitor();
    m.update([inp()], T0);
    m.update([idle(TUNER_A)], T0 + 5);
    m.update([inp({ snr: 30_000 })], T0 + 16 * 60);
    expect(m.snrHistory(TUNER_A)).toEqual([[T0 + 16 * 60, 30]]);
    m.update([idle(TUNER_A)], T0 + 16 * 60 + 5);
    expect(m.snrHistory(TUNER_A).at(-1)).toEqual([T0 + 16 * 60 + 5, null]);
  });
});

describe('daily counters', () => {
  const tz = 'Europe/Warsaw';
  const MIDNIGHT = Date.parse('2026-10-07T22:00:00Z') / 1000; // 00:00 on 2026-10-08 local

  it('measures coverage, TVH uptime and peaks per local day', () => {
    const d = new DailyCounters(() => tz);
    let t = MIDNIGHT - 9;
    d.tick(t, { tvhUp: true, streams: 1, busyTuners: 1, totalTuners: 2 });
    for (const up of [true, true, false, true, true]) {
      t += 3;
      d.tick(t, { tvhUp: up, streams: up ? 2 : 0, busyTuners: up ? 2 : 0, totalTuners: 2 });
    }
    t += 100; // tvspy paused: only 15 s count
    d.tick(t, { tvhUp: true, streams: 1, busyTuners: 1, totalTuners: 2 });
    d.flush(db);
    expect(db.prepare('SELECT * FROM coverage_daily ORDER BY day').all()).toEqual([
      { day: '2026-10-07', source: 'live', monitored_s: 6, tvh_up_s: 6 },
      { day: '2026-10-08', source: 'live', monitored_s: 24, tvh_up_s: 21 },
    ]);
    const peaks = db.prepare('SELECT * FROM concurrency_daily ORDER BY day').all() as Record<
      string,
      unknown
    >[];
    expect(peaks[1]).toMatchObject({
      day: '2026-10-08',
      source: 'live',
      peak_streams: 2,
      peak_streams_at: MIDNIGHT + 3, // TVH was down at 00:00:00
      peak_tuners: 2,
      tuners_total: 2,
      saturated_s: 6,
    });
  });

  it('merges with earlier flushes and replaces the historical sweep for the day', () => {
    db.prepare(
      `INSERT INTO concurrency_daily (day, source, peak_streams, peak_streams_at, peak_tuners, peak_tuners_at, tuners_total)
       VALUES ('2026-10-08', 'sweep', 3, ?, 2, ?, 2)`,
    ).run(MIDNIGHT + 100, MIDNIGHT + 100);
    db.prepare(`INSERT INTO coverage_daily (day, source) VALUES ('2026-10-08', 'legacy')`).run();
    const d = new DailyCounters(() => tz);
    d.tick(MIDNIGHT + 1000, { tvhUp: true, streams: 1, busyTuners: 1, totalTuners: 2 });
    d.tick(MIDNIGHT + 1003, { tvhUp: true, streams: 4, busyTuners: 2, totalTuners: 2 });
    d.failedWhileFull(MIDNIGHT + 1003);
    d.flush(db);
    d.tick(MIDNIGHT + 1006, { tvhUp: true, streams: 1, busyTuners: 2, totalTuners: 2 });
    d.flush(db);
    expect(db.prepare(`SELECT * FROM concurrency_daily`).get()).toMatchObject({
      source: 'live',
      peak_streams: 4,
      peak_streams_at: MIDNIGHT + 1003,
      peak_tuners: 2,
      peak_tuners_at: MIDNIGHT + 100,
      saturated_s: 6,
      failed_while_full: 1,
    });
    expect(db.prepare(`SELECT * FROM coverage_daily`).get()).toEqual({
      day: '2026-10-08',
      source: 'live',
      monitored_s: 6,
      tvh_up_s: 6,
    });
  });
});
