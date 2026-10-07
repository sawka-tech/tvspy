import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { dayRange, hourStart, toDay } from '../../src/core/time.js';
import { splitInterval } from '../../src/core/usageSplit.js';

const WAW = 'Europe/Warsaw';
const at = (s: string) => Date.parse(s) / 1000;
const ZONES = ['Europe/Warsaw', 'UTC', 'America/New_York', 'Asia/Kolkata', 'Australia/Sydney'];

describe('splitInterval', () => {
  it('preserves seconds and bytes and keeps every segment inside one local hour', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: at('2026-01-01T00:00:00Z'), max: at('2028-01-01T00:00:00Z') }),
        fc.integer({ min: 0, max: 3 * 86_400 }),
        fc.integer({ min: 0, max: 50_000_000_000 }),
        fc.constantFrom(...ZONES),
        (from, length, bytes, tz) => {
          const segs = splitInterval(from, from + length, bytes, tz);
          expect(segs.reduce((sum, s) => sum + s.secs, 0)).toBe(length);
          expect(segs.reduce((sum, s) => sum + s.bytes, 0)).toBe(bytes);
          let t = from;
          for (const s of segs) {
            expect(s.bytes).toBeGreaterThanOrEqual(0);
            expect(hourStart(t, tz)).toBe(s.hourStart);
            expect(t + s.secs).toBeLessThanOrEqual(s.hourStart + 3600);
            expect(toDay(s.hourStart, tz)).toBe(s.day);
            t += s.secs;
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it('splits a session crossing midnight into the right days', () => {
    // 23:30 → 00:45 local time (CEST): 30 min on 6 Oct, 45 min on 7 Oct.
    const segs = splitInterval(at('2026-10-06T21:30:00Z'), at('2026-10-06T22:45:00Z'), 7_500, WAW);
    expect(segs.map((s) => [s.day, s.hour, s.secs, s.bytes])).toEqual([
      ['2026-10-06', 23, 1800, 3000],
      ['2026-10-07', 0, 2700, 4500],
    ]);
  });

  it('gives 25 hourly buckets on the October DST day, with 02:00 twice', () => {
    const [start, end] = dayRange('2026-10-25', WAW);
    const segs = splitInterval(start, end, 0, WAW);
    expect(segs).toHaveLength(25);
    expect(segs.every((s) => s.day === '2026-10-25' && s.secs === 3600)).toBe(true);
    expect(segs.filter((s) => s.hour === 2)).toHaveLength(2);
  });

  it('gives 23 hourly buckets on the March DST day', () => {
    const [start, end] = dayRange('2027-03-28', WAW);
    expect(splitInterval(start, end, 0, WAW)).toHaveLength(23);
  });

  it('keeps bytes of a zero-length interval', () => {
    expect(splitInterval(1_000, 1_000, 500, WAW)).toEqual([expect.objectContaining({ secs: 0, bytes: 500 })]);
    expect(splitInterval(1_000, 1_000, 0, WAW)).toEqual([]);
    expect(splitInterval(2_000, 1_000, 0, WAW)).toEqual([]);
  });
});
