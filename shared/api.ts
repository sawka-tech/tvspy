// API contract between the tvspy backend and frontend (types only; nothing here exists at runtime).
//
// Conventions: JSON with camelCase keys. Instants are ISO-8601 UTC strings; calendar parameters are
// 'YYYY-MM-DD' in the server time zone (Status.timezone). Durations are whole seconds (…Sec), data is
// bytes, rates are bits per second (…Bps), SNR in dB and signal in dBm. Errors are
// { error: { code, message, fields? } }. Secrets are never returned: settings expose `…Set` flags; in a
// PATCH an omitted field is unchanged, null clears it, a string sets it.

export type ISO = string;
export type LocalDate = string;
export type Kind = 'playback' | 'recording';
export type Period = 'day' | 'week' | 'month' | 'year';
export type Route = 'proxy' | 'lan' | 'direct' | 'none';

export type ErrorCode =
  | 'VALIDATION'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'INTERNAL';

export interface ApiErrorBody {
  error: { code: ErrorCode; message: string; fields?: Record<string, string> };
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

// --- Auth -------------------------------------------------------------------------------------------

export interface AuthState {
  /** May use the app: opened from a trusted network, or logged in with the password. */
  authenticated: boolean;
  /** Opened from a network that needs no login (Settings → Access). */
  trustedNetwork: boolean;
  /** A password is set, so logging in from other networks is possible. */
  loginAvailable: boolean;
  /** Set when logged in with the password. */
  username: string | null;
  /** The address tvspy sees for this browser. */
  address: string | null;
}

export interface LoginRequest {
  username: string;
  password: string;
}

/**
 * Sets the password for access from other networks. From a trusted network no current password is
 * needed (and the user name may change); when logged in from elsewhere, currentPassword is required.
 */
export interface PasswordChangeRequest {
  username?: string;
  currentPassword?: string;
  newPassword: string;
}

// --- Status, live, tuners ---------------------------------------------------------------------------

export interface TvhState {
  configured: boolean;
  connected: boolean;
  lastOkAt: ISO | null;
  downSince: ISO | null;
  error: string | null;
  version: string | null;
}

export interface Status {
  version: string;
  commit: string | null;
  timezone: string;
  serverTime: ISO;
  thresholds: { snrGoodDb: number; snrCriticalDb: number };
  tvh: TvhState;
  tuners: { inUse: number; detected: number; expected: number };
  activeStreams: number;
  /** blocked: why messages are not sent right now (switched off, not configured, …), or null. */
  telegram: { enabled: boolean; configured: boolean; blocked: string | null };
}

export interface ChannelRef {
  /** TVH channel uuid; null when the channel is unknown (no logo). */
  id: string | null;
  name: string;
}

export interface MuxRef {
  name: string;
  label: string | null;
  freqMHz: number | null;
}

export interface AppInfo {
  app: string;
  version: string | null;
  device: string | null;
  platform: string | null;
  raw: string;
}

export interface Source {
  /** Null when the client sits behind the HTTPS proxy (TVH only sees the proxy). */
  ip: string | null;
  route: Route;
  country: string | null;
}

export interface LiveSession {
  id: number;
  kind: Kind;
  user: string | null;
  channel: ChannelRef;
  mux: MuxRef | null;
  tuner: string | null;
  app: AppInfo | null;
  source: Source;
  startedAt: ISO;
  rateBps: number;
  bytes: number;
  errors: number;
  /** Up to 40 samples, oldest first, one per poll (~3 s). */
  rateHistory: number[];
  title: string | null;
}

export interface Live {
  serverTime: ISO;
  tvh: TvhState;
  sessions: LiveSession[];
}

export type TunerState = 'idle' | 'streaming' | 'internal' | 'missing';

export interface Tuner {
  name: string;
  label: string;
  state: TunerState;
  mux: MuxRef | null;
  locked: boolean | null;
  subscriptions: number;
  snrDb: number | null;
  signalDbm: number | null;
  snrPct: number | null;
  signalPct: number | null;
  rateBps: number | null;
  /** [epoch seconds, SNR dB or null when unlocked], last 15 minutes. */
  snrHistory: [number, number | null][];
}

export interface Tuners {
  serverTime: ISO;
  expected: number;
  tuners: Tuner[];
}

// --- Sessions (history) -----------------------------------------------------------------------------

export type SessionSort = 'startedAt' | 'endedAt' | 'durationSec' | 'bytes' | 'user' | 'channel' | 'errors';

export interface SessionRow {
  id: number;
  kind: Kind;
  user: string | null;
  channel: ChannelRef;
  mux: MuxRef | null;
  tuner: string | null;
  app: AppInfo | null;
  source: Source;
  startedAt: ISO;
  endedAt: ISO | null;
  durationSec: number;
  bytes: number;
  errors: number;
  title: string | null;
  outcome: 'ok' | 'failed' | null;
  /** Legacy data whose end time was estimated from the data volume. */
  estimated: boolean;
  visitId: number | null;
}

export interface Sessions extends Page<SessionRow> {
  summary: { sessions: number; visits: number; watchSec: number; bytes: number };
}

export interface Lookups {
  users: string[];
  channels: ChannelRef[];
  apps: string[];
  dataFrom: LocalDate | null;
}

// --- Alerts -----------------------------------------------------------------------------------------

export type NotificationStatus = 'pending' | 'sent' | 'failed' | 'suppressed';

export interface AlertLogEntry {
  id: number;
  at: ISO;
  rule: string;
  subject: string | null;
  /** The message as plain text. */
  text: string;
  status: NotificationStatus;
  /** Why it was not sent (failed or suppressed). */
  error: string | null;
  sentAt: ISO | null;
}

export type Alerts = Page<AlertLogEntry>;

// --- Settings ---------------------------------------------------------------------------------------

export interface Settings {
  /** Networks that open tvspy without login, and host names besides IP addresses that count for them. */
  access: { openNetworks: string[]; hostnames: string[] };
  tvh: { url: string; username: string; passwordSet: boolean };
  telegram: {
    enabled: boolean;
    chatId: string;
    botTokenSet: boolean;
  };
  monitoring: {
    tunersExpected: number;
    snrGoodDb: number;
    snrCriticalDb: number;
    minSessionSec: number;
    proxyCidrs: string[];
    lanCidrs: string[];
    trustedIps: string[];
  };
  rules: {
    playbackStart: boolean;
    playbackStop: boolean;
    recordingStart: boolean;
    recordingStop: boolean;
    longWatch: { enabled: boolean; limitMinutes: number };
    tvhDown: boolean;
    muxStale: boolean;
  };
}

export interface SettingsPatch {
  access?: Partial<Settings['access']>;
  tvh?: Partial<{ url: string; username: string; password: string | null }>;
  telegram?: Partial<{ enabled: boolean; chatId: string; botToken: string | null }>;
  monitoring?: Partial<Settings['monitoring']>;
  rules?: Partial<{
    playbackStart: boolean;
    playbackStop: boolean;
    recordingStart: boolean;
    recordingStop: boolean;
    longWatch: Partial<{ enabled: boolean; limitMinutes: number }>;
    tvhDown: boolean;
    muxStale: boolean;
  }>;
}

export interface TvhTestRequest {
  url?: string;
  username?: string;
  password?: string;
}

export interface TelegramTestRequest {
  botToken?: string;
  chatId?: string;
}

export type TestResult =
  | {
      ok: true;
      detail: string;
      tvh?: { version: string | null; tuners: number; channels: number; admin: boolean };
    }
  | { ok: false; message: string };

export interface About {
  version: string;
  commit: string | null;
  schema: number;
  database: { sessions: number; firstSession: ISO | null; sizeBytes: number };
  legacyImport: { at: ISO; sessions: number } | null;
}
