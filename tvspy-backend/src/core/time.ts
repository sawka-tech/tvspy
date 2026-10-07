// Time helpers. Instants are integer unix seconds; calendar days are 'YYYY-MM-DD' strings in an
// explicit IANA zone. Nothing here reads the process time zone.

export type Day = string;
export type Period = 'day' | 'week' | 'month' | 'year';

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

export function localParts(t: number, tz: string): LocalParts {
  const out: LocalParts = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  for (const p of formatter(tz).formatToParts(new Date(Math.floor(t) * 1000))) {
    if (p.type in out) out[p.type as keyof LocalParts] = Number(p.value);
  }
  return out;
}

/** Offset of `tz` from UTC at instant t, in seconds (Europe/Warsaw: 3600 in winter, 7200 in summer). */
export function tzOffset(t: number, tz: string): number {
  const s = Math.floor(t);
  const p = localParts(s, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000 - s;
}

const mod = (a: number, n: number) => ((a % n) + n) % n;
const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Start of the local hour containing t. Local hours are real one-hour intervals, so a day with a DST
 * change has 23 or 25 of them (the repeated 02:00 hour in October gets its own bucket).
 */
export function hourStart(t: number, tz: string): number {
  const s = Math.floor(t);
  return s - mod(s + tzOffset(s, tz), 3600);
}

export function toDay(t: number, tz: string): Day {
  const p = localParts(t, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isDay(s: string): boolean {
  const m = DAY_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export function parseDay(day: Day): [number, number, number] {
  if (!isDay(day)) throw new RangeError(`Invalid day: ${day}`);
  return [Number(day.slice(0, 4)), Number(day.slice(5, 7)), Number(day.slice(8, 10))];
}

function dayFromUtcMs(ms: number): Day {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function addDays(day: Day, n: number): Day {
  const [y, m, d] = parseDay(day);
  return dayFromUtcMs(Date.UTC(y, m - 1, d + n));
}

export function daysBetween(from: Day, to: Day): number {
  const [y1, m1, d1] = parseDay(from);
  const [y2, m2, d2] = parseDay(to);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}

/** Instant at which local `day` begins. */
export function dayStart(day: Day, tz: string): number {
  const [y, m, d] = parseDay(day);
  const utcMidnight = Date.UTC(y, m - 1, d) / 1000;
  let t = utcMidnight - tzOffset(utcMidnight, tz);
  t = utcMidnight - tzOffset(t, tz);
  return t;
}

/** [start, end) instants of local `day`; 23 h or 25 h long on DST days. */
export function dayRange(day: Day, tz: string): [number, number] {
  return [dayStart(day, tz), dayStart(addDays(day, 1), tz)];
}

/** ISO weekday, 1 = Monday … 7 = Sunday. */
export function isoWeekday(day: Day): number {
  const [y, m, d] = parseDay(day);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd === 0 ? 7 : wd;
}

export function isoWeekStart(day: Day): Day {
  return addDays(day, 1 - isoWeekday(day));
}

/** ISO 8601 week: weeks start on Monday; week 1 contains the year's first Thursday. */
export function isoWeek(day: Day): { year: number; week: number } {
  const thursday = addDays(day, 4 - isoWeekday(day));
  const year = parseDay(thursday)[0];
  const week1 = isoWeekStart(`${year}-01-04`);
  return { year, week: Math.floor(daysBetween(week1, day) / 7) + 1 };
}

/** Inclusive first and last day of the period containing `date`. */
export function periodRange(period: Period, date: Day): { from: Day; to: Day } {
  const [y, m] = parseDay(date);
  switch (period) {
    case 'day':
      return { from: date, to: date };
    case 'week': {
      const from = isoWeekStart(date);
      return { from, to: addDays(from, 6) };
    }
    case 'month':
      return { from: `${y}-${pad(m)}-01`, to: dayFromUtcMs(Date.UTC(y, m, 0)) };
    case 'year':
      return { from: `${y}-01-01`, to: `${y}-12-31` };
  }
}

/** Some day inside the period `n` periods away from the one containing `date` (n may be negative). */
export function shiftPeriod(period: Period, date: Day, n: number): Day {
  const [y, m] = parseDay(date);
  switch (period) {
    case 'day':
      return addDays(date, n);
    case 'week':
      return addDays(isoWeekStart(date), 7 * n);
    case 'month':
      return dayFromUtcMs(Date.UTC(y, m - 1 + n, 1));
    case 'year':
      return `${y + n}-01-01`;
  }
}

/** Every day from `from` to `to`, inclusive. */
export function eachDay(from: Day, to: Day): Day[] {
  const n = daysBetween(from, to);
  const out: Day[] = [];
  for (let i = 0; i <= n; i++) out.push(addDays(from, i));
  return out;
}
