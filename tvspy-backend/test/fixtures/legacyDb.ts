// Builds a database exactly like the legacy tvspy app did (same DDL), with one row per tricky case.

import Database from 'better-sqlite3';

export const SECRET_PASSWORD = 'SECRET-tvh-password-123';
export const SECRET_TOKEN = '123456:SECRET-bot-token';

const at = (s: string) => new Date(s).toISOString();

export interface LegacyFixtureRow {
  id: number;
  username: string | null;
  channel: string | null;
  hostname: string | null;
  client: string | null;
  service: string | null;
  title: string | null;
  total_in: number;
  start: string | null;
  end: string | null;
  sub_key?: string | null;
}

export const FIXTURE_ROWS: LegacyFixtureRow[] = [
  // Normal evening viewing that crosses midnight (Warsaw): 23:30 → 01:00.
  {
    id: 1759000000,
    username: 'kapi',
    channel: 'TVP1',
    hostname: '77.65.111.65',
    client: 'SparkleTV/1.9.6 (AFTMM, Android 7.1.2)',
    service: 'Silicon Labs Si2168 #0 : DVB-T #0/dvb-t/490MHz/TVP1',
    title: 'HTTP',
    total_in: 2_700_000_000,
    start: at('2025-09-27T21:30:00Z'),
    end: at('2025-09-27T23:00:00Z'),
  },
  // TVH-internal EPG grab: no client address, "No user".
  {
    id: 1759100000,
    username: 'No user',
    channel: '',
    hostname: null,
    client: null,
    service: 'Silicon Labs Si2168 #1 : DVB-T #0/dvb-t/530MHz/Raw PID Subscription',
    title: 'epggrab',
    total_in: 0,
    start: at('2025-05-10T00:04:00Z'),
    end: at('2025-05-10T00:14:00Z'),
  },
  // Internal row on a day with no viewing (still counts as monitored coverage).
  {
    id: 1759100001,
    username: '',
    channel: '',
    hostname: '',
    client: '',
    service: '',
    title: 'scan',
    total_in: 0,
    start: at('2025-05-11T00:04:00Z'),
    end: at('2025-05-11T00:05:00Z'),
  },
  // Recording: no hostname but a DVR title.
  {
    id: 1759200000,
    username: 'admin',
    channel: 'TVN',
    hostname: null,
    client: null,
    service: 'Silicon Labs Si2168 #1 : DVB-T #0/dvb-t/530MHz/TVN',
    title: 'DVR: Fakty',
    total_in: 900_000_000,
    start: at('2025-09-28T16:55:00Z'),
    end: at('2025-09-28T17:35:00Z'),
  },
  // Zero length but lots of data: end estimated from the channel bitrate.
  {
    id: 1759300000,
    username: 'dept',
    channel: 'TVP1',
    hostname: '83.9.189.7',
    client: 'SparkleTV/2.0.0 (Pixel 6, Android 14)',
    service: 'dvb-t/490MHz/TVP1',
    title: 'HTTP',
    total_in: 1_500_000_000,
    start: at('2025-10-01T18:00:00Z'),
    end: at('2025-10-01T18:00:00Z'),
  },
  // Closed far too early by the old tracker (9 GB in 2 minutes): suspicious.
  {
    id: 1759400000,
    username: 'benrath',
    channel: 'TVP1',
    hostname: '62.227.88.150',
    client: 'SparkleTV/1.9.6 (AFTMM, Android 7.1.2)',
    service: 'dvb-t/490MHz/TVP1',
    title: 'HTTP',
    total_in: 9_000_000_000,
    start: at('2025-10-02T18:00:00Z'),
    end: at('2025-10-02T18:02:00Z'),
  },
  // Never closed (no sub_key): counted with zero length.
  {
    id: 1759500000,
    username: 'michal',
    channel: 'TV4',
    hostname: '77.65.111.65',
    client: 'SparkleTV/1.9.6 (AFTMM, Android 7.1.2)',
    service: 'dvb-t/530MHz/TV4',
    title: 'HTTP',
    total_in: 1000,
    start: at('2025-10-03T18:00:00Z'),
    end: null,
  },
  // Recorded by the fork and still open at switch-over: left open for the live monitor.
  {
    id: 1759500001,
    username: 'sawa',
    channel: 'TVP Info',
    hostname: '5.173.156.48',
    client: 'SparkleTV/2.1.1 (Pixel 8, Android 17)',
    service: 'dvb-t/490MHz/TVP Info',
    title: 'HTTP',
    total_in: 500_000_000,
    start: at('2026-10-07T08:00:00Z'),
    end: null,
    sub_key: '1791360000-12',
  },
  // Failed start: 20 s, almost no data.
  {
    id: 1759600000,
    username: 'kapi',
    channel: 'Polsat',
    hostname: '77.65.111.65',
    client: 'SparkleTV/1.9.6 (AFTMM, Android 7.1.2)',
    service: 'dvb-t/530MHz/Polsat',
    title: 'HTTP',
    total_in: 2000,
    start: at('2025-10-04T18:00:00Z'),
    end: at('2025-10-04T18:00:20Z'),
  },
  // Anonymous LAN viewer and a zapping sequence for visits.
  {
    id: 1759700000,
    username: '',
    channel: 'TVP2',
    hostname: '192.168.1.56',
    client: 'VLC/3.0.20 LibVLC/3.0.20',
    service: 'dvb-t/490MHz/TVP2',
    title: 'HTTP',
    total_in: 300_000_000,
    start: at('2025-10-05T18:00:00Z'),
    end: at('2025-10-05T18:10:00Z'),
  },
  {
    id: 1759800000,
    username: 'kapi',
    channel: 'TVN',
    hostname: '77.65.111.65',
    client: 'SparkleTV/1.9.6 (AFTMM, Android 7.1.2)',
    service: 'dvb-t/530MHz/TVN',
    title: 'HTTP',
    total_in: 10_000_000,
    start: at('2025-10-06T18:00:00Z'),
    end: at('2025-10-06T18:00:20Z'),
  },
  {
    id: 1759800001,
    username: 'kapi',
    channel: 'TVP1',
    hostname: '77.65.111.65',
    client: 'SparkleTV/1.9.6 (AFTMM, Android 7.1.2)',
    service: 'dvb-t/490MHz/TVP1',
    title: 'HTTP',
    total_in: 1_000_000_000,
    start: at('2025-10-06T18:00:30Z'),
    end: at('2025-10-06T19:00:00Z'),
  },
  // Unreadable start.
  {
    id: 1759900000,
    username: 'kapi',
    channel: 'TVP1',
    hostname: '77.65.111.65',
    client: 'SparkleTV/1.9.6',
    service: 'dvb-t/490MHz/TVP1',
    title: 'HTTP',
    total_in: 5,
    start: 'not a date',
    end: null,
  },
];

/** More plausible TVP1 sessions so the per-channel bitrate model has enough samples (4.8 Mbit/s). */
function bitrateSamples(): LegacyFixtureRow[] {
  return Array.from({ length: 6 }, (_, i) => ({
    id: 1758000000 + i,
    username: 'kapi',
    channel: 'TVP1',
    hostname: '77.65.111.65',
    client: 'SparkleTV/1.9.6 (AFTMM, Android 7.1.2)',
    service: 'dvb-t/490MHz/TVP1',
    title: 'HTTP',
    total_in: 600_000_000,
    start: at(`2025-09-1${i}T18:00:00Z`),
    end: at(`2025-09-1${i}T18:16:40Z`),
  }));
}

export const FIXTURE_CONFIG: Record<string, string | null> = {
  protocol: 'http',
  hostname: '192.168.1.10',
  port: '9981',
  username: 'spy',
  password: SECRET_PASSWORD,
  auth: 'plain',
  ip_allowed: '192.168.1.70, not-an-ip',
  minimum_time: '10',
  debug_mode: '0',
  language: 'es',
  telegram_notification: '1',
  telegram_bot_token: SECRET_TOKEN,
  telegram_id: '987654',
  telegram_notification_start_playback: '0',
  telegram_notification_start_playback_text: 'secret template %%username%%',
  telegram_notification_time: '1',
  telegram_notification_time_text: '%%username%% is watching long',
  telegram_time_limit: '5',
  telegram_notification_ip_not_allowed: '0',
};

export function createLegacyDb(
  path: string,
  opts: { withSubKey?: boolean; extraRows?: LegacyFixtureRow[] } = {},
) {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS config (name TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS registries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT, channel TEXT, hostname TEXT, client TEXT, service TEXT, title TEXT,
      errors INTEGER, total_in INTEGER, start DATETIME, end DATETIME,
      notification_time BOOLEAN, notification_ip BOOLEAN
    );
  `);
  const withSubKey = opts.withSubKey ?? true;
  if (withSubKey) {
    db.exec('ALTER TABLE registries ADD COLUMN sub_key TEXT');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_registries_sub_key ON registries(sub_key)');
  }
  const insertConfig = db.prepare('INSERT INTO config (name, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(FIXTURE_CONFIG)) insertConfig.run(k, v);

  const rows = [...bitrateSamples(), ...FIXTURE_ROWS, ...(opts.extraRows ?? [])];
  const insert = db.prepare(
    `INSERT INTO registries (id, username, channel, hostname, client, service, title, errors, total_in, start, end,
       notification_time, notification_ip${withSubKey ? ', sub_key' : ''})
     VALUES (@id, @username, @channel, @hostname, @client, @service, @title, 0, @total_in, @start, @end, 0, 0${
       withSubKey ? ', @sub_key' : ''
     })`,
  );
  for (const r of rows) {
    const { sub_key, ...fields } = r;
    insert.run(withSubKey ? { ...fields, sub_key: sub_key ?? null } : fields);
  }
  db.close();
  return rows;
}
