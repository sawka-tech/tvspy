// Imports the legacy tvspy database (opened read-only, never written). Idempotent and incremental:
// rows already imported are skipped by legacy_id, settings are imported once.

import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { parseClient } from '../core/clientParse.js';
import { classifyRoute, isIp } from '../core/ip.js';
import { toDay } from '../core/time.js';
import { parseService } from '../core/tvhParse.js';
import { addUsage, rebuildDevicesAndIps, rebuildSweptConcurrency, rebuildVisits } from '../db/derived.js';
import { getMeta, setMeta } from '../db/meta.js';
import { type DB, openDb } from '../db/open.js';
import {
  BitrateModel,
  classifyRow,
  type LegacyClass,
  type LegacyRow,
  legacyTiming,
  normalizeUsername,
  outcomeOf,
  parseLegacyTime,
} from './classify.js';
import { type MappedSettings, mapLegacySettings } from './mapSettings.js';

export interface ImportOptions {
  tz: string;
  /** Re-estimate the end of sessions whose stored duration contradicts their byte count. */
  repair?: boolean;
  now?: number;
  /** Tuners assumed for history (used for "all tuners busy" before live measurement). */
  historicalTuners?: number;
}

export interface ImportReport {
  file: { path: string; sizeBytes: number; modifiedAt: string; sha256: string };
  rows: number;
  classes: Record<LegacyClass, number>;
  crossTab: Record<string, number>;
  byYear: Record<string, Record<LegacyClass, number>>;
  quality: { exact: number; end_estimated: number; end_suspect: number; unclosed: number; open: number };
  repair: boolean;
  failedStarts: number;
  hours: { asStored: number; imported: number; suspectAsStored: number; suspectIfRepaired: number };
  terabytes: number;
  days: { first: string | null; last: string | null; withData: number; monthsWithoutData: string[] };
  users: number;
  apps: Record<string, number>;
  imported: { sessions: number; alreadyPresent: number; usageRows: number; sweptDays: number };
  settings: {
    imported: boolean;
    mapped: MappedSettings['mapped'];
    dropped: string[];
    secretsSet: Record<string, boolean>;
  };
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function readLegacy(path: string): { rows: LegacyRow[]; config: Record<string, string | undefined> } {
  const legacy = openDb(path, { readonly: true });
  try {
    const tables = new Set(
      (legacy.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map(
        (t) => t.name,
      ),
    );
    if (!tables.has('registries'))
      throw new Error(`${path} has no "registries" table; is it a tvspy database?`);
    const columns = new Set(
      (legacy.prepare('PRAGMA table_info(registries)').all() as { name: string }[]).map((c) => c.name),
    );
    const subKey = columns.has('sub_key') ? 'sub_key' : 'NULL AS sub_key';
    const rows = legacy
      .prepare(
        `SELECT id, username, channel, hostname, client, service, title, errors, total_in, start, "end", ${subKey}
         FROM registries ORDER BY id`,
      )
      .all() as LegacyRow[];
    const config: Record<string, string | undefined> = {};
    if (tables.has('config')) {
      for (const r of legacy.prepare('SELECT name, value FROM config').all() as {
        name: string;
        value: unknown;
      }[]) {
        config[r.name] = r.value === null || r.value === undefined ? undefined : String(r.value);
      }
    }
    return { rows, config };
  } finally {
    legacy.close();
  }
}

export async function importLegacy(db: DB, legacyPath: string, opts: ImportOptions): Promise<ImportReport> {
  const { tz } = opts;
  const repair = opts.repair ?? false;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const stat = statSync(legacyPath);
  const openUntil = Math.min(now, Math.floor(stat.mtimeMs / 1000));
  const fileHash = await sha256(legacyPath);
  const { rows, config } = readLegacy(legacyPath);

  const classes: Record<LegacyClass, number> = { recording: 0, internal: 0, stream: 0, invalid: 0 };
  const crossTab: Record<string, number> = {};
  const byYear: ImportReport['byYear'] = {};
  const classified = rows.map((row) => {
    const cls = classifyRow(row);
    classes[cls]++;
    const tab = `hostname:${row.hostname ? 'yes' : 'no'} user:${normalizeUsername(row.username) ? 'yes' : 'no'} dvr:${
      row.title?.startsWith('DVR:') ? 'yes' : 'no'
    }`;
    crossTab[tab] = (crossTab[tab] ?? 0) + 1;
    const start = parseLegacyTime(row.start);
    const year = start === null ? 'unknown' : toDay(start, tz).slice(0, 4);
    byYear[year] ??= { recording: 0, internal: 0, stream: 0, invalid: 0 };
    byYear[year][cls]++;
    return { row, cls, start };
  });

  const viewing = classified.filter((c) => c.cls === 'stream' || c.cls === 'recording');
  const model = new BitrateModel(
    viewing.map(({ row, start }) => {
      const end = parseLegacyTime(row.end);
      return {
        channel: row.channel,
        network: parseService(row.service).network,
        seconds: end !== null && start !== null ? end - start : 0,
        bytes: row.total_in ?? 0,
      };
    }),
  );

  const existing = new Set(
    (
      db.prepare('SELECT legacy_id FROM sessions WHERE legacy_id IS NOT NULL').all() as {
        legacy_id: number;
      }[]
    ).map((r) => r.legacy_id),
  );

  const quality = { exact: 0, end_estimated: 0, end_suspect: 0, unclosed: 0, open: 0 };
  const hours = { asStored: 0, imported: 0, suspectAsStored: 0, suspectIfRepaired: 0 };
  const apps: Record<string, number> = {};
  const users = new Set<string>();
  let failedStarts = 0;
  let bytesTotal = 0;
  let inserted = 0;
  let usageRows = 0;

  const insertSession = db.prepare(`
    INSERT INTO sessions (sub_key, legacy_id, source, kind, username, channel, title, service, tuner, network, mux,
      client, app, app_version, device, platform, ip, route, started_at, start_day, last_seen_at, ended_at,
      bytes, bytes_in, errors, outcome, quality)
    VALUES (@subKey, @legacyId, 'legacy', @kind, @username, @channel, @title, @service, @tuner, @network, @mux,
      @client, @app, @appVersion, @device, @platform, @ip, @route, @startedAt, @startDay, @lastSeenAt, @endedAt,
      @bytes, @bytes, @errors, @outcome, @quality)`);

  let settingsImported = false;
  const settings = mapLegacySettings(config);
  let sweptDays = 0;

  const countUsage = () => (db.prepare('SELECT COUNT(*) AS n FROM usage_hourly').get() as { n: number }).n;

  db.transaction(() => {
    const usageBefore = countUsage();
    for (const { row, cls } of viewing) {
      const bytes = Math.max(0, row.total_in ?? 0);
      const timing = legacyTiming(row, model, { repair, openUntil });
      const storedEnd = parseLegacyTime(row.end);
      const storedSecs =
        storedEnd !== null && storedEnd >= timing.startedAt ? storedEnd - timing.startedAt : 0;
      const until = timing.endedAt ?? openUntil;
      const seconds = Math.max(0, until - timing.startedAt);

      hours.asStored += storedSecs / 3600;
      hours.imported += seconds / 3600;
      if (timing.quality === 'end_suspect') {
        hours.suspectAsStored += storedSecs / 3600;
        const repaired = legacyTiming(row, model, { repair: true, openUntil });
        hours.suspectIfRepaired += Math.max(0, (repaired.endedAt ?? openUntil) - repaired.startedAt) / 3600;
      }
      if (timing.endedAt === null) quality.open++;
      else if (timing.quality) quality[timing.quality]++;
      else quality.exact++;

      const outcome = timing.endedAt === null ? null : outcomeOf(seconds, bytes);
      if (outcome === 'failed') failedStarts++;
      bytesTotal += bytes;
      const username = normalizeUsername(row.username);
      if (username) users.add(username);
      const client = parseClient(row.client);
      if (client && cls === 'stream') apps[client.app] = (apps[client.app] ?? 0) + 1;

      if (existing.has(row.id)) continue;
      const svc = parseService(row.service);
      const ip = row.hostname && isIp(row.hostname) ? row.hostname.trim() : null;
      const result = insertSession.run({
        subKey: row.sub_key || `legacy-${row.id}`,
        legacyId: row.id,
        kind: cls === 'recording' ? 'recording' : 'stream',
        username,
        channel: row.channel || null,
        title: row.title || null,
        service: row.service || null,
        tuner: svc.tuner,
        network: svc.network,
        mux: svc.mux,
        client: row.client || null,
        app: client?.app ?? null,
        appVersion: client?.version ?? null,
        device: client?.device ?? null,
        platform: client?.platform ?? null,
        ip,
        route: classifyRoute(ip),
        startedAt: timing.startedAt,
        startDay: toDay(timing.startedAt, tz),
        lastSeenAt: until,
        endedAt: timing.endedAt,
        bytes,
        errors: Math.max(0, row.errors ?? 0),
        outcome,
        quality: timing.quality,
      });
      addUsage(db, Number(result.lastInsertRowid), timing.startedAt, until, bytes, tz);
      inserted++;
    }
    usageRows = countUsage() - usageBefore;

    const coverage = db.prepare(`INSERT OR IGNORE INTO coverage_daily (day, source) VALUES (?, 'legacy')`);
    for (const { start } of classified) if (start !== null) coverage.run(toDay(start, tz));

    if (getMeta(db, 'legacy_settings_imported') === null) {
      const put = db.prepare('INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)');
      for (const [key, value] of Object.entries(settings.values)) put.run(key, JSON.stringify(value), now);
      setMeta(db, 'legacy_settings_imported', String(now));
      settingsImported = true;
    }

    rebuildVisits(db);
    rebuildDevicesAndIps(db);
    sweptDays = rebuildSweptConcurrency(db, tz, opts.historicalTuners ?? 2);
    setMeta(
      db,
      'legacy_import',
      JSON.stringify({
        at: now,
        size: stat.size,
        mtime: Math.floor(stat.mtimeMs / 1000),
        maxId: rows.at(-1)?.id ?? 0,
      }),
    );
  })();

  const days = [
    ...new Set(classified.filter((c) => c.start !== null).map((c) => toDay(c.start as number, tz))),
  ].sort();
  const months = new Set(days.map((d) => d.slice(0, 7)));
  const monthsWithoutData: string[] = [];
  if (days.length > 0) {
    for (let m = (days[0] as string).slice(0, 7); m <= (days.at(-1) as string).slice(0, 7); ) {
      if (!months.has(m)) monthsWithoutData.push(m);
      const [y, mo] = m.split('-').map(Number) as [number, number];
      m = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
    }
  }

  return {
    file: { path: legacyPath, sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString(), sha256: fileHash },
    rows: rows.length,
    classes,
    crossTab,
    byYear,
    quality,
    repair,
    failedStarts,
    hours: {
      asStored: Math.round(hours.asStored),
      imported: Math.round(hours.imported),
      suspectAsStored: Math.round(hours.suspectAsStored),
      suspectIfRepaired: Math.round(hours.suspectIfRepaired),
    },
    terabytes: Math.round((bytesTotal / 1e12) * 100) / 100,
    days: { first: days[0] ?? null, last: days.at(-1) ?? null, withData: days.length, monthsWithoutData },
    users: users.size,
    apps,
    imported: { sessions: inserted, alreadyPresent: viewing.length - inserted, usageRows, sweptDays },
    settings: {
      imported: settingsImported,
      mapped: settings.mapped,
      dropped: settings.dropped,
      secretsSet: settings.secretsSet,
    },
  };
}
