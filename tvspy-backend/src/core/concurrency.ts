// Peak concurrency per local day from a list of sessions (used to backfill history; live data is
// measured directly). Viewers on the same mux share one tuner, so tuners in use = distinct tuner keys.

import { addDays, type Day, dayStart, toDay } from './time.js';

export interface ConcurrencySession {
  start: number;
  end: number;
  /** Tuner name when known, else the mux, else something unique to the session. */
  tunerKey: string;
  /** user|ip|client: overlapping sessions of one viewer are channel switches, not two streams. */
  viewerKey: string;
}

export interface DayConcurrency {
  day: Day;
  peakStreams: number;
  peakStreamsAt: number | null;
  peakTuners: number;
  peakTunersAt: number | null;
  /** Seconds with every tuner in use. */
  saturatedS: number;
}

/** Overlaps up to this long between one viewer's sessions are treated as a channel switch. */
export const ZAP_OVERLAP_SEC = 5;

type EventKind = 0 | 1 | 2; // end, midnight, start — the order used for events at the same instant

interface SweepEvent {
  t: number;
  kind: EventKind;
  key: string;
}

function clipZapOverlaps(sessions: readonly ConcurrencySession[]): ConcurrencySession[] {
  const byViewer = new Map<string, ConcurrencySession[]>();
  for (const s of sessions) {
    if (s.end <= s.start) continue;
    const copy = { ...s };
    const list = byViewer.get(s.viewerKey);
    if (list) list.push(copy);
    else byViewer.set(s.viewerKey, [copy]);
  }
  const out: ConcurrencySession[] = [];
  for (const list of byViewer.values()) {
    list.sort((a, b) => a.start - b.start);
    for (let i = 0; i < list.length; i++) {
      const cur = list[i] as ConcurrencySession;
      const next = list[i + 1];
      if (next && next.start < cur.end && cur.end - next.start <= ZAP_OVERLAP_SEC) cur.end = next.start;
      if (cur.end > cur.start) out.push(cur);
    }
  }
  return out;
}

export function sweepConcurrency(
  sessions: readonly ConcurrencySession[],
  tz: string,
  tunersTotal: number,
): DayConcurrency[] {
  const clipped = clipZapOverlaps(sessions);
  if (clipped.length === 0) return [];

  const events: SweepEvent[] = [];
  let minT = Number.POSITIVE_INFINITY;
  let maxT = Number.NEGATIVE_INFINITY;
  for (const s of clipped) {
    events.push({ t: s.start, kind: 2, key: s.tunerKey }, { t: s.end, kind: 0, key: s.tunerKey });
    minT = Math.min(minT, s.start);
    maxT = Math.max(maxT, s.end);
  }
  for (let day = addDays(toDay(minT, tz), 1); dayStart(day, tz) <= maxT; day = addDays(day, 1)) {
    events.push({ t: dayStart(day, tz), kind: 1, key: '' });
  }
  events.sort((a, b) => a.t - b.t || a.kind - b.kind);

  const results = new Map<Day, DayConcurrency>();
  const tunerUse = new Map<string, number>();
  let streams = 0;
  let current: DayConcurrency | null = null;
  let lastT = minT;

  const record = (t: number) => {
    if (!current) return;
    const tuners = tunerUse.size;
    if (streams > current.peakStreams) {
      current.peakStreams = streams;
      current.peakStreamsAt = t;
    }
    if (tuners > current.peakTuners) {
      current.peakTuners = tuners;
      current.peakTunersAt = t;
    }
  };

  for (const ev of events) {
    if (current && tunersTotal > 0 && tunerUse.size >= tunersTotal) current.saturatedS += ev.t - lastT;
    lastT = ev.t;

    // A session occupies [start, end): an end exactly at midnight is the previous day's last moment.
    const day = toDay(ev.kind === 0 ? ev.t - 1 : ev.t, tz);
    if (!current || current.day !== day) {
      current = results.get(day) ?? {
        day,
        peakStreams: 0,
        peakStreamsAt: null,
        peakTuners: 0,
        peakTunersAt: null,
        saturatedS: 0,
      };
      results.set(day, current);
      record(ev.t);
    }

    if (ev.kind === 2) {
      streams++;
      tunerUse.set(ev.key, (tunerUse.get(ev.key) ?? 0) + 1);
    } else if (ev.kind === 0) {
      streams--;
      const left = (tunerUse.get(ev.key) ?? 1) - 1;
      if (left > 0) tunerUse.set(ev.key, left);
      else tunerUse.delete(ev.key);
    }
    record(ev.t);
  }

  return [...results.values()].filter((d) => d.peakStreams > 0 || d.saturatedS > 0);
}
