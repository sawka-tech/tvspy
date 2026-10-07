import { describe, expect, it } from 'vitest';
import {
  addDays,
  dayRange,
  dayStart,
  eachDay,
  hourStart,
  isDay,
  isoWeek,
  periodRange,
  shiftPeriod,
  toDay,
  tzOffset,
} from '../../src/core/time.js';

const WAW = 'Europe/Warsaw';
const at = (s: string) => Date.parse(s) / 1000;

describe('time zone helpers', () => {
  it('knows the Warsaw offset in winter and summer', () => {
    expect(tzOffset(at('2026-01-15T12:00:00Z'), WAW)).toBe(3600);
    expect(tzOffset(at('2026-07-15T12:00:00Z'), WAW)).toBe(7200);
  });

  it('maps instants to local days', () => {
    expect(toDay(at('2026-10-06T22:30:00Z'), WAW)).toBe('2026-10-07');
    expect(toDay(at('2026-10-06T21:59:59Z'), WAW)).toBe('2026-10-06');
  });

  it('gives the 25-hour day of the October DST change', () => {
    const [start, end] = dayRange('2026-10-25', WAW);
    expect(start).toBe(at('2026-10-24T22:00:00Z'));
    expect(end).toBe(at('2026-10-25T23:00:00Z'));
    expect((end - start) / 3600).toBe(25);
  });

  it('gives the 23-hour day of the March DST change', () => {
    const [start, end] = dayRange('2027-03-28', WAW);
    expect(start).toBe(at('2027-03-27T23:00:00Z'));
    expect((end - start) / 3600).toBe(23);
  });

  it('keeps the repeated 02:00 hour in October as two separate hours', () => {
    expect(hourStart(at('2026-10-25T00:30:00Z'), WAW)).toBe(at('2026-10-25T00:00:00Z'));
    expect(hourStart(at('2026-10-25T01:30:00Z'), WAW)).toBe(at('2026-10-25T01:00:00Z'));
  });

  it('aligns hours in half-hour zones', () => {
    expect(hourStart(at('2026-10-07T10:10:00Z'), 'Asia/Kolkata')).toBe(at('2026-10-07T09:30:00Z'));
  });

  it('computes ISO weeks, including week 53', () => {
    expect(isoWeek('2026-10-07')).toEqual({ year: 2026, week: 41 });
    expect(isoWeek('2026-12-28')).toEqual({ year: 2026, week: 53 });
    expect(isoWeek('2027-01-03')).toEqual({ year: 2026, week: 53 });
    expect(isoWeek('2027-01-04')).toEqual({ year: 2027, week: 1 });
  });

  it('resolves and shifts periods', () => {
    expect(periodRange('day', '2026-10-07')).toEqual({ from: '2026-10-07', to: '2026-10-07' });
    expect(periodRange('week', '2026-10-07')).toEqual({ from: '2026-10-05', to: '2026-10-11' });
    expect(periodRange('month', '2026-02-10')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(periodRange('month', '2028-02-10')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(periodRange('year', '2026-10-07')).toEqual({ from: '2026-01-01', to: '2026-12-31' });
    expect(shiftPeriod('month', '2026-01-31', 1)).toBe('2026-02-01');
    expect(shiftPeriod('month', '2026-01-15', -1)).toBe('2025-12-01');
    expect(shiftPeriod('week', '2026-10-07', -1)).toBe('2026-09-28');
    expect(shiftPeriod('year', '2026-10-07', 1)).toBe('2027-01-01');
  });

  it('validates and walks days', () => {
    expect(isDay('2026-02-29')).toBe(false);
    expect(isDay('2028-02-29')).toBe(true);
    expect(isDay('2026-1-07')).toBe(false);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(eachDay('2026-10-30', '2026-11-02')).toEqual([
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
    ]);
  });

  it('does not depend on the process time zone', () => {
    expect(process.env.TZ).toBe('Pacific/Kiritimati');
    expect(dayStart('2026-10-07', WAW)).toBe(at('2026-10-06T22:00:00Z'));
  });
});
