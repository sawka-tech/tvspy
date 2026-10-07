// History: server-side filtering, sorting and paging. Only fixed SQL fragments are concatenated;
// every value is a bound parameter.

import type { SessionSort, Sessions } from '@tvspy/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { isDay } from '../../core/time.js';
import { type SessionDbRow, sessionRow } from '../mappers.js';
import { type AppDeps, type AppEnv, notFound, readQuery } from '../support.js';

const END = 'COALESCE(s.ended_at, s.last_seen_at)';
const DURATION = `(${END} - s.started_at)`;

const SORT: Record<SessionSort, string> = {
  startedAt: 's.started_at',
  endedAt: END,
  durationSec: DURATION,
  bytes: 's.bytes',
  user: 's.username COLLATE NOCASE',
  channel: 's.channel COLLATE NOCASE',
  errors: 's.errors',
};

const day = z.string().refine(isDay, 'Use YYYY-MM-DD');
const text = z.string().trim().min(1).max(100);

const query = z.object({
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  sort: z.enum(Object.keys(SORT) as [SessionSort, ...SessionSort[]]).default('startedAt'),
  dir: z.enum(['asc', 'desc']).default('desc'),
  kind: z.enum(['playback', 'recording']).optional(),
  user: text.optional(),
  channel: text.optional(),
  app: text.optional(),
  outcome: z.enum(['ok', 'failed']).optional(),
  from: day.optional(),
  to: day.optional(),
  minSec: z.coerce.number().int().min(0).max(86_400).optional(),
  q: text.optional(),
  visit: z.coerce.number().int().min(1).optional(),
});

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

const COLUMNS = `s.id, s.kind, s.username, s.channel, s.title, s.tuner, s.mux, s.client, s.app, s.app_version,
  s.device, s.platform, s.ip, s.route, s.country, s.started_at, s.ended_at, s.last_seen_at, s.bytes, s.errors,
  s.outcome, s.quality, s.visit_id`;

export function sessionRoutes(d: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/', (c) => {
    const q = readQuery(c, query);
    const where: string[] = [];
    const params: (string | number)[] = [];
    const add = (sql: string, ...values: (string | number)[]) => {
      where.push(sql);
      params.push(...values);
    };
    if (q.kind) add('s.kind = ?', q.kind === 'recording' ? 'recording' : 'stream');
    if (q.user) add('s.username = ?', q.user);
    if (q.channel) add('s.channel = ?', q.channel);
    if (q.app) add('s.app = ?', q.app);
    if (q.outcome) add('s.outcome = ?', q.outcome);
    if (q.from) add('s.start_day >= ?', q.from);
    if (q.to) add('s.start_day <= ?', q.to);
    if (q.minSec !== undefined) add(`${DURATION} >= ?`, q.minSec);
    if (q.visit !== undefined) add('s.visit_id = ?', q.visit);
    if (q.q) {
      const like = `%${likeEscape(q.q)}%`;
      add(
        `(s.username LIKE ? ESCAPE '\\' OR s.channel LIKE ? ESCAPE '\\' OR s.title LIKE ? ESCAPE '\\'
          OR s.ip LIKE ? ESCAPE '\\' OR s.client LIKE ? ESCAPE '\\')`,
        like,
        like,
        like,
        like,
        like,
      );
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const dir = q.dir === 'asc' ? 'ASC' : 'DESC';

    const summary = d.db
      .prepare(
        `SELECT COUNT(*) AS sessions, COUNT(DISTINCT s.visit_id) AS visits,
                COALESCE(SUM(MAX(${DURATION}, 0)), 0) AS watchSec, COALESCE(SUM(s.bytes), 0) AS bytes
         FROM sessions s ${whereSql}`,
      )
      .get(...params) as { sessions: number; visits: number; watchSec: number; bytes: number };
    const rows = d.db
      .prepare(
        `SELECT ${COLUMNS} FROM sessions s ${whereSql}
         ORDER BY ${SORT[q.sort]} ${dir}, s.id ${dir} LIMIT ? OFFSET ?`,
      )
      .all(...params, q.pageSize, (q.page - 1) * q.pageSize) as SessionDbRow[];

    const body: Sessions = {
      items: rows.map((r) => sessionRow(r, d.catalog)),
      total: summary.sessions,
      page: q.page,
      pageSize: q.pageSize,
      summary,
    };
    return c.json(body);
  });

  app.get('/:id{[0-9]+}', (c) => {
    const row = d.db
      .prepare(`SELECT ${COLUMNS} FROM sessions s WHERE s.id = ?`)
      .get(Number(c.req.param('id'))) as SessionDbRow | undefined;
    if (!row) throw notFound('No such session');
    return c.json(sessionRow(row, d.catalog));
  });

  return app;
}
