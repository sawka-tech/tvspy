import { isValidTimeZone } from './core/time.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Env {
  /** Holds tvspy.db, backups and caches; the legacy database.db lives here too on Unraid. */
  dataDir: string;
  port: number;
  /** Address to listen on; all interfaces when unset (inside the container). */
  host: string | undefined;
  tz: string;
  logLevel: LogLevel;
  journal: 'wal' | 'delete';
  /** TVSPY_TELEGRAM=off stops all Telegram sending (test and shadow containers). */
  telegramEnabled: boolean;
  version: string;
  commit: string | null;
  /** Built frontend served at /; null serves only the API (development). */
  publicDir: string | null;
  /** True when LOG_LEVEL was given explicitly (it then wins over the stored setting). */
  logLevelFromEnv: boolean;
}

export const DEFAULT_DATA_DIR = '/app/backend/src/database/file';
export const DEFAULT_TZ = 'Europe/Warsaw';

export function readEnv(e: NodeJS.ProcessEnv = process.env): Env {
  const port = Number(e.PORT ?? 80);
  const level = (e.LOG_LEVEL ?? 'info').toLowerCase();
  return {
    dataDir: e.TVSPY_DATA_DIR || DEFAULT_DATA_DIR,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 80,
    host: e.TVSPY_HOST || undefined,
    tz: e.TZ && isValidTimeZone(e.TZ) ? e.TZ : DEFAULT_TZ,
    logLevel: (['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info') as LogLevel,
    journal: e.TVSPY_SQLITE_JOURNAL === 'delete' ? 'delete' : 'wal',
    telegramEnabled: e.TVSPY_TELEGRAM !== 'off',
    version: e.TVSPY_VERSION || '4.0.0-dev',
    commit: e.TVSPY_COMMIT ? e.TVSPY_COMMIT.slice(0, 7) : null,
    publicDir: e.TVSPY_PUBLIC_DIR || null,
    logLevelFromEnv: Boolean(e.LOG_LEVEL),
  };
}
