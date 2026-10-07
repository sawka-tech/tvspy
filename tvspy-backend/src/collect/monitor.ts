// Scheduler: chained timers (a run never overlaps itself) for every collector, alerts, flushing,
// maintenance and the nightly backup.

import { join } from 'node:path';
import type { AlertEngine } from '../alerts/engine.js';
import type { OutboxSender } from '../alerts/outbox.js';
import type { AuthService } from '../auth/service.js';
import { localParts, toDay } from '../core/time.js';
import { backupDatabase, nightlyBackups, pruneNightly } from '../db/backup.js';
import type { DB } from '../db/open.js';
import type { Logger } from '../log.js';
import type { SettingKey } from '../settings/schema.js';
import type { SettingsStore } from '../settings/store.js';
import { fetchInputs, fetchServerInfo, fetchSubscriptions } from '../tvh/api.js';
import { type TvhClient, TvhError } from '../tvh/client.js';
import type { Catalog } from './catalog.js';
import type { DailyCounters } from './dailyCounters.js';
import type { SessionTracker } from './sessions.js';
import { isIptvInput, type TunerMonitor } from './tuners.js';
import type { TvhState } from './tvhState.js';

export const RECEPTION_MINUTES_KEEP_DAYS = 90;
const BACKUP_AT_MINUTES = 3 * 60 + 30;
const BACKUPS_KEEP = 7;

class Loop {
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<void> | null = null;
  private again = false;
  private stopped = false;

  constructor(
    readonly name: string,
    private readonly everyMs: number,
    private readonly fn: () => unknown,
    private readonly onError: (name: string, err: unknown) => void,
  ) {}

  start(delayMs = 0): void {
    this.schedule(delayMs);
  }

  /** Runs as soon as possible (after the current run, if one is in progress). */
  trigger(): void {
    if (this.stopped) return;
    if (this.current) this.again = true;
    else this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.current;
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.current = this.run().finally(() => {
        this.current = null;
        const next = this.again ? 0 : this.everyMs;
        this.again = false;
        this.schedule(next);
      });
    }, ms);
  }

  private async run(): Promise<void> {
    try {
      await this.fn();
    } catch (err) {
      this.onError(this.name, err);
    }
  }
}

export interface MonitorDeps {
  db: DB;
  dataDir: string;
  tz: string;
  settings: SettingsStore;
  log: Logger;
  client: TvhClient;
  tvh: TvhState;
  catalog: Catalog;
  tracker: SessionTracker;
  tuners: TunerMonitor;
  daily: DailyCounters;
  alerts: AlertEngine;
  sender: OutboxSender;
  auth: AuthService;
  now?: () => number;
}

export class Monitor {
  private loops = new Map<string, Loop>();
  private lastError = new Map<string, string>();
  private lastCatalogKey = '';

  constructor(private readonly d: MonitorDeps) {}

  now(): number {
    return this.d.now ? this.d.now() : Math.floor(Date.now() / 1000);
  }

  start(): void {
    const add = (name: string, everyMs: number, fn: () => unknown, delayMs = 0) => {
      const loop = new Loop(name, everyMs, fn, (n, err) => this.reportError(n, err));
      this.loops.set(name, loop);
      loop.start(delayMs);
    };
    add('subscriptions', 3_000, () => this.pollSubscriptions());
    add('inputs', 5_000, () => this.pollInputs(), 500);
    add('serverinfo', 60_000, () => this.pollServerInfo(), 1_000);
    add('catalog', 15 * 60_000, () => this.refreshCatalog(), 1_500);
    add('alerts', 15_000, () => this.d.alerts.evaluate(this.now()), 5_000);
    add('outbox', 2_000, () => this.d.sender.tick(this.now()), 3_000);
    add('flush', 30_000, () => this.flush(), 30_000);
    add('maintenance', 60 * 60_000, () => this.maintenance(), 5 * 60_000);
    add('backup', 60_000, () => this.backupIfDue(), 60_000);

    this.d.settings.on('change', (keys: SettingKey[]) => {
      if (keys.some((k) => k.startsWith('tvh.'))) {
        this.lastError.delete('subscriptions');
        this.loops.get('subscriptions')?.trigger();
        this.loops.get('serverinfo')?.trigger();
        this.loops.get('catalog')?.trigger();
      }
      if (keys.includes('log.level')) this.d.log.setLevel(this.d.settings.get('log.level'));
    });
  }

  /** Stops all loops, waits for running ones and writes everything that is still in memory. */
  async stop(): Promise<void> {
    await Promise.all([...this.loops.values()].map((l) => l.stop()));
    this.flush(true);
  }

  /** Tuners to compare against: the configured number, otherwise those TVH currently lists. */
  totalTuners(now: number): number {
    return this.d.settings.get('monitoring.tunersExpected') || this.d.tuners.snapshots(now).length;
  }

  private reportError(name: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    if (this.lastError.get(name) === message) return;
    this.lastError.set(name, message);
    this.d.log.warn(`${name}: ${message}`);
  }

  async pollSubscriptions(): Promise<void> {
    const { tvh, tracker, tuners, daily, alerts, log } = this.d;
    const now = this.now();
    try {
      const subs = await fetchSubscriptions(this.d.client);
      const wasConnected = tvh.connected;
      tvh.markOk(now);
      if (!wasConnected) {
        log.info('Connected to TVHeadend');
        this.lastError.delete('subscriptions');
        // (Re)connected, possibly to another server: refresh what only changes slowly.
        this.loops.get('serverinfo')?.trigger();
        this.loops.get('catalog')?.trigger();
      }
      tracker.update(subs, now);
      alerts.onPoll(now);
      daily.tick(now, {
        tvhUp: true,
        streams: tracker.open.size,
        busyTuners: tuners.busyForUsers(now),
        totalTuners: this.totalTuners(now),
      });
    } catch (err) {
      const wasConnected = tvh.connected;
      tvh.markFail(err, now);
      daily.tick(now, { tvhUp: false, streams: 0, busyTuners: 0, totalTuners: 0 });
      if (err instanceof TvhError && err.kind === 'not_configured') return;
      if (wasConnected) log.warn(`Lost TVHeadend: ${tvh.error}`);
      else this.reportError('subscriptions', err);
    }
  }

  async pollInputs(): Promise<void> {
    if (!this.d.tvh.connected) return;
    // Only antenna tuners: IPTV streams (internet radio) show up as inputs too.
    const inputs = (await fetchInputs(this.d.client)).filter(
      (i) => !isIptvInput(i.tuner) && !this.d.catalog.isIptvMux(i.mux),
    );
    this.d.tuners.update(inputs, this.now());
  }

  async pollServerInfo(): Promise<void> {
    if (!this.d.tvh.connected) return;
    const { version } = await fetchServerInfo(this.d.client);
    if (version !== this.d.tvh.version) this.d.log.info(`TVHeadend version ${version ?? 'unknown'}`);
    this.d.tvh.version = version;
  }

  async refreshCatalog(): Promise<void> {
    if (!this.d.tvh.connected) return;
    await this.d.catalog.refresh(this.d.client, this.now());
    const key = `${this.d.catalog.channelCount()} channels, ${this.d.catalog.monitoredMuxes().length} monitored muxes`;
    if (key !== this.lastCatalogKey) this.d.log.info(`TVHeadend catalog: ${key}`);
    this.lastCatalogKey = key;
  }

  /** Writes accumulated usage, reception minutes and daily counters (every 30 s and on shutdown). */
  flush(final = false): void {
    const now = this.now();
    this.d.tracker.flush();
    this.d.tuners.flush(this.d.db, now, final);
    this.d.daily.flush(this.d.db);
  }

  maintenance(): void {
    const { db, auth } = this.d;
    const now = this.now();
    auth.pruneExpired();
    db.prepare('DELETE FROM reception_minute WHERE ts < ?').run(now - RECEPTION_MINUTES_KEEP_DAYS * 86400);
    // Hourly reception summaries (kept forever) for the last few completed hours; idempotent.
    const hour = Math.floor(now / 3600) * 3600;
    db.prepare(
      `INSERT OR REPLACE INTO reception_hourly
         (mux, tuner, ts, minutes, locked_minutes, error_minutes, snr_min, snr_avg, snr_max, sig_med, unc, te, cc)
       SELECT mux, tuner, (ts / 3600) * 3600, COUNT(*), SUM(n_locked > 0), SUM(unc > 0 OR te > 0 OR cc > 0),
              MIN(snr_min), ROUND(AVG(snr_avg), 1), MAX(snr_max), ROUND(AVG(sig_med), 1), SUM(unc), SUM(te), SUM(cc)
       FROM reception_minute WHERE ts >= ? AND ts < ?
       GROUP BY mux, tuner, ts / 3600`,
    ).run(hour - 6 * 3600, hour);
    db.pragma('optimize');
  }

  async backupIfDue(): Promise<void> {
    const now = this.now();
    const { hour, minute } = localParts(now, this.d.tz);
    if (hour * 60 + minute < BACKUP_AT_MINUTES) return;
    const today = toDay(now, this.d.tz);
    const dir = join(this.d.dataDir, 'backups');
    if (nightlyBackups(dir).includes(today)) return;
    const file = await backupDatabase(this.d.db, dir, `tvspy-${today}.db`);
    const removed = pruneNightly(dir, BACKUPS_KEEP);
    this.d.log.info(`Backup written: ${file}${removed.length ? ` (removed ${removed.join(', ')})` : ''}`);
  }
}
