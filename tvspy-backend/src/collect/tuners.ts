// Tuner state from TVH's /api/status/inputs: current mux, lock and quality per tuner (for the Live page)
// and per-minute reception statistics per mux and tuner (stored from day one for the Reception page).

import type { TvhInput } from '../core/tvhParse.js';
import type { DB } from '../db/open.js';

/** Weight of the strongest subscription on a tuner: user streams and recordings are >= 10, EPG grab/scans <= 7. */
export const USER_WEIGHT = 10;

/** TVH lists IPTV (internet streams) as an input named "IPTV" while one plays; it is not a tuner. */
export const isIptvInput = (name: string) => /^IPTV\b/i.test(name.trim());
const HISTORY_SEC = 15 * 60;

export interface TunerSnapshot {
  name: string;
  input: TvhInput;
  seenAt: number;
}

interface MinuteAgg {
  ts: number;
  mux: string;
  tuner: string;
  n: number;
  nLocked: number;
  subsMax: number;
  weightMax: number;
  snr: number[];
  signal: number[];
  berMax: number | null;
  unc: number;
  te: number;
  cc: number;
  bpsSum: number;
}

/** Last error counters per tuner; they are cumulative per mux instance and restart at 0 on every tune. */
interface Counters {
  mux: string | null;
  unc: number;
  te: number;
  cc: number;
}

const median = (v: number[]): number | null => {
  if (v.length === 0) return null;
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};
const round1 = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);

export class TunerMonitor {
  private latest = new Map<string, TunerSnapshot>();
  private history = new Map<string, [number, number | null][]>();
  private minute: number | null = null;
  private aggs = new Map<string, MinuteAgg>();
  private lastCounters = new Map<string, Counters>();
  private finished: MinuteAgg[] = [];

  /** Applies one poll. TVH lists one entry per tuned mux per tuner and one empty entry per idle tuner. */
  update(inputs: readonly TvhInput[], now: number): void {
    const byTuner = new Map<string, TvhInput>();
    for (const input of inputs) {
      const prev = byTuner.get(input.tuner);
      // Prefer the entry with a mux, then the busier one.
      if (!prev || (input.mux && (!prev.mux || input.subs > prev.subs))) byTuner.set(input.tuner, input);
    }

    this.rollMinute(now);
    this.minute = Math.floor(now / 60) * 60;

    for (const [tuner, input] of byTuner) {
      this.latest.set(tuner, { name: tuner, input, seenAt: now });
      const hist = this.history.get(tuner) ?? [];
      hist.push([now, input.mux && input.locked ? input.snrDb : null]);
      while (hist.length > 0 && (hist[0] as [number, number | null])[0] < now - HISTORY_SEC) hist.shift();
      this.history.set(tuner, hist);
      if (input.mux) this.sample(tuner, input);
      else this.lastCounters.set(tuner, { mux: null, unc: 0, te: 0, cc: 0 });
    }
    // A tuner missing from the poll (unplugged) starts over when it comes back.
    for (const tuner of this.lastCounters.keys()) if (!byTuner.has(tuner)) this.lastCounters.delete(tuner);
  }

  private sample(tuner: string, input: TvhInput): void {
    const mux = input.mux as string;
    const key = `${mux}\u0000${tuner}`;
    let agg = this.aggs.get(key);
    if (!agg) {
      agg = {
        ts: this.minute ?? 0,
        mux,
        tuner,
        n: 0,
        nLocked: 0,
        subsMax: 0,
        weightMax: 0,
        snr: [],
        signal: [],
        berMax: null,
        unc: 0,
        te: 0,
        cc: 0,
        bpsSum: 0,
      };
      this.aggs.set(key, agg);
    }
    agg.n++;
    agg.subsMax = Math.max(agg.subsMax, input.subs);
    agg.weightMax = Math.max(agg.weightMax, input.weight);
    agg.bpsSum += input.bps;
    if (input.locked) {
      agg.nLocked++;
      if (input.snrDb !== null) agg.snr.push(input.snrDb);
    }
    if (input.signalDbm !== null) agg.signal.push(input.signalDbm);
    if (input.ber !== null) agg.berMax = Math.max(agg.berMax ?? 0, input.ber);

    // Unknown history (first poll after a start) counts nothing; a new mux instance counts from its 0.
    const prev = this.lastCounters.get(tuner);
    const delta = (cur: number, before: number) => (cur >= before ? cur - before : cur);
    if (prev && prev.mux === mux) {
      agg.unc += delta(input.unc, prev.unc);
      agg.te += delta(input.te, prev.te);
      agg.cc += delta(input.cc, prev.cc);
    } else if (prev) {
      agg.unc += input.unc;
      agg.te += input.te;
      agg.cc += input.cc;
    }
    this.lastCounters.set(tuner, { mux, unc: input.unc, te: input.te, cc: input.cc });
  }

  /** Moves aggregates of minutes before `now`'s minute to the write queue. */
  private rollMinute(now: number): void {
    if (this.minute === null || Math.floor(now / 60) * 60 === this.minute) return;
    for (const agg of this.aggs.values()) this.finished.push(agg);
    this.aggs.clear();
  }

  /**
   * Writes completed minutes to reception_minute and refreshes the tuner registry. `final` also writes
   * the minute in progress (on shutdown).
   */
  flush(db: DB, now: number, final = false): void {
    if (final) {
      for (const agg of this.aggs.values()) this.finished.push(agg);
      this.aggs.clear();
    } else {
      this.rollMinute(now);
    }
    const done = this.finished.splice(0);
    db.transaction(() => {
      const insert = db.prepare(`
        INSERT OR REPLACE INTO reception_minute
          (mux, tuner, ts, n, n_locked, subs_max, weight_max, snr_min, snr_avg, snr_max, sig_min, sig_med, sig_max,
           ber_max, unc, te, cc, bps_avg)
        VALUES (@mux, @tuner, @ts, @n, @nLocked, @subsMax, @weightMax, @snrMin, @snrAvg, @snrMax, @sigMin, @sigMed,
          @sigMax, @berMax, @unc, @te, @cc, @bpsAvg)`);
      for (const a of done) {
        insert.run({
          mux: a.mux,
          tuner: a.tuner,
          ts: a.ts,
          n: a.n,
          nLocked: a.nLocked,
          subsMax: a.subsMax,
          weightMax: a.weightMax,
          snrMin: a.snr.length ? Math.min(...a.snr) : null,
          snrAvg: a.snr.length ? round1(a.snr.reduce((x, y) => x + y, 0) / a.snr.length) : null,
          snrMax: a.snr.length ? Math.max(...a.snr) : null,
          sigMin: a.signal.length ? Math.min(...a.signal) : null,
          sigMed: round1(median(a.signal)),
          sigMax: a.signal.length ? Math.max(...a.signal) : null,
          berMax: a.berMax,
          unc: a.unc,
          te: a.te,
          cc: a.cc,
          bpsAvg: a.n > 0 ? Math.round(a.bpsSum / a.n) : null,
        });
      }
      const tuners = db.prepare(
        `INSERT INTO tuners (name, first_seen, last_seen) VALUES (?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET last_seen = excluded.last_seen`,
      );
      for (const t of this.latest.values()) if (t.seenAt >= now - 60) tuners.run(t.name, t.seenAt, t.seenAt);
    })();
  }

  snapshots(now: number, maxAgeSec = 30): TunerSnapshot[] {
    return [...this.latest.values()].filter((t) => t.seenAt >= now - maxAgeSec);
  }

  snrHistory(tuner: string): [number, number | null][] {
    return [...(this.history.get(tuner) ?? [])];
  }

  /** Tuners currently serving a viewer or a recording (internal jobs like the EPG grab don't count). */
  busyForUsers(now: number): number {
    return this.snapshots(now).filter((t) => t.input.mux && t.input.subs > 0 && t.input.weight >= USER_WEIGHT)
      .length;
  }
}
