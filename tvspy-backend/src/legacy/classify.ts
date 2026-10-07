// Pure classification of legacy tvspy "registries" rows.

import { isRecordingTitle } from '../core/tvhParse.js';

export interface LegacyRow {
  id: number;
  username: string | null;
  channel: string | null;
  hostname: string | null;
  client: string | null;
  service: string | null;
  title: string | null;
  errors: number | null;
  total_in: number | null;
  start: unknown;
  end: unknown;
  sub_key?: string | null;
}

export type LegacyClass = 'recording' | 'internal' | 'stream' | 'invalid';
export type Quality = 'end_estimated' | 'end_suspect' | 'unclosed' | null;

/** Rows that have no client address and are not recordings were TVH's own jobs (EPG grabber, scans). */
export function classifyRow(row: LegacyRow): LegacyClass {
  if (isRecordingTitle(row.title)) return parseLegacyTime(row.start) === null ? 'invalid' : 'recording';
  if (!row.hostname || row.hostname.trim() === '') return 'internal';
  return parseLegacyTime(row.start) === null ? 'invalid' : 'stream';
}

/**
 * Legacy times were written as ISO strings ("2025-09-27T19:06:40.000Z"); older rows may hold
 * "YYYY-MM-DD HH:MM:SS" (treated as UTC) or numbers (seconds or milliseconds).
 */
export function parseLegacyTime(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value > 1e12 ? value / 1000 : value);
  }
  if (typeof value !== 'string' || value.trim() === '') return null;
  const s = value.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return parseLegacyTime(Number(s));
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s) ? `${s.replace(' ', 'T')}Z` : s;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : null;
}

/** Usernames the old app stored for anonymous sessions. */
export function normalizeUsername(name: string | null): string | null {
  const s = name?.trim();
  return !s || s === 'No user' ? null : s;
}

/** A stream that ran this long but delivered less than this volume failed to start. */
export const FAILED_MIN_SECONDS = 8;
export const FAILED_MAX_BYTES = 64 * 1024;

export function outcomeOf(durationSec: number, bytes: number): 'ok' | 'failed' {
  return durationSec >= FAILED_MIN_SECONDS && bytes < FAILED_MAX_BYTES ? 'failed' : 'ok';
}

/** Typical bitrates in bits per second, used to repair legacy durations from their byte counts. */
export class BitrateModel {
  private readonly perChannel = new Map<string, number>();
  private readonly global: number;

  constructor(samples: readonly { channel: string | null; seconds: number; bytes: number }[]) {
    const byChannel = new Map<string, number[]>();
    const all: number[] = [];
    for (const s of samples) {
      if (s.seconds < 60 || s.bytes < 1_000_000) continue;
      const bps = (s.bytes * 8) / s.seconds;
      all.push(bps);
      const key = s.channel ?? '';
      const list = byChannel.get(key);
      if (list) list.push(bps);
      else byChannel.set(key, [bps]);
    }
    for (const [channel, list] of byChannel) if (list.length >= 5) this.perChannel.set(channel, median(list));
    this.global = all.length > 0 ? median(all) : 4_000_000;
  }

  bitrate(channel: string | null): number {
    return this.perChannel.get(channel ?? '') ?? this.global;
  }

  /** Seconds that `bytes` would take at the channel's typical bitrate. */
  secondsFor(channel: string | null, bytes: number): number {
    return Math.max(1, Math.round((bytes * 8) / this.bitrate(channel)));
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

export interface Timing {
  startedAt: number;
  endedAt: number | null;
  quality: Quality;
  /** True when the end was changed from what the legacy row says. */
  adjusted: boolean;
}

/**
 * Decides a legacy session's end. The old tracker sometimes closed rows early but kept adding bytes,
 * and the fork closed never-ended rows with end = start; byte counts are the reliable part.
 */
export function legacyTiming(
  row: LegacyRow,
  model: BitrateModel,
  opts: { repair: boolean; openUntil: number },
): Timing {
  const startedAt = parseLegacyTime(row.start) as number;
  const end = parseLegacyTime(row.end);
  const bytes = Math.max(0, row.total_in ?? 0);

  if (end === null) {
    // Still in flight when the old app stopped (fork rows have a sub_key): leave open for the live tracker.
    if (row.sub_key) return { startedAt, endedAt: null, quality: null, adjusted: false };
    return { startedAt, endedAt: startedAt, quality: 'unclosed', adjusted: true };
  }
  if (end < startedAt) return { startedAt, endedAt: startedAt, quality: 'unclosed', adjusted: true };

  const seconds = end - startedAt;
  if (seconds === 0 && bytes >= 5_000_000) {
    return {
      startedAt,
      endedAt: Math.min(
        startedAt + model.secondsFor(row.channel, bytes),
        Math.max(startedAt, opts.openUntil),
      ),
      quality: 'end_estimated',
      adjusted: true,
    };
  }
  if (seconds >= 30 && bytes >= 1_000_000) {
    const ratio = (bytes * 8) / seconds / model.bitrate(row.channel);
    if (ratio > 4 || ratio < 0.25) {
      if (!opts.repair) return { startedAt, endedAt: end, quality: 'end_suspect', adjusted: false };
      return {
        startedAt,
        endedAt: Math.min(
          startedAt + model.secondsFor(row.channel, bytes),
          Math.max(startedAt, opts.openUntil),
        ),
        quality: 'end_suspect',
        adjusted: true,
      };
    }
  }
  return { startedAt, endedAt: end, quality: null, adjusted: false };
}
