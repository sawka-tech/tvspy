// Display formatting. Times are shown in the server's time zone (where the viewers and the admin live),
// whatever the browser's zone is.

export function formatDuration(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

/** A running clock for live sessions: 0:42, 12:05, 1:02:03. */
export function formatClock(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export function formatBytes(bytes: number): string {
  const b = Math.max(0, bytes);
  if (b < 1e3) return `${b} B`;
  if (b < 1e6) return `${Math.round(b / 1e3)} kB`;
  if (b < 1e9) return `${(b / 1e6).toFixed(b < 1e7 ? 1 : 0)} MB`;
  if (b < 1e12) return `${(b / 1e9).toFixed(b < 1e10 ? 2 : 1)} GB`;
  return `${(b / 1e12).toFixed(2)} TB`;
}

export function formatBitrate(bps: number): string {
  if (bps <= 0) return '0 Mbit/s';
  if (bps < 1e6) return `${Math.round(bps / 1e3)} kbit/s`;
  return `${(bps / 1e6).toFixed(1)} Mbit/s`;
}

export const formatDb = (v: number | null, unit = 'dB') => (v === null ? '–' : `${v.toFixed(1)} ${unit}`);

const formatters = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${tz}|${JSON.stringify(opts)}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, ...opts });
    formatters.set(key, f);
  }
  return f;
}

export function formatTime(iso: string, tz: string): string {
  return fmt(tz, { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

/** "7 Oct 21:03", with the year when it is not the current one. */
export function formatDateTime(iso: string, tz: string, now = new Date()): string {
  const d = new Date(iso);
  const sameYear = fmt(tz, { year: 'numeric' }).format(d) === fmt(tz, { year: 'numeric' }).format(now);
  const date = fmt(
    tz,
    sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' },
  ).format(d);
  return `${date} ${formatTime(iso, tz)}`;
}

export function formatDate(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return fmt('UTC', { day: 'numeric', month: 'short', year: 'numeric' }).format(
    new Date(Date.UTC(y, m - 1, d)),
  );
}

/** "just now", "5 min ago", "3 h ago", or the date for older times. */
export function formatAgo(iso: string, nowMs: number, tz: string): string {
  const sec = (nowMs - Date.parse(iso)) / 1000;
  if (sec < 45) return 'just now';
  if (sec < 3600) return `${Math.round(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)} h ago`;
  return formatDateTime(iso, tz, new Date(nowMs));
}

/** Today's date (YYYY-MM-DD) in a zone, optionally shifted by whole days. */
export function localDay(tz: string, nowMs = Date.now(), shiftDays = 0): string {
  const parts = fmt(tz, { year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(nowMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const d = new Date(Date.UTC(get('year'), get('month') - 1, get('day') + shiftDays));
  return d.toISOString().slice(0, 10);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;
}
