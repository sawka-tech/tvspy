// Live session tracking: one row per TVH subscription of a viewer or a recording. Usage is accounted
// per local hour as it happens. The row's (last_seen_at, bytes) pair is the watermark of what
// usage_hourly already contains; both are written in the same transaction, so a restart resumes exactly.

import { parseClient } from '../core/clientParse.js';
import { classifyRoute, isIp, type Route } from '../core/ip.js';
import { outcomeOf } from '../core/outcome.js';
import { toDay } from '../core/time.js';
import {
  isClientOrRecording,
  isRecordingTitle,
  parseService,
  subKey,
  type TvhSubscription,
} from '../core/tvhParse.js';
import { splitInterval } from '../core/usageSplit.js';
import type { DB } from '../db/open.js';

export interface TrackedSession {
  id: number;
  subKey: string;
  kind: 'stream' | 'recording';
  username: string | null;
  channel: string | null;
  title: string | null;
  client: string | null;
  app: string | null;
  appVersion: string | null;
  device: string | null;
  platform: string | null;
  ip: string | null;
  route: Route;
  tuner: string | null;
  mux: string | null;
  startedAt: number;
  /** Watermark: time accounted so far (= last time the session was seen). */
  lastSeenAt: number;
  /** Watermark: bytes accounted so far. */
  bytes: number;
  /** Last raw volume counter from TVH (null after a restart until the next poll). */
  lastVolume: number | null;
  bytesIn: number;
  bytesOut: number | null;
  errors: number;
  /** Current rate in bits per second, and recent samples (oldest first). */
  rateBps: number;
  rateHistory: number[];
  /** First session for this user and app/platform/device, or from this address (for alerts). */
  newDevice: boolean;
  newIp: boolean;
}

export interface TrackerContext {
  tz: string;
  proxyCidrs: readonly string[];
  lanCidrs: readonly string[];
  visitGapSec: number;
  /** Mux of a channel from the TVH catalog, for subscriptions whose service name has none. */
  channelMux(channel: string | null): string | null;
}

export interface TrackerHooks {
  onStart?(s: TrackedSession): void;
  onEnd?(s: TrackedSession, endedAt: number, outcome: 'ok' | 'failed'): void;
}

interface PendingUsage {
  day: string;
  hour: number;
  secs: number;
  bytes: number;
}

const RATE_HISTORY = 40;

interface SessionRowDb {
  id: number;
  sub_key: string;
  kind: 'stream' | 'recording';
  username: string | null;
  channel: string | null;
  title: string | null;
  client: string | null;
  app: string | null;
  app_version: string | null;
  device: string | null;
  platform: string | null;
  ip: string | null;
  route: Route | null;
  tuner: string | null;
  mux: string | null;
  started_at: number;
  last_seen_at: number;
  bytes: number;
  bytes_in: number;
  bytes_out: number | null;
  errors: number;
}

export class SessionTracker {
  readonly open = new Map<string, TrackedSession>();
  private readonly pending = new Map<number, Map<number, PendingUsage>>();

  constructor(
    private readonly db: DB,
    private readonly ctx: () => TrackerContext,
    private readonly hooks: TrackerHooks = {},
  ) {
    this.loadOpen();
  }

  /** Sessions still open in the database (from before a restart, or imported) continue from their watermark. */
  private loadOpen(): void {
    const rows = this.db.prepare('SELECT * FROM sessions WHERE ended_at IS NULL').all() as SessionRowDb[];
    for (const r of rows) {
      this.open.set(r.sub_key, {
        id: r.id,
        subKey: r.sub_key,
        kind: r.kind,
        username: r.username,
        channel: r.channel,
        title: r.title,
        client: r.client,
        app: r.app,
        appVersion: r.app_version,
        device: r.device,
        platform: r.platform,
        ip: r.ip,
        route: r.route ?? 'none',
        tuner: r.tuner,
        mux: r.mux,
        startedAt: r.started_at,
        lastSeenAt: r.last_seen_at,
        bytes: r.bytes,
        lastVolume: null,
        bytesIn: r.bytes_in,
        bytesOut: r.bytes_out,
        errors: r.errors,
        rateBps: 0,
        rateHistory: [],
        newDevice: false,
        newIp: false,
      });
    }
  }

  /**
   * Applies one successful poll of TVH's subscriptions. Call only when the poll succeeded: sessions that
   * are missing from the list are closed at the time they were last seen.
   */
  update(
    subs: readonly TvhSubscription[],
    now: number,
  ): { started: TrackedSession[]; ended: TrackedSession[] } {
    const { tz } = this.ctx();
    const seen = new Set<string>();
    const started: TrackedSession[] = [];

    for (const sub of subs) {
      if (!isClientOrRecording(sub)) continue;
      const key = subKey(sub);
      seen.add(key);
      let s = this.open.get(key);
      if (!s) {
        s = this.start(sub, now);
        started.push(s);
      }

      const volume = sub.totalOut > 0 ? sub.totalOut : sub.totalIn;
      const base = s.lastVolume ?? s.bytes;
      // A counter that went backwards was reset; count it from zero. On the first poll after loading a
      // stored session (restart, or a row imported from the old tvspy, which may have counted another
      // counter), a smaller value only means the baseline is unknown: count nothing.
      const delta = volume >= base ? volume - base : s.lastVolume === null ? 0 : volume;
      const from = Math.min(Math.max(s.lastSeenAt, s.startedAt), now);
      if (now > from || delta > 0) this.account(s, from, now, delta, tz);
      s.lastSeenAt = Math.max(s.lastSeenAt, now);
      s.bytes += delta;
      s.lastVolume = volume;
      s.bytesIn = sub.totalIn;
      s.bytesOut = sub.totalOut > 0 ? sub.totalOut : null;
      s.errors = sub.errors;
      s.rateBps = Math.max(0, (sub.rateOut > 0 ? sub.rateOut : sub.rateIn) * 8);
      s.rateHistory.push(s.rateBps);
      if (s.rateHistory.length > RATE_HISTORY) s.rateHistory.shift();
    }

    const ended: TrackedSession[] = [];
    for (const [key, s] of this.open) {
      if (!seen.has(key)) {
        this.close(s);
        ended.push(s);
      }
    }
    return { started, ended };
  }

  private account(s: TrackedSession, from: number, to: number, bytes: number, tz: string): void {
    let byHour = this.pending.get(s.id);
    if (!byHour) {
      byHour = new Map();
      this.pending.set(s.id, byHour);
    }
    for (const seg of splitInterval(from, to, bytes, tz)) {
      const p = byHour.get(seg.hourStart);
      if (p) {
        p.secs += seg.secs;
        p.bytes += seg.bytes;
      } else {
        byHour.set(seg.hourStart, { day: seg.day, hour: seg.hour, secs: seg.secs, bytes: seg.bytes });
      }
    }
  }

  private start(sub: TvhSubscription, now: number): TrackedSession {
    const ctx = this.ctx();
    const kind = isRecordingTitle(sub.title) ? 'recording' : 'stream';
    const svc = parseService(sub.service);
    const client = parseClient(sub.client);
    const ip = sub.hostname && isIp(sub.hostname) ? sub.hostname.trim() : null;
    const route = classifyRoute(ip, { proxyCidrs: ctx.proxyCidrs, lanCidrs: ctx.lanCidrs });
    const startedAt = Math.min(sub.start, now);
    const s: TrackedSession = {
      id: 0,
      subKey: subKey(sub),
      kind,
      username: sub.username,
      channel: sub.channel,
      title: sub.title || null,
      client: sub.client,
      app: client?.app ?? null,
      appVersion: client?.version ?? null,
      device: client?.device ?? null,
      platform: client?.platform ?? null,
      ip,
      route,
      tuner: svc.tuner,
      mux: svc.mux ?? ctx.channelMux(sub.channel),
      startedAt,
      lastSeenAt: startedAt,
      bytes: 0,
      lastVolume: null,
      bytesIn: 0,
      bytesOut: null,
      errors: 0,
      rateBps: 0,
      rateHistory: [],
      newDevice: false,
      newIp: false,
    };

    this.db.transaction(() => {
      const result = this.db
        .prepare(
          `INSERT INTO sessions (sub_key, source, kind, username, channel, title, service, profile, tuner, network, mux,
             client, app, app_version, device, platform, ip, route, started_at, start_day, last_seen_at, bytes, bytes_in)
           VALUES (@subKey, 'live', @kind, @username, @channel, @title, @service, @profile, @tuner, @network, @mux,
             @client, @app, @appVersion, @device, @platform, @ip, @route, @startedAt, @startDay, @startedAt, 0, 0)`,
        )
        .run({
          ...s,
          service: sub.service,
          profile: sub.profile,
          network: svc.network,
          startDay: toDay(startedAt, ctx.tz),
        });
      s.id = Number(result.lastInsertRowid);

      if (kind === 'stream') {
        // Zapping: a session starting soon after the same user's previous one in the same app joins its visit.
        const prev = this.db
          .prepare(
            `SELECT id, visit_id FROM sessions
             WHERE kind = 'stream' AND id != ? AND username IS ? AND app IS ?
               AND COALESCE(ended_at, last_seen_at) >= ?
             ORDER BY started_at DESC LIMIT 1`,
          )
          .get(s.id, s.username, s.app, startedAt - ctx.visitGapSec) as
          | { id: number; visit_id: number | null }
          | undefined;
        this.db
          .prepare('UPDATE sessions SET visit_id = ? WHERE id = ?')
          .run(prev?.visit_id ?? prev?.id ?? s.id, s.id);

        if (s.username && s.app) {
          const device = this.db
            .prepare(
              `INSERT INTO user_devices (username, app, platform, device, first_seen, last_seen, sessions, last_client)
               VALUES (?, ?, ?, ?, ?, ?, 1, ?)
               ON CONFLICT (username, app, platform, device) DO UPDATE SET
                 last_seen = excluded.last_seen, sessions = sessions + 1, last_client = excluded.last_client
               RETURNING sessions`,
            )
            .get(s.username, s.app, s.platform ?? '', s.device ?? '', startedAt, startedAt, s.client) as {
            sessions: number;
          };
          s.newDevice = device.sessions === 1;
        }
        if (s.username && s.ip) {
          const ipRow = this.db
            .prepare(
              `INSERT INTO user_ips (username, ip, route, first_seen, last_seen, sessions)
               VALUES (?, ?, ?, ?, ?, 1)
               ON CONFLICT (username, ip) DO UPDATE SET last_seen = excluded.last_seen, sessions = sessions + 1
               RETURNING sessions`,
            )
            .get(s.username, s.ip, s.route, startedAt, startedAt) as { sessions: number };
          s.newIp = ipRow.sessions === 1;
        }
      }
    })();

    this.open.set(s.subKey, s);
    this.hooks.onStart?.(s);
    return s;
  }

  private close(s: TrackedSession): void {
    const outcome = outcomeOf(s.lastSeenAt - s.startedAt, s.bytes);
    this.db.transaction(() => {
      this.flushSession(s);
      this.db
        .prepare('UPDATE sessions SET ended_at = ?, outcome = ? WHERE id = ?')
        .run(s.lastSeenAt, outcome, s.id);
    })();
    this.open.delete(s.subKey);
    this.pending.delete(s.id);
    this.hooks.onEnd?.(s, s.lastSeenAt, outcome);
  }

  private flushSession(s: TrackedSession): void {
    const byHour = this.pending.get(s.id);
    if (byHour && byHour.size > 0) {
      const upsert = this.db.prepare(`
        INSERT INTO usage_hourly (session_id, hour_start, day, hour, watch_s, bytes)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (session_id, hour_start) DO UPDATE SET
          watch_s = watch_s + excluded.watch_s, bytes = bytes + excluded.bytes`);
      for (const [hourStart, p] of byHour) upsert.run(s.id, hourStart, p.day, p.hour, p.secs, p.bytes);
      byHour.clear();
    }
    this.db
      .prepare(
        'UPDATE sessions SET last_seen_at = ?, bytes = ?, bytes_in = ?, bytes_out = ?, errors = ? WHERE id = ?',
      )
      .run(s.lastSeenAt, s.bytes, s.bytesIn, s.bytesOut, s.errors, s.id);
  }

  /** Writes accumulated usage and watermarks of all open sessions (every 30 s and on shutdown). */
  flush(): void {
    this.db.transaction(() => {
      for (const s of this.open.values()) this.flushSession(s);
    })();
  }
}
