// Wires collectors, alerts and the HTTP app together. Used by main.ts and by the integration tests, so
// both run the same graph.

import { join } from 'node:path';
import { AlertEngine } from './alerts/engine.js';
import { Outbox, OutboxSender } from './alerts/outbox.js';
import type { FetchLike } from './alerts/telegram.js';
import { AuthService, LoginLimiter } from './auth/service.js';
import { Catalog } from './collect/catalog.js';
import { DailyCounters } from './collect/dailyCounters.js';
import { LogoCache } from './collect/logos.js';
import { Monitor } from './collect/monitor.js';
import { SessionTracker } from './collect/sessions.js';
import { TunerMonitor } from './collect/tuners.js';
import { TvhState } from './collect/tvhState.js';
import type { DB } from './db/open.js';
import { createApp } from './http/app.js';
import type { Logger } from './log.js';
import type { SettingsStore } from './settings/store.js';
import { TvhClient } from './tvh/client.js';

export interface ServiceOptions {
  db: DB;
  settings: SettingsStore;
  log: Logger;
  dataDir: string;
  tz: string;
  version: string;
  commit: string | null;
  telegramAllowed: boolean;
  publicDir: string | null;
  now?: () => number;
  scryptCost?: number;
  telegramFetch?: FetchLike;
  telegramApi?: string;
}

export function createServices(o: ServiceOptions) {
  const { db, settings, log, tz } = o;
  const now = o.now ?? (() => Math.floor(Date.now() / 1000));

  const auth = new AuthService(db, { scryptCost: o.scryptCost, now });
  const tvh = new TvhState();
  const client = new TvhClient(() => ({
    url: settings.get('tvh.url'),
    username: settings.get('tvh.username'),
    password: settings.get('tvh.password'),
    auth: settings.get('tvh.auth'),
  }));
  const catalog = new Catalog(db);
  const tuners = new TunerMonitor();
  const daily = new DailyCounters(() => tz);
  const outbox = new Outbox(db, settings, o.telegramAllowed);

  let alerts: AlertEngine | undefined;
  let monitor: Monitor | undefined;
  const tracker = new SessionTracker(
    db,
    () => ({
      tz,
      proxyCidrs: settings.get('network.proxyCidrs'),
      lanCidrs: settings.get('network.lanCidrs'),
      visitGapSec: settings.get('stats.visitGapSec'),
      channelMux: (channel) => catalog.channelByName(channel)?.mux ?? null,
    }),
    {
      onEnd: (s, endedAt, outcome) => {
        const t = now();
        alerts?.onSessionEnd(s, endedAt, outcome, t);
        const total = monitor?.totalTuners(t) ?? 0;
        if (outcome === 'failed' && total > 0 && tuners.busyForUsers(t) >= total) daily.failedWhileFull(t);
      },
    },
  );
  alerts = new AlertEngine(
    { db, settings, outbox, tvh, catalog, tuners, openSessions: () => tracker.open.values(), tz: () => tz },
    now(),
  );
  monitor = new Monitor({
    db,
    dataDir: o.dataDir,
    tz,
    settings,
    log,
    client,
    tvh,
    catalog,
    tracker,
    tuners,
    daily,
    alerts,
    sender: new OutboxSender(db, settings, outbox, o.telegramFetch, o.telegramApi),
    auth,
    now,
  });
  const running = monitor;
  const logos = new LogoCache(join(o.dataDir, 'cache', 'logos'), client, catalog, () =>
    settings.get('tvh.url'),
  );

  const app = createApp({
    db,
    version: o.version,
    commit: o.commit,
    tz,
    telegramAllowed: o.telegramAllowed,
    settings,
    auth,
    limiter: new LoginLimiter(),
    log,
    tvh,
    tracker,
    tuners,
    catalog,
    logos,
    outbox,
    totalTuners: (t) => running.totalTuners(t),
    publicDir: o.publicDir,
    now,
    telegramFetch: o.telegramFetch,
    telegramApi: o.telegramApi,
  });

  return { auth, tvh, client, catalog, tuners, daily, outbox, tracker, alerts, monitor: running, logos, app };
}

export type Services = ReturnType<typeof createServices>;
