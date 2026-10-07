import { beforeEach, describe, expect, it } from 'vitest';
import { AlertEngine, MUX_STARTUP_GRACE_SEC, TVH_STARTUP_GRACE_SEC } from '../../src/alerts/engine.js';
import { escapeHtml, formatDuration } from '../../src/alerts/messages.js';
import { EXPIRE_SEC, Outbox, OutboxSender } from '../../src/alerts/outbox.js';
import type { FetchLike } from '../../src/alerts/telegram.js';
import { Catalog } from '../../src/collect/catalog.js';
import type { TrackedSession } from '../../src/collect/sessions.js';
import { TunerMonitor } from '../../src/collect/tuners.js';
import { TvhState } from '../../src/collect/tvhState.js';
import { migrate } from '../../src/db/migrate.js';
import { type DB, openDb } from '../../src/db/open.js';
import { SettingsStore } from '../../src/settings/store.js';
import { TvhError } from '../../src/tvh/client.js';

const T0 = 1_790_000_000;
const TOKEN = '123456:ABC-def_ghi';

let db: DB;
let settings: SettingsStore;
beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
  settings = new SettingsStore(db);
  settings.update({ 'telegram.enabled': true, 'telegram.botToken': TOKEN, 'telegram.chatId': '42' });
});

const notifications = () =>
  db
    .prepare('SELECT rule, dedupe_key, status, text, attempts, last_error FROM notifications ORDER BY id')
    .all() as {
    rule: string;
    dedupe_key: string;
    status: string;
    text: string;
    attempts: number;
    last_error: string | null;
  }[];

function session(over: Partial<TrackedSession> = {}): TrackedSession {
  return {
    id: 1,
    subKey: `${T0}-1`,
    kind: 'stream',
    username: 'kapi',
    channel: 'TVP1',
    title: 'HTTP',
    client: 'SparkleTV/1.9.6',
    app: 'SparkleTV',
    appVersion: '1.9.6',
    device: 'Fire TV Stick 4K',
    platform: 'Android 7.1.2',
    ip: '77.65.111.65',
    route: 'direct',
    tuner: 'Si2168 #0',
    mux: '490MHz',
    startedAt: T0,
    lastSeenAt: T0,
    bytes: 0,
    lastVolume: null,
    bytesIn: 0,
    bytesOut: null,
    errors: 0,
    rateBps: 0,
    rateHistory: [],
    newDevice: false,
    newIp: false,
    ...over,
  };
}

describe('outbox', () => {
  it('stores each event once and suppresses messages Telegram cannot send', () => {
    const outbox = new Outbox(db, settings, true);
    expect(outbox.enqueue({ rule: 'x', dedupeKey: 'k1', text: 'a' }, T0)).toBe(true);
    expect(outbox.enqueue({ rule: 'x', dedupeKey: 'k1', text: 'a' }, T0)).toBe(false);
    settings.update({ 'telegram.enabled': false });
    outbox.enqueue({ rule: 'x', dedupeKey: 'k2', text: 'b' }, T0);
    settings.update({ 'telegram.enabled': true, 'telegram.chatId': '' });
    outbox.enqueue({ rule: 'x', dedupeKey: 'k3', text: 'c' }, T0);
    new Outbox(db, settings, false).enqueue({ rule: 'x', dedupeKey: 'k4', text: 'd' }, T0);
    expect(notifications().map((n) => [n.dedupe_key, n.status, n.last_error])).toEqual([
      ['k1', 'pending', null],
      ['k2', 'suppressed', 'Telegram notifications are disabled'],
      ['k3', 'suppressed', 'Telegram is not configured'],
      ['k4', 'suppressed', 'Telegram is switched off for this container (TVSPY_TELEGRAM=off)'],
    ]);
  });
});

describe('Telegram sender', () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  let replies: (() => Response | Promise<Response>)[];
  const fakeFetch: FetchLike = async (url, init) => {
    calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    const next = replies.shift();
    if (!next) throw new Error('unexpected call');
    return next();
  };
  const ok = () => new Response(JSON.stringify({ ok: true, result: {} }));
  const fail = (status: number, extra: Record<string, unknown> = {}) =>
    new Response(JSON.stringify({ ok: false, description: `Error ${status}`, ...extra }), { status });

  beforeEach(() => {
    calls.length = 0;
    replies = [];
  });

  it('sends pending messages as HTML to the configured chat', async () => {
    const outbox = new Outbox(db, settings, true);
    const sender = new OutboxSender(db, settings, outbox, fakeFetch);
    outbox.enqueue({ rule: 'x', dedupeKey: 'a', text: '<b>hi</b>' }, T0);
    replies.push(ok);
    expect(await sender.tick(T0)).toBe(1);
    expect(calls[0]?.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(calls[0]?.body).toMatchObject({ chat_id: '42', text: '<b>hi</b>', parse_mode: 'HTML' });
    expect(notifications()[0]).toMatchObject({ status: 'sent', attempts: 1 });
  });

  it('retries with backoff, honours 429 and gives up on permanent errors', async () => {
    const outbox = new Outbox(db, settings, true);
    const sender = new OutboxSender(db, settings, outbox, fakeFetch);
    outbox.enqueue({ rule: 'x', dedupeKey: 'a', text: 'one' }, T0);
    replies.push(() => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    });
    await sender.tick(T0);
    expect(notifications()[0]).toMatchObject({
      status: 'pending',
      attempts: 1,
      last_error: 'Cannot reach Telegram (ECONNRESET)',
    });
    expect(await sender.tick(T0 + 5)).toBe(0); // not due yet (10 s backoff)
    expect(calls).toHaveLength(1);
    replies.push(() => fail(429, { parameters: { retry_after: 120 } }));
    await sender.tick(T0 + 10);
    const due = db.prepare('SELECT next_attempt_at FROM notifications').get() as { next_attempt_at: number };
    expect(due.next_attempt_at).toBe(T0 + 130);
    replies.push(() => fail(400));
    await sender.tick(T0 + 130);
    expect(notifications()[0]).toMatchObject({
      status: 'failed',
      attempts: 3,
      last_error: 'Telegram: Error 400',
    });
  });

  it('drops messages that could not be sent within an hour', async () => {
    const outbox = new Outbox(db, settings, true);
    const sender = new OutboxSender(db, settings, outbox, fakeFetch);
    outbox.enqueue({ rule: 'x', dedupeKey: 'a', text: 'old' }, T0);
    await sender.tick(T0 + EXPIRE_SEC + 1);
    expect(calls).toHaveLength(0);
    expect(notifications()[0]).toMatchObject({
      status: 'failed',
      last_error: 'Expired before it could be sent',
    });
  });

  it('suppresses queued messages when Telegram is switched off meanwhile', async () => {
    const outbox = new Outbox(db, settings, true);
    const sender = new OutboxSender(db, settings, outbox, fakeFetch);
    outbox.enqueue({ rule: 'x', dedupeKey: 'a', text: 'one' }, T0);
    settings.update({ 'telegram.enabled': false });
    await sender.tick(T0);
    expect(calls).toHaveLength(0);
    expect(notifications()[0]?.status).toBe('suppressed');
  });
});

describe('alert rules', () => {
  let tvh: TvhState;
  let catalog: Catalog;
  let tuners: TunerMonitor;
  let open: TrackedSession[];
  const engine = (startedAt = T0) =>
    new AlertEngine(
      {
        db,
        settings,
        outbox: new Outbox(db, settings, true),
        tvh,
        catalog,
        tuners,
        openSessions: () => open,
        tz: () => 'Europe/Warsaw',
      },
      startedAt,
    );
  beforeEach(() => {
    tvh = new TvhState();
    tvh.markOk(T0);
    catalog = new Catalog(db);
    tuners = new TunerMonitor();
    open = [];
    settings.update({
      'rules.playbackStart.enabled': true,
      'rules.playbackStop.enabled': true,
      'rules.recordingStart.enabled': true,
      'rules.recordingStop.enabled': true,
    });
  });

  it('reports playback start after the minimum length and the matching stop', () => {
    const e = engine();
    const s = session({ username: 'a<b>' });
    open = [s];
    e.onPoll(T0 + 3);
    expect(notifications()).toEqual([]);
    s.lastSeenAt = T0 + 12;
    e.onPoll(T0 + 12);
    e.onPoll(T0 + 15);
    s.bytes = 2_500_000_000;
    e.onSessionEnd(s, T0 + 3725, 'ok', T0 + 3728);
    expect(notifications().map((n) => [n.dedupe_key, n.text])).toEqual([
      [
        'playbackStart:1',
        '▶️ <b>a&lt;b&gt;</b> is watching <b>TVP1</b>\nSparkleTV on Fire TV Stick 4K · 77.65.111.65',
      ],
      ['playbackStop:1', '⏹ <b>a&lt;b&gt;</b> stopped watching <b>TVP1</b> after 1 h 2 min (2.5 GB)'],
    ]);
  });

  it('skips zapping blips and sessions the old tvspy started', () => {
    db.prepare(
      `INSERT INTO sessions (id, sub_key, source, kind, started_at, start_day, last_seen_at) VALUES (7, 'k', 'legacy', 'stream', ?, '2026-09-22', ?)`,
    ).run(T0, T0);
    const e = engine();
    const blip = session({ id: 2 });
    const legacy = session({ id: 7, lastSeenAt: T0 + 60 });
    open = [blip, legacy];
    e.onPoll(T0 + 60);
    e.onSessionEnd(blip, T0 + 4, 'ok', T0 + 6);
    e.onSessionEnd(legacy, T0 + 60, 'ok', T0 + 63);
    expect(notifications()).toEqual([]);
  });

  it('reports a recording that got no data even when it was short', () => {
    const e = engine();
    e.onSessionEnd(
      session({ kind: 'recording', title: 'DVR: Fakty', channel: 'TVN' }),
      T0 + 9,
      'failed',
      T0 + 10,
    );
    expect(notifications()[0]?.text).toBe(
      '⚠️ Recording failed: <b>Fakty</b> on <b>TVN</b> received almost no data',
    );
  });

  it('reports a long visit once, counting zapping', () => {
    settings.update({ 'rules.longWatch.enabled': true, 'rules.longWatch.limitMinutes': 60 });
    for (const [id, start] of [
      [1, T0],
      [2, T0 + 1800],
    ] as const) {
      db.prepare(
        `INSERT INTO sessions (id, sub_key, source, kind, started_at, start_day, last_seen_at, visit_id) VALUES (?, ?, 'live', 'stream', ?, '2026-09-22', ?, 1)`,
      ).run(id, `k${id}`, start, start);
    }
    const e = engine();
    const s = session({ id: 2, startedAt: T0 + 1800, lastSeenAt: T0 + 3599 });
    open = [s];
    e.evaluate(T0 + 3599);
    expect(notifications()).toEqual([]);
    s.lastSeenAt = T0 + 3600;
    e.evaluate(T0 + 3600);
    e.evaluate(T0 + 3700);
    expect(notifications().map((n) => n.dedupe_key)).toEqual(['longWatch:1']);
    expect(notifications()[0]?.text).toContain('has been watching for 1 h, now <b>TVP1</b>');
  });

  it('alerts when TVHeadend stays unreachable and when it is back, also across a restart', () => {
    let e = engine(T0 - TVH_STARTUP_GRACE_SEC);
    tvh.markFail(new TvhError('network', 'Cannot reach TVHeadend (ECONNREFUSED)'), T0);
    e.evaluate(T0 + 30);
    e.evaluate(T0 + 89);
    expect(notifications()).toEqual([]);
    e.evaluate(T0 + 90);
    e.evaluate(T0 + 200);
    expect(notifications().map((n) => n.dedupe_key)).toEqual([`tvhDown:${T0}`]);
    expect(notifications()[0]?.text).toContain('TVHeadend is unreachable since');
    // tvspy restarts while TVH is still down: no repeat. Then TVH comes back; the message covers the
    // whole outage, not just the part after the restart.
    tvh = new TvhState();
    tvh.markFail(new TvhError('network', 'still down'), T0 + 305);
    e = engine(T0 + 300);
    e.evaluate(T0 + 600);
    tvh.markOk(T0 + 900);
    e.evaluate(T0 + 905);
    expect(notifications().map((n) => n.dedupe_key)).toEqual([`tvhDown:${T0}`, `tvhUp:${T0}`]);
    expect(notifications()[1]?.text).toBe('🟢 TVHeadend is reachable again after 15 min');
    const incident = db.prepare('SELECT kind, started_at, ended_at FROM incidents').get();
    expect(incident).toEqual({ kind: 'tvhDown', started_at: T0, ended_at: T0 + 905 });
  });

  it('does not alert for short outages or during the startup grace', () => {
    const e = engine(T0);
    tvh.markFail(new TvhError('network', 'x'), T0 + 10);
    e.evaluate(T0 + 120);
    tvh.markOk(T0 + 130);
    e.evaluate(T0 + 135);
    expect(notifications()).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM incidents').get()).toEqual({ n: 0 });
  });

  it('says when TVHeadend rejects the login', () => {
    const e = engine(T0 - TVH_STARTUP_GRACE_SEC);
    tvh.markFail(new TvhError('auth', 'TVHeadend rejected the login (HTTP 401)', 401), T0);
    e.evaluate(T0 + 100);
    expect(notifications()[0]?.text).toContain("TVHeadend rejects tvspy's login");
  });

  it('alerts when a mux had no reception for 27 h and when it is back', () => {
    const now = T0 + MUX_STARTUP_GRACE_SEC;
    db.prepare(
      `INSERT INTO muxes (name, label, monitored, services_last_seen, updated_at) VALUES ('490MHz', 'MUX-3', 1, ?, ?), ('530MHz', NULL, 1, ?, ?)`,
    ).run(now - 28 * 3600, now, now - 3600, now);
    catalog = new Catalog(db);
    catalog.loadedAt = now;
    const e = engine(T0);
    e.evaluate(now);
    e.evaluate(now + 15);
    expect(notifications().map((n) => n.dedupe_key)).toEqual([`muxStale:490MHz:${now - 28 * 3600}`]);
    expect(notifications()[0]?.text).toContain('No reception on <b>MUX-3 (490MHz)</b> for 28 h');
    // A viewer tunes the mux successfully.
    db.prepare(
      `INSERT INTO reception_minute (mux, tuner, ts, n, n_locked, subs_max, weight_max, unc, te, cc) VALUES ('490MHz', 't', ?, 12, 12, 1, 150, 0, 0, 0)`,
    ).run(now + 60);
    e.evaluate(now + 200);
    expect(notifications().map((n) => n.rule)).toEqual(['muxStale', 'muxStale']);
    expect(notifications()[1]?.text).toContain('Reception on <b>MUX-3 (490MHz)</b> is back');
  });
});

describe('message formatting', () => {
  it('escapes HTML and formats durations', () => {
    expect(escapeHtml(`<a href="x">&</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
    expect([45, 60, 3600, 3720, 100_000, 8_035_200].map(formatDuration)).toEqual([
      '45 s',
      '1 min',
      '1 h',
      '1 h 2 min',
      '27 h 46 min',
      '93 d',
    ]);
  });
});
