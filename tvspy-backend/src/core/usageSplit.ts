import { type Day, hourStart, localParts } from './time.js';

export interface UsageSegment {
  /** Instant at which the local hour starts (unique even for the repeated hour on DST days). */
  hourStart: number;
  day: Day;
  hour: number;
  secs: number;
  bytes: number;
}

function segment(hs: number, secs: number, tz: string): UsageSegment {
  const p = localParts(hs, tz);
  const day = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  return { hourStart: hs, day, hour: p.hour, secs, bytes: 0 };
}

/**
 * Split [from, to) at local hour boundaries and spread `bytes` over it in proportion to time.
 *
 * Invariants (property-tested): the seconds add up to to - from, the bytes add up to `bytes`, and
 * every segment lies inside one local hour. Local midnight is an hour boundary, so per-day totals are
 * exact. A zero-length interval that still carries bytes yields a single 0-second segment.
 */
export function splitInterval(from: number, to: number, bytes: number, tz: string): UsageSegment[] {
  const start = Math.floor(from);
  const end = Math.max(start, Math.floor(to));
  const volume = Math.max(0, Math.floor(bytes));

  if (end === start) {
    if (volume === 0) return [];
    const seg = segment(hourStart(start, tz), 0, tz);
    seg.bytes = volume;
    return [seg];
  }

  const segs: UsageSegment[] = [];
  for (let t = start; t < end; ) {
    const hs = hourStart(t, tz);
    const segEnd = Math.min(hs + 3600, end);
    segs.push(segment(hs, segEnd - t, tz));
    t = segEnd;
  }

  const total = end - start;
  let given = 0;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i] as UsageSegment;
    seg.bytes = Math.floor((volume * seg.secs) / total);
    given += seg.bytes;
  }
  (segs[segs.length - 1] as UsageSegment).bytes = volume - given;
  return segs;
}
