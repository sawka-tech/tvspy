import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type ConcurrencySession, sweepConcurrency } from '../../src/core/concurrency.js';
import { toDay } from '../../src/core/time.js';
import { assignVisits } from '../../src/core/visits.js';

const WAW = 'Europe/Warsaw';
const at = (s: string) => Date.parse(s) / 1000;

describe('visits', () => {
  it('merges zapping of one user in one app and splits on longer gaps', () => {
    const t0 = at('2026-10-07T18:00:00Z');
    const visits = assignVisits([
      { id: 1, user: 'kapi', app: 'SparkleTV', start: t0, end: t0 + 20 },
      { id: 2, user: 'kapi', app: 'SparkleTV', start: t0 + 25, end: t0 + 40 },
      { id: 3, user: 'kapi', app: 'SparkleTV', start: t0 + 95, end: t0 + 3600 },
      { id: 4, user: 'kapi', app: 'SparkleTV', start: t0 + 3700, end: t0 + 4000 },
      { id: 5, user: 'kapi', app: 'VLC', start: t0 + 30, end: t0 + 60 },
      { id: 6, user: 'dept', app: 'SparkleTV', start: t0 + 10, end: t0 + 50 },
    ]);
    expect(Object.fromEntries(visits)).toEqual({ 1: 1, 2: 1, 3: 1, 4: 4, 5: 5, 6: 6 });
  });
});

/** Second-by-second reference implementation for windows that cross one midnight. */
function bruteForce(sessions: ConcurrencySession[], tunersTotal: number, midnight: number) {
  const days = new Map<string, { peakStreams: number; peakTuners: number; saturatedS: number }>();
  const from = Math.min(...sessions.map((s) => s.start));
  const to = Math.max(...sessions.map((s) => s.end));
  const before = toDay(midnight - 1, WAW);
  const after = toDay(midnight, WAW);
  for (let t = from; t < to; t++) {
    const active = sessions.filter((s) => s.start <= t && t < s.end);
    if (active.length === 0) continue;
    const tuners = new Set(active.map((s) => s.tunerKey)).size;
    const day = t < midnight ? before : after;
    const d = days.get(day) ?? { peakStreams: 0, peakTuners: 0, saturatedS: 0 };
    d.peakStreams = Math.max(d.peakStreams, active.length);
    d.peakTuners = Math.max(d.peakTuners, tuners);
    if (tuners >= tunersTotal) d.saturatedS++;
    days.set(day, d);
  }
  return days;
}

describe('concurrency sweep', () => {
  it('matches a brute-force count, including across midnight', { timeout: 30_000 }, () => {
    const base = at('2026-10-06T21:30:00Z'); // 23:30 local
    const midnight = at('2026-10-06T22:00:00Z');
    const session = fc
      .record({
        offset: fc.integer({ min: 0, max: 7200 }),
        length: fc.integer({ min: 1, max: 3000 }),
        tuner: fc.integer({ min: 0, max: 3 }),
      })
      .map(({ offset, length, tuner }) => ({
        start: base + offset,
        end: base + offset + length,
        tunerKey: `T${tuner}`,
      }));
    fc.assert(
      fc.property(
        fc.array(session, { minLength: 1, maxLength: 8 }),
        fc.integer({ min: 1, max: 3 }),
        (list, total) => {
          // Distinct viewers, so no zap clipping applies.
          const sessions = list.map((s, i) => ({ ...s, viewerKey: `viewer${i}` }));
          const expected = bruteForce(sessions, total, midnight);
          const actual = sweepConcurrency(sessions, WAW, total);
          expect(actual.map((d) => d.day).sort()).toEqual([...expected.keys()].sort());
          for (const d of actual) {
            const e = expected.get(d.day);
            expect(d.peakStreams).toBe(e?.peakStreams);
            expect(d.peakTuners).toBe(e?.peakTuners);
            expect(d.saturatedS).toBe(e?.saturatedS);
          }
        },
      ),
      { numRuns: 150 },
    );
  });

  it('counts viewers on one mux as one tuner and clips a viewer’s channel-switch overlap', () => {
    const t0 = at('2026-10-07T17:00:00Z');
    const result = sweepConcurrency(
      [
        { start: t0, end: t0 + 600, tunerKey: '490MHz', viewerKey: 'kapi' },
        { start: t0 + 598, end: t0 + 1200, tunerKey: '530MHz', viewerKey: 'kapi' }, // 2 s overlap: a switch
        { start: t0 + 100, end: t0 + 500, tunerKey: '490MHz', viewerKey: 'dept' },
      ],
      WAW,
      2,
    );
    expect(result).toEqual([
      expect.objectContaining({ day: '2026-10-07', peakStreams: 2, peakTuners: 1, saturatedS: 0 }),
    ]);
  });

  it('attributes a session ending exactly at midnight to the earlier day', () => {
    const midnight = at('2026-10-07T22:00:00Z'); // 00:00 on 8 Oct, Warsaw
    const result = sweepConcurrency(
      [{ start: midnight - 60, end: midnight, tunerKey: 'T0', viewerKey: 'a' }],
      WAW,
      2,
    );
    expect(result.map((d) => d.day)).toEqual(['2026-10-07']);
  });
});
