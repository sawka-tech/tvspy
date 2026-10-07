import type { LogLevel } from './env.js';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

// Telegram puts the bot token in the URL path; URLs may carry credentials.
const SECRETS: [RegExp, string][] = [
  [/bot\d+:[\w-]+/g, 'bot<redacted>'],
  [/(\/\/[^:/@\s]+:)[^@\s]+@/g, '$1<redacted>@'],
  [/("?(?:password|botToken|token|secret|setupCode)"?\s*[:=]\s*)("[^"]*"|\S+)/gi, '$1<redacted>'],
];

export function redact(text: string): string {
  return SECRETS.reduce((s, [re, replacement]) => s.replace(re, replacement), text);
}

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string, err?: unknown): void;
  /** Most recent lines, oldest first (already redacted). */
  recent(): string[];
  setLevel(level: LogLevel): void;
}

export function createLogger(initial: LogLevel, keep = 500): Logger {
  let level = initial;
  const lines: string[] = [];
  const write = (lvl: LogLevel, msg: string) => {
    if (ORDER[lvl] < ORDER[level]) return;
    const line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} ${redact(msg)}`;
    lines.push(line);
    if (lines.length > keep) lines.shift();
    (lvl === 'error' || lvl === 'warn' ? console.error : console.log)(line);
  };
  return {
    debug: (m) => write('debug', m),
    info: (m) => write('info', m),
    warn: (m) => write('warn', m),
    error: (m, err) =>
      write('error', err === undefined ? m : `${m}: ${err instanceof Error ? err.message : String(err)}`),
    recent: () => [...lines],
    setLevel: (l) => {
      level = l;
    },
  };
}
