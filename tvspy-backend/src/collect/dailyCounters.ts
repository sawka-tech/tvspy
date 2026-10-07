// Per-day coverage (how long tvspy was monitoring and TVH reachable) and live peak concurrency.

import { toDay } from '../core/time.js';
import type { DB } from '../db/open.js';

/** Longest gap between ticks still counted; a longer pause (tvspy stopped) is not "monitored". */
const MAX_TICK_SEC = 15;

interface DayConc {
  peakStreams: number;
  peakStreamsAt: number | null;
  peakTuners: number;
  peakTunersAt: number | null;
  tunersTotal: number;
  saturatedS: number;
  failedWhileFull: number;
}

export class DailyCounters {
  private coverage = new Map<string, { monitored: number; up: number }>();
  private conc = new Map<string, DayConc>();
  private lastTick: number | null = null;

  constructor(private readonly tz: () => string) {}

  /** Called after every subscriptions poll attempt. */
  tick(
    now: number,
    state: { tvhUp: boolean; streams: number; busyTuners: number; totalTuners: number },
  ): void {
    const day = toDay(now, this.tz());
    const dt = this.lastTick === null ? 0 : Math.max(0, Math.min(now - this.lastTick, MAX_TICK_SEC));
    this.lastTick = now;

    const cov = this.coverage.get(day) ?? { monitored: 0, up: 0 };
    cov.monitored += dt;
    if (state.tvhUp) cov.up += dt;
    this.coverage.set(day, cov);

    if (!state.tvhUp) return;
    const c = this.conc.get(day) ?? {
      peakStreams: 0,
      peakStreamsAt: null,
      peakTuners: 0,
      peakTunersAt: null,
      tunersTotal: 0,
      saturatedS: 0,
      failedWhileFull: 0,
    };
    if (state.streams > c.peakStreams) {
      c.peakStreams = state.streams;
      c.peakStreamsAt = now;
    }
    if (state.busyTuners > c.peakTuners) {
      c.peakTuners = state.busyTuners;
      c.peakTunersAt = now;
    }
    c.tunersTotal = Math.max(c.tunersTotal, state.totalTuners);
    if (state.totalTuners > 0 && state.busyTuners >= state.totalTuners) c.saturatedS += dt;
    this.conc.set(day, c);
  }

  failedWhileFull(now: number): void {
    const c = this.conc.get(toDay(now, this.tz()));
    if (c) c.failedWhileFull++;
  }

  flush(db: DB): void {
    const coverage = [...this.coverage];
    const conc = [...this.conc];
    this.coverage.clear();
    this.conc.clear();
    db.transaction(() => {
      const cov = db.prepare(`
        INSERT INTO coverage_daily (day, source, monitored_s, tvh_up_s) VALUES (?, 'live', ?, ?)
        ON CONFLICT (day) DO UPDATE SET source = 'live',
          monitored_s = COALESCE(monitored_s, 0) + excluded.monitored_s,
          tvh_up_s = COALESCE(tvh_up_s, 0) + excluded.tvh_up_s`);
      for (const [day, c] of coverage) cov.run(day, c.monitored, c.up);

      // Live days win over the historical sweep; on the switch-over day both parts merge via MAX.
      const peak = db.prepare(`
        INSERT INTO concurrency_daily (day, source, peak_streams, peak_streams_at, peak_tuners, peak_tuners_at,
          tuners_total, saturated_s, failed_while_full)
        VALUES (@day, 'live', @peakStreams, @peakStreamsAt, @peakTuners, @peakTunersAt, @tunersTotal, @saturatedS,
          @failedWhileFull)
        ON CONFLICT (day) DO UPDATE SET source = 'live',
          peak_streams_at = CASE WHEN excluded.peak_streams > peak_streams THEN excluded.peak_streams_at ELSE peak_streams_at END,
          peak_streams = MAX(peak_streams, excluded.peak_streams),
          peak_tuners_at = CASE WHEN excluded.peak_tuners > peak_tuners THEN excluded.peak_tuners_at ELSE peak_tuners_at END,
          peak_tuners = MAX(peak_tuners, excluded.peak_tuners),
          tuners_total = MAX(COALESCE(tuners_total, 0), excluded.tuners_total),
          saturated_s = saturated_s + excluded.saturated_s,
          failed_while_full = failed_while_full + excluded.failed_while_full`);
      for (const [day, c] of conc) peak.run({ day, ...c });
    })();
  }
}
