// Turns player user-agent strings into app / version / device / platform.
// Example: "SparkleTV/1.9.6 (AFTMM, Android 7.1.2)" → SparkleTV 1.9.6 on a Fire TV Stick 4K, Android 7.1.2.

export interface ClientInfo {
  app: string;
  version: string | null;
  device: string | null;
  platform: string | null;
}

const APPS: [RegExp, string][] = [
  [/^sparkle\s*tv/i, 'SparkleTV'],
  [/^tivimate/i, 'TiviMate'],
  [/^(?:lib)?vlc/i, 'VLC'],
  [/^kodi/i, 'Kodi'],
  [/^tvh(?:client|guide)/i, 'TVHClient'],
  [/^jellyfin/i, 'Jellyfin'],
  [/^plex/i, 'Plex'],
  [/^exoplayer/i, 'ExoPlayer'],
  [/^(?:lavf|ffmpeg)/i, 'FFmpeg'],
  [/^okhttp/i, 'okhttp'],
  [/^curl/i, 'curl'],
  [/^mozilla/i, 'Browser'],
];

// Amazon model codes reported by Fire TV devices.
const FIRE_TV: Record<string, string> = {
  AFTMM: 'Fire TV Stick 4K',
  AFTKA: 'Fire TV Stick 4K Max',
  AFTKM: 'Fire TV Stick 4K (2nd gen)',
  AFTKRT: 'Fire TV Stick 4K Max (2nd gen)',
  AFTSSS: 'Fire TV Stick (3rd gen)',
  AFTSS: 'Fire TV Stick Lite',
  AFTT: 'Fire TV Stick (2nd gen)',
  AFTN: 'Fire TV (3rd gen)',
  AFTR: 'Fire TV Cube (2nd gen)',
  AFTGAZL: 'Fire TV Cube (3rd gen)',
};

const PLATFORM_RE = /\b(Android|iOS|iPadOS|tvOS|Windows|Linux|Mac ?OS(?: X)?|webOS|Tizen)\b/i;

export function parseClient(raw: string | null | undefined): ClientInfo | null {
  const s = raw?.trim();
  if (!s) return null;

  const name = (/^[^/(]+/.exec(s)?.[0] ?? s).trim();
  const version = /^[^/(]+\/([^\s(;]+)/.exec(s)?.[1] ?? null;
  const app = APPS.find(([re]) => re.test(name))?.[1] ?? name;

  let device: string | null = null;
  let platform: string | null = null;
  const details = /\(([^)]*)\)/.exec(s)?.[1];
  if (details) {
    for (const token of details
      .split(/[;,]/)
      .map((t) => t.trim())
      .filter(Boolean)) {
      if (!platform && PLATFORM_RE.test(token)) platform = token;
      else if (!device && /^[A-Za-z0-9 _.-]{2,40}$/.test(token) && !/^(?:U|wv|K)$/.test(token)) {
        device = FIRE_TV[token] ?? token;
      }
    }
  }
  return { app, version, device, platform };
}
