// Tables derived from `sessions`. usage_hourly is accumulated incrementally (live data is exact per
// hour); visits, devices/IPs and swept concurrency can always be rebuilt from the sessions table.

import { sweepConcurrency } from '../core/concurrency.js';
import { splitInterval } from '../core/usageSplit.js';
import { assignVisits } from '../core/visits.js';
import type { DB } from './open.js';

export function addUsage(
  db: DB,
  sessionId: number,
  from: number,
  to: number,
  bytes: number,
  tz: string,
): void {
  const upsert = db.prepare(`
    INSERT INTO usage_hourly (session_id, hour_start, day, hour, watch_s, bytes)
    VALUES (@sessionId, @hourStart, @day, @hour, @secs, @bytes)
    ON CONFLICT (session_id, hour_start) DO UPDATE SET
      watch_s = watch_s + excluded.watch_s,
      bytes = bytes + excluded.bytes`);
  for (const seg of splitInterval(from, to, bytes, tz)) upsert.run({ sessionId, ...seg });
}

export function rebuildVisits(db: DB, gapSec?: number): void {
  const rows = db
    .prepare(
      `SELECT id, username AS user, app, started_at AS start, COALESCE(ended_at, last_seen_at) AS "end"
       FROM sessions WHERE kind = 'stream'`,
    )
    .all() as { id: number; user: string | null; app: string | null; start: number; end: number }[];
  const visits = assignVisits(rows, gapSec);
  const update = db.prepare('UPDATE sessions SET visit_id = ? WHERE id = ? AND visit_id IS NOT ?');
  for (const [id, visit] of visits) update.run(visit, id, visit);
}

export function rebuildDevicesAndIps(db: DB): void {
  db.exec(`
    DELETE FROM user_devices;
    INSERT INTO user_devices (username, app, platform, device, first_seen, last_seen, sessions, last_client)
    SELECT username, app, COALESCE(platform, ''), COALESCE(device, ''), MIN(started_at), MAX(last_seen_at), COUNT(*),
           (SELECT s2.client FROM sessions s2
             WHERE s2.username = s.username AND s2.app = s.app
               AND COALESCE(s2.platform, '') = COALESCE(s.platform, '') AND COALESCE(s2.device, '') = COALESCE(s.device, '')
             ORDER BY s2.started_at DESC LIMIT 1)
    FROM sessions s
    WHERE kind = 'stream' AND username IS NOT NULL AND app IS NOT NULL
    GROUP BY username, app, COALESCE(platform, ''), COALESCE(device, '');

    DELETE FROM user_ips;
    INSERT INTO user_ips (username, ip, route, country, asn, as_org, first_seen, last_seen, sessions)
    SELECT username, ip, MAX(route), MAX(country), MAX(asn), MAX(as_org), MIN(started_at), MAX(last_seen_at), COUNT(*)
    FROM sessions
    WHERE kind = 'stream' AND username IS NOT NULL AND ip IS NOT NULL
    GROUP BY username, ip;
  `);
}

/** Recomputes swept peak concurrency; days measured live keep their exact values. */
export function rebuildSweptConcurrency(db: DB, tz: string, tunersTotal: number): number {
  const rows = db
    .prepare(
      `SELECT id, started_at AS start, COALESCE(ended_at, last_seen_at) AS "end", tuner, mux, username, ip, client
       FROM sessions WHERE outcome IS NOT 'failed'`,
    )
    .all() as {
    id: number;
    start: number;
    end: number;
    tuner: string | null;
    mux: string | null;
    username: string | null;
    ip: string | null;
    client: string | null;
  }[];
  const days = sweepConcurrency(
    rows.map((r) => ({
      start: r.start,
      end: r.end,
      tunerKey: r.tuner ?? r.mux ?? `session-${r.id}`,
      viewerKey: `${r.username ?? ''}|${r.ip ?? ''}|${r.client ?? ''}`,
    })),
    tz,
    tunersTotal,
  );
  db.prepare(`DELETE FROM concurrency_daily WHERE source = 'sweep'`).run();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO concurrency_daily
      (day, source, peak_streams, peak_streams_at, peak_tuners, peak_tuners_at, tuners_total, saturated_s)
    VALUES (@day, 'sweep', @peakStreams, @peakStreamsAt, @peakTuners, @peakTunersAt, @tunersTotal, @saturatedS)`);
  for (const d of days) insert.run({ ...d, tunersTotal });
  return days.length;
}
