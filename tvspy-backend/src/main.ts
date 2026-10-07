import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { migrate } from './db/migrate.js';
import { openDb } from './db/open.js';
import { readEnv } from './env.js';
import { createLogger } from './log.js';

const env = readEnv();
const log = createLogger(env.logLevel);

mkdirSync(env.dataDir, { recursive: true });
const db = openDb(join(env.dataDir, 'tvspy.db'), { journal: env.journal });
const { from, to } = migrate(db);
log.info(
  `tvspy ${env.version}${env.commit ? ` (${env.commit})` : ''}, time zone ${env.tz}, database schema v${to}` +
    (from !== to ? ` (migrated from v${from})` : ''),
);

const app = new Hono();
app.get('/api/health', (c) => c.json({ ok: true, version: env.version, commit: env.commit, schema: to }));
app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404));
app.onError((err, c) => {
  log.error('Request failed', err);
  return c.json({ error: { code: 'INTERNAL', message: 'Internal error' } }, 500);
});

const server = serve({ fetch: app.fetch, port: env.port }, (info) =>
  log.info(`Listening on port ${info.port}`),
);

const shutdown = (signal: string) => {
  log.info(`${signal} received, shutting down`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
