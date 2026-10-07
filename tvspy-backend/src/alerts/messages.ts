// Fixed English Telegram texts (HTML parse mode). Every value from TVH or a client is escaped.

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const b = (s: string | null | undefined, fallback = 'unknown') => `<b>${escapeHtml(s || fallback)}</b>`;

export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h >= 48) return h % 24 ? `${Math.floor(h / 24)} d ${h % 24} h` : `${Math.floor(h / 24)} d`;
  const rest = m % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1e6) return `${Math.round(bytes / 1e3)} kB`;
  if (bytes < 1e9) return `${Math.round(bytes / 1e6)} MB`;
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

export function formatClock(t: number, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(
    t * 1000,
  );
}

export interface SessionFacts {
  username: string | null;
  channel: string | null;
  title: string | null;
  app: string | null;
  device: string | null;
  platform: string | null;
  ip: string | null;
  route: 'proxy' | 'lan' | 'direct' | 'none';
}

function where(s: SessionFacts): string {
  const app = [s.app, s.device ?? s.platform].filter(Boolean).join(' on ');
  const source =
    s.route === 'proxy' ? 'via HTTPS proxy' : s.route === 'lan' ? `home network ${s.ip ?? ''}`.trim() : s.ip;
  return [app, source]
    .filter(Boolean)
    .map((v) => escapeHtml(v as string))
    .join(' · ');
}

export const messages = {
  playbackStart: (s: SessionFacts) =>
    `▶️ ${b(s.username, 'Anonymous')} is watching ${b(s.channel)}\n${where(s)}`,

  playbackStop: (s: SessionFacts, durationSec: number, bytes: number) =>
    `⏹ ${b(s.username, 'Anonymous')} stopped watching ${b(s.channel)} after ${formatDuration(durationSec)} (${formatBytes(bytes)})`,

  recordingStart: (s: SessionFacts) =>
    `⏺ Recording started: ${b(s.title?.replace(/^DVR:\s*/, ''), 'recording')} on ${b(s.channel)}`,

  recordingStop: (s: SessionFacts, durationSec: number, bytes: number, failed: boolean) =>
    failed
      ? `⚠️ Recording failed: ${b(s.title?.replace(/^DVR:\s*/, ''), 'recording')} on ${b(s.channel)} received almost no data`
      : `✅ Recording finished: ${b(s.title?.replace(/^DVR:\s*/, ''), 'recording')} on ${b(s.channel)}, ${formatDuration(durationSec)} (${formatBytes(bytes)})`,

  longWatch: (s: SessionFacts, durationSec: number) =>
    `⏰ ${b(s.username, 'Anonymous')} has been watching for ${formatDuration(durationSec)}, now ${b(s.channel)}`,

  tvhDown: (since: number, error: string | null, auth: boolean, tz: string) =>
    auth
      ? `🔴 TVHeadend rejects tvspy's login since ${formatClock(since, tz)}: ${escapeHtml(error ?? '')}\nCheck the user name and password in tvspy's settings.`
      : `🔴 TVHeadend is unreachable since ${formatClock(since, tz)}: ${escapeHtml(error ?? 'no answer')}`,

  tvhUp: (downSec: number) => `🟢 TVHeadend is reachable again after ${formatDuration(downSec)}`,

  muxStale: (mux: string, staleSec: number) =>
    `⚠️ No reception on ${b(mux)} for ${formatDuration(staleSec)}: no tuner could receive it, not even for the overnight guide update. Check the antenna and the transmitter.`,

  muxBack: (mux: string, staleSec: number) =>
    `✅ Reception on ${b(mux)} is back after ${formatDuration(staleSec)}`,

  test: () => '✅ tvspy test message: Telegram notifications work.',
};
