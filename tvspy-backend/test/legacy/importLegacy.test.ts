import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { type DB, openDb } from '../../src/db/open.js';
import { importLegacy } from '../../src/legacy/importLegacy.js';
import { formatReport } from '../../src/legacy/report.js';
import { createLegacyDb, SECRET_PASSWORD, SECRET_TOKEN } from '../fixtures/legacyDb.js';

const WAW = 'Europe/Warsaw';
const NOW = Date.parse('2026-10-07T10:00:00Z') / 1000;

let dir: string;
let legacyPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tvspy-legacy-'));
  legacyPath = join(dir, 'database.db');
  createLegacyDb(legacyPath);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function freshDb(): DB {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

const fileHash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

function session(db: DB, legacyId: number) {
  return db.prepare('SELECT * FROM sessions WHERE legacy_id = ?').get(legacyId) as Record<string, unknown> & {
    id: number;
    started_at: number;
    ended_at: number | null;
    last_seen_at: number;
  };
}

function checksum(db: DB): string {
  const hash = createHash('sha256');
  for (const table of [
    'sessions',
    'usage_hourly',
    'coverage_daily',
    'concurrency_daily',
    'user_devices',
    'user_ips',
    'settings',
    'meta',
  ]) {
    hash.update(table);
    hash.update(JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all()));
  }
  return hash.digest('hex');
}

describe('legacy import', () => {
  it('puts every row into exactly one class', async () => {
    const report = await importLegacy(freshDb(), legacyPath, { tz: WAW, now: NOW });
    expect(report.rows).toBe(19);
    expect(report.classes).toEqual({ stream: 15, recording: 1, internal: 2, invalid: 1 });
    expect(Object.values(report.crossTab).reduce((a, b) => a + b, 0)).toBe(19);
  });

  it('imports viewing sessions and recordings but not TVH-internal rows', async () => {
    const db = freshDb();
    await importLegacy(db, legacyPath, { tz: WAW, now: NOW });
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 16 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE title IN ('epggrab', 'scan')`).get()).toEqual(
      { n: 0 },
    );
    expect(session(db, 1759200000)).toMatchObject({
      kind: 'recording',
      tuner: 'Silicon Labs Si2168 #1 : DVB-T #0',
      mux: '530MHz',
    });
    expect(session(db, 1759000000)).toMatchObject({
      sub_key: 'legacy-1759000000',
      app: 'SparkleTV',
      device: 'Fire TV Stick 4K',
      platform: 'Android 7.1.2',
      route: 'direct',
      start_day: '2025-09-27',
    });
    expect(session(db, 1759700000)).toMatchObject({ username: null, route: 'lan', app: 'VLC' });
  });

  it('estimates zero-length ends and flags lengths that contradict the data volume', async () => {
    const db = freshDb();
    await importLegacy(db, legacyPath, { tz: WAW, now: NOW });
    const estimated = session(db, 1759300000);
    expect(estimated.quality).toBe('end_estimated');
    expect((estimated.ended_at as number) - estimated.started_at).toBe(2500); // 1.5 GB at 4.8 Mbit/s
    const suspect = session(db, 1759400000);
    expect(suspect.quality).toBe('end_suspect');
    expect((suspect.ended_at as number) - suspect.started_at).toBe(120);

    const repaired = freshDb();
    const report = await importLegacy(repaired, legacyPath, { tz: WAW, now: NOW, repair: true });
    expect(
      (session(repaired, 1759400000).ended_at as number) - session(repaired, 1759400000).started_at,
    ).toBe(15_000);
    expect(report.hours.suspectIfRepaired).toBeGreaterThan(report.hours.suspectAsStored);
  });

  it('keeps sessions recorded by the fork open and closes never-ended old ones', async () => {
    const db = freshDb();
    await importLegacy(db, legacyPath, { tz: WAW, now: NOW });
    const open = session(db, 1759500001);
    expect(open).toMatchObject({ sub_key: '1791360000-12', ended_at: null, outcome: null });
    expect(open.last_seen_at).toBeLessThanOrEqual(NOW);
    expect(session(db, 1759500000)).toMatchObject({ quality: 'unclosed' });
    expect(session(db, 1759500000).ended_at).toBe(session(db, 1759500000).started_at);
  });

  it('marks failed starts', async () => {
    const db = freshDb();
    await importLegacy(db, legacyPath, { tz: WAW, now: NOW });
    expect(session(db, 1759600000).outcome).toBe('failed');
    expect(session(db, 1759000000).outcome).toBe('ok');
  });

  it('accounts usage per local day, split at midnight', async () => {
    const db = freshDb();
    await importLegacy(db, legacyPath, { tz: WAW, now: NOW });
    const rows = db
      .prepare(
        'SELECT day, SUM(watch_s) AS s, SUM(bytes) AS b FROM usage_hourly WHERE session_id = ? GROUP BY day',
      )
      .all(session(db, 1759000000).id);
    expect(rows).toEqual([
      { day: '2025-09-27', s: 1800, b: 900_000_000 },
      { day: '2025-09-28', s: 3600, b: 1_800_000_000 },
    ]);
  });

  it('groups zapping into one visit', async () => {
    const db = freshDb();
    await importLegacy(db, legacyPath, { tz: WAW, now: NOW });
    const first = session(db, 1759800000);
    expect(first.visit_id).toBe(first.id);
    expect(session(db, 1759800001).visit_id).toBe(first.id);
    expect(session(db, 1759000000).visit_id).toBe(session(db, 1759000000).id);
  });

  it('derives devices, addresses, coverage and peak concurrency', async () => {
    const db = freshDb();
    await importLegacy(db, legacyPath, { tz: WAW, now: NOW });
    expect(db.prepare(`SELECT * FROM user_devices WHERE username = 'kapi'`).all()).toEqual([
      expect.objectContaining({ app: 'SparkleTV', device: 'Fire TV Stick 4K', platform: 'Android 7.1.2' }),
    ]);
    expect(db.prepare(`SELECT route FROM user_ips WHERE username = 'kapi'`).all()).toEqual([
      { route: 'direct' },
    ]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM user_ips WHERE username IS NULL`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT source FROM coverage_daily WHERE day = '2025-05-11'`).get()).toEqual({
      source: 'legacy',
    });
    expect(db.prepare(`SELECT peak_streams FROM concurrency_daily WHERE day = '2025-09-28'`).get()).toEqual({
      peak_streams: 1,
    });
  });

  it('maps settings and never prints their values', async () => {
    const db = freshDb();
    const report = await importLegacy(db, legacyPath, { tz: WAW, now: NOW });
    const settings = Object.fromEntries(
      (db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]).map((r) => [
        r.key,
        JSON.parse(r.value),
      ]),
    );
    expect(settings).toMatchObject({
      'tvh.url': 'http://192.168.1.10:9981',
      'tvh.username': 'spy',
      'tvh.password': SECRET_PASSWORD,
      'tvh.auth': 'basic',
      'network.trustedIps': ['192.168.1.70'],
      'stats.minSessionSec': 10,
      'telegram.enabled': true,
      'telegram.botToken': SECRET_TOKEN,
      'telegram.chatId': '987654',
      'rules.playbackStart.enabled': false,
      'rules.longWatch.enabled': true,
      'rules.longWatch.limitMinutes': 5,
    });
    const text = formatReport(report, { dryRun: true });
    for (const secret of [SECRET_PASSWORD, SECRET_TOKEN, '987654', 'secret template', '192.168.1.10']) {
      expect(text).not.toContain(secret);
    }
    expect(report.settings.dropped).toEqual(
      expect.arrayContaining([
        'language',
        'telegram_notification_start_playback_text',
        'telegram_notification_time_text',
      ]),
    );
  });

  it('is idempotent and never modifies the legacy file', async () => {
    const before = fileHash(legacyPath);
    const db = freshDb();
    const first = await importLegacy(db, legacyPath, { tz: WAW, now: NOW });
    const sum = checksum(db);
    const second = await importLegacy(db, legacyPath, { tz: WAW, now: NOW });
    expect(checksum(db)).toBe(sum);
    expect(second.imported).toMatchObject({ sessions: 0, alreadyPresent: 16 });
    expect(second.settings.imported).toBe(false);
    expect(first.file.sha256).toBe(before);
    expect(fileHash(legacyPath)).toBe(before);
  });

  it('imports only new rows on a later run', async () => {
    const db = freshDb();
    await importLegacy(db, legacyPath, { tz: WAW, now: NOW });
    const legacy = new Database(legacyPath);
    legacy
      .prepare(
        `INSERT INTO registries (id, username, channel, hostname, client, service, title, errors, total_in, start, end)
         VALUES (1760000000, 'klebark', 'TVP1', '1.2.3.4', 'TiviMate/5.1.6', 'dvb-t/490MHz/TVP1', 'HTTP', 0, 300000000, ?, ?)`,
      )
      .run('2025-10-10T18:00:00.000Z', '2025-10-10T18:10:00.000Z');
    legacy.close();
    const report = await importLegacy(db, legacyPath, { tz: WAW, now: NOW });
    expect(report.imported).toMatchObject({ sessions: 1, alreadyPresent: 16 });
    expect(session(db, 1760000000)).toMatchObject({ username: 'klebark', app: 'TiviMate' });
  });

  it('reads the schema from before the fork (no sub_key column)', async () => {
    const oldPath = join(dir, 'old.db');
    createLegacyDb(oldPath, { withSubKey: false });
    const db = freshDb();
    const report = await importLegacy(db, oldPath, { tz: WAW, now: NOW });
    expect(report.classes.stream).toBe(15);
    expect(session(db, 1759500001)).toMatchObject({ quality: 'unclosed' });
  });
});
