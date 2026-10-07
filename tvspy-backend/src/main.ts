import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { toDay } from './core/time.js';
import { backupDatabase } from './db/backup.js';
import { getMeta } from './db/meta.js';
import { migrate, SCHEMA_VERSION, schemaVersion } from './db/migrate.js';
import { type DB, openDb } from './db/open.js';
import { type Env, readEnv } from './env.js';
import { importLegacy } from './legacy/importLegacy.js';
import { formatReport } from './legacy/report.js';
import { createLogger, type Logger } from './log.js';
import { createServices } from './services.js';
import { SettingsStore } from './settings/store.js';

const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * Imports the old tvspy database (read-only) when it changed since the last import: on the first start
 * after the switch, and again after running the old version for a while (rollback).
 */
async function importLegacyIfChanged(db: DB, env: Env, settings: SettingsStore, log: Logger): Promise<void> {
  const legacyPath = join(env.dataDir, 'database.db');
  if (!existsSync(legacyPath)) return;
  const st = statSync(legacyPath);
  const previous = getMeta(db, 'legacy_import');
  if (previous) {
    const p = JSON.parse(previous) as { size?: number; mtime?: number };
    if (p.size === st.size && p.mtime === Math.floor(st.mtimeMs / 1000)) return;
  }
  log.info(`Importing the old tvspy database ${legacyPath} (read-only)`);
  const report = await importLegacy(db, legacyPath, {
    tz: env.tz,
    repair: true,
    historicalTuners: settings.get('stats.historicalTuners'),
  });
  for (const line of formatReport(report, { dryRun: false }).split('\n')) if (line.trim()) log.info(line);
}

async function main(): Promise<void> {
  const env = readEnv();
  const log = createLogger(env.logLevel);
  mkdirSync(env.dataDir, { recursive: true });

  const db = openDb(join(env.dataDir, 'tvspy.db'), { journal: env.journal });
  const before = schemaVersion(db);
  if (before > 0 && before < SCHEMA_VERSION) {
    const name = `tvspy-pre-v${SCHEMA_VERSION}-${toDay(nowSec(), env.tz)}.db`;
    const file = await backupDatabase(db, join(env.dataDir, 'backups'), name);
    log.info(`Backed up the database before migrating: ${file}`);
  }
  const { from, to } = migrate(db);
  log.info(
    `tvspy ${env.version}${env.commit ? ` (${env.commit})` : ''}, time zone ${env.tz}, database schema v${to}` +
      (from !== to ? ` (migrated from v${from})` : ''),
  );

  const settings = new SettingsStore(db, (key, reason) =>
    log.warn(`Stored setting ${key} ignored: ${reason}`),
  );
  await importLegacyIfChanged(db, env, settings, log);
  settings.reload(); // the import may have added settings from the old version
  if (!env.logLevelFromEnv) log.setLevel(settings.get('log.level'));

  const services = createServices({
    db,
    settings,
    log,
    dataDir: env.dataDir,
    tz: env.tz,
    version: env.version,
    commit: env.commit,
    telegramAllowed: env.telegramEnabled,
    publicDir: env.publicDir,
  });
  log.info(
    `Opens without login from ${settings.get('access.openNetworks').join(', ')}` +
      (services.auth.hasAdmin() ? '; password login for other networks' : '; other networks are refused'),
  );
  if (!env.telegramEnabled) log.info('Telegram is switched off for this container (TVSPY_TELEGRAM=off)');
  if (services.tracker.open.size > 0) log.info(`Resuming ${services.tracker.open.size} open session(s)`);

  services.monitor.start();
  const server = serve({ fetch: services.app.fetch, port: env.port, hostname: env.host }, (info) =>
    log.info(`Listening on port ${info.port}`),
  );

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal} received, shutting down`);
    setTimeout(() => process.exit(1), 8000).unref();
    try {
      await services.monitor.stop();
    } catch (err) {
      log.error('Final flush failed', err);
    }
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  console.error(`tvspy failed to start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
