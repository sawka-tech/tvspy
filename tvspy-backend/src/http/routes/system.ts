import { statSync } from 'node:fs';
import type { About, Alerts, Live, Lookups, Status, Tuner, Tuners } from '@tvspy/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { USER_WEIGHT } from '../../collect/tuners.js';
import { getMeta } from '../../db/meta.js';
import { schemaVersion } from '../../db/migrate.js';
import { liveSession, muxRef, tunerLabel, tvhStateDto } from '../mappers.js';
import { type AppDeps, type AppEnv, iso, isoNow, notFound, readQuery } from '../support.js';

/** Tuners not seen for this long are forgotten instead of being reported missing. */
const FORGET_TUNERS_SEC = 30 * 86400;

const stripHtml = (s: string) =>
  s
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');

export function systemRoutes(d: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/status', (c) => {
    const now = d.now();
    const detected = d.tuners.snapshots(now).length;
    const body: Status = {
      version: d.version,
      commit: d.commit,
      timezone: d.tz,
      serverTime: isoNow(now),
      thresholds: {
        snrGoodDb: d.settings.get('reception.snrGoodDb'),
        snrCriticalDb: d.settings.get('reception.snrCriticalDb'),
      },
      tvh: tvhStateDto(d.tvh),
      tuners: { inUse: d.tuners.busyForUsers(now), detected, expected: d.totalTuners(now) },
      activeStreams: d.tracker.open.size,
      telegram: {
        enabled: d.telegramAllowed && d.settings.get('telegram.enabled'),
        configured: d.settings.isSet('telegram.botToken') && d.settings.get('telegram.chatId') !== '',
        blocked: d.outbox.blockedReason(),
      },
    };
    return c.json(body);
  });

  app.get('/live', (c) => {
    const now = d.now();
    const sessions = [...d.tracker.open.values()]
      .sort((a, b) => b.startedAt - a.startedAt || b.id - a.id)
      .map((s) => liveSession(s, d.catalog));
    return c.json({ serverTime: isoNow(now), tvh: tvhStateDto(d.tvh), sessions } satisfies Live);
  });

  app.get('/tuners', (c) => {
    const now = d.now();
    const live = new Map(d.tuners.snapshots(now).map((t) => [t.name, t]));
    const known = d.db
      .prepare('SELECT name FROM tuners WHERE last_seen >= ? ORDER BY name')
      .all(now - FORGET_TUNERS_SEC) as { name: string }[];
    const names = [...new Set([...known.map((k) => k.name), ...live.keys()])].sort();
    const tuners: Tuner[] = names.map((name) => {
      const snap = live.get(name);
      if (!snap) {
        return {
          name,
          label: tunerLabel(name),
          state: 'missing',
          mux: null,
          locked: null,
          subscriptions: 0,
          snrDb: null,
          signalDbm: null,
          snrPct: null,
          signalPct: null,
          rateBps: null,
          snrHistory: d.tuners.snrHistory(name),
        };
      }
      const i = snap.input;
      const state = !i.mux || i.subs === 0 ? 'idle' : i.weight >= USER_WEIGHT ? 'streaming' : 'internal';
      return {
        name,
        label: tunerLabel(name),
        state,
        mux: muxRef(d.catalog, i.mux),
        locked: i.mux ? i.locked : null,
        subscriptions: i.subs,
        snrDb: i.mux && i.locked ? i.snrDb : null,
        signalDbm: i.mux ? i.signalDbm : null,
        snrPct: i.mux && i.locked ? i.snrPct : null,
        signalPct: i.mux ? i.signalPct : null,
        rateBps: i.mux ? i.bps : null,
        snrHistory: d.tuners.snrHistory(name),
      };
    });
    return c.json({ serverTime: isoNow(now), expected: d.totalTuners(now), tuners } satisfies Tuners);
  });

  app.get('/lookups', (c) => {
    const users = (
      d.db
        .prepare(
          `SELECT DISTINCT username FROM sessions WHERE username IS NOT NULL ORDER BY username COLLATE NOCASE`,
        )
        .all() as { username: string }[]
    ).map((r) => r.username);
    const channels = (
      d.db
        .prepare(
          `SELECT DISTINCT channel FROM sessions WHERE channel IS NOT NULL ORDER BY channel COLLATE NOCASE`,
        )
        .all() as { channel: string }[]
    ).map((r) => ({ id: d.catalog.channelByName(r.channel)?.uuid ?? null, name: r.channel }));
    const apps = (
      d.db
        .prepare(`SELECT DISTINCT app FROM sessions WHERE app IS NOT NULL ORDER BY app COLLATE NOCASE`)
        .all() as {
        app: string;
      }[]
    ).map((r) => r.app);
    const first = d.db.prepare('SELECT MIN(start_day) AS day FROM sessions').get() as { day: string | null };
    return c.json({ users, channels, apps, dataFrom: first.day } satisfies Lookups);
  });

  app.get('/about', (c) => {
    const counts = d.db
      .prepare(
        `SELECT COUNT(*) AS n, MIN(started_at) AS first, SUM(source = 'legacy') AS legacy FROM sessions`,
      )
      .get() as { n: number; first: number | null; legacy: number | null };
    const file = d.db.name;
    let sizeBytes = 0;
    for (const f of [file, `${file}-wal`]) {
      try {
        sizeBytes += statSync(f).size;
      } catch {
        // No such file (in-memory database, or no WAL right now).
      }
    }
    const legacy = getMeta(d.db, 'legacy_import');
    const legacyAt = legacy ? (JSON.parse(legacy) as { at: number }).at : null;
    const body: About = {
      version: d.version,
      commit: d.commit,
      schema: schemaVersion(d.db),
      database: { sessions: counts.n, firstSession: iso(counts.first), sizeBytes },
      legacyImport: legacyAt === null ? null : { at: isoNow(legacyAt), sessions: counts.legacy ?? 0 },
    };
    return c.json(body);
  });

  app.get('/alerts', (c) => {
    const q = readQuery(
      c,
      z.object({
        page: z.coerce.number().int().min(1).max(100_000).default(1),
        pageSize: z.coerce.number().int().min(1).max(200).default(50),
      }),
    );
    const total = (d.db.prepare('SELECT COUNT(*) AS n FROM notifications').get() as { n: number }).n;
    const rows = d.db
      .prepare(
        `SELECT id, created_at, rule, subject, text, status, last_error, sent_at FROM notifications
         ORDER BY id DESC LIMIT ? OFFSET ?`,
      )
      .all(q.pageSize, (q.page - 1) * q.pageSize) as {
      id: number;
      created_at: number;
      rule: string;
      subject: string | null;
      text: string;
      status: 'pending' | 'sent' | 'failed' | 'suppressed';
      last_error: string | null;
      sent_at: number | null;
    }[];
    const body: Alerts = {
      items: rows.map((r) => ({
        id: r.id,
        at: isoNow(r.created_at),
        rule: r.rule,
        subject: r.subject,
        text: stripHtml(r.text),
        status: r.status,
        error: r.last_error,
        sentAt: iso(r.sent_at),
      })),
      total,
      page: q.page,
      pageSize: q.pageSize,
    };
    return c.json(body);
  });

  app.get('/channels/:id/icon', async (c) => {
    const logo = await d.logos.get(c.req.param('id'), d.now());
    if (!logo) throw notFound('No logo for this channel');
    return c.body(new Uint8Array(logo.body), 200, {
      'Content-Type': logo.type,
      'Cache-Control': 'private, max-age=86400',
    });
  });

  return app;
}
