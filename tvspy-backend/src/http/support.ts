// Shared HTTP plumbing: the app's dependencies, error type, JSON body/query validation and helpers.

import type { IncomingMessage } from 'node:http';
import type { ErrorCode } from '@tvspy/shared';
import type { Context } from 'hono';
import type { z } from 'zod';
import type { Outbox } from '../alerts/outbox.js';
import type { FetchLike } from '../alerts/telegram.js';
import type { AuthService, LoginLimiter } from '../auth/service.js';
import type { Catalog } from '../collect/catalog.js';
import type { LogoCache } from '../collect/logos.js';
import type { SessionTracker } from '../collect/sessions.js';
import type { TunerMonitor } from '../collect/tuners.js';
import type { TvhState } from '../collect/tvhState.js';
import type { DB } from '../db/open.js';
import type { Logger } from '../log.js';
import type { SettingsStore } from '../settings/store.js';

export type AppEnv = {
  Bindings: { incoming?: IncomingMessage };
  Variables: { username: string; token: string };
};

export interface AppDeps {
  db: DB;
  version: string;
  commit: string | null;
  tz: string;
  /** False when TVSPY_TELEGRAM=off. */
  telegramAllowed: boolean;
  settings: SettingsStore;
  auth: AuthService;
  limiter: LoginLimiter;
  log: Logger;
  tvh: TvhState;
  tracker: SessionTracker;
  tuners: TunerMonitor;
  catalog: Catalog;
  logos: LogoCache;
  outbox: Outbox;
  totalTuners(now: number): number;
  /** Built frontend (index.html and assets), or null when only the API is served. */
  publicDir: string | null;
  now(): number;
  telegramFetch?: FetchLike;
  telegramApi?: string;
}

type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 415 | 429 | 500 | 502;

export class ApiError extends Error {
  constructor(
    readonly status: ErrorStatus,
    readonly code: ErrorCode,
    message: string,
    readonly fields?: Record<string, string>,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Not found') => new ApiError(404, 'NOT_FOUND', what);

export function fieldErrors(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join('.') || '_';
    fields[path] ??= issue.message;
  }
  return fields;
}

export async function readJson<S extends z.ZodType>(c: Context<AppEnv>, schema: S): Promise<z.output<S>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new ApiError(400, 'VALIDATION', 'The request body is not valid JSON');
  }
  const result = schema.safeParse(body);
  if (!result.success) throw new ApiError(400, 'VALIDATION', 'Invalid request', fieldErrors(result.error));
  return result.data;
}

export function readQuery<S extends z.ZodType>(c: Context<AppEnv>, schema: S): z.output<S> {
  const result = schema.safeParse(c.req.query());
  if (!result.success) throw new ApiError(400, 'VALIDATION', 'Invalid query', fieldErrors(result.error));
  return result.data;
}

export function clientIp(c: Context<AppEnv>): string {
  return c.env?.incoming?.socket?.remoteAddress ?? 'unknown';
}

export const iso = (t: number | null | undefined): string | null =>
  t === null || t === undefined ? null : new Date(t * 1000).toISOString();

export const isoNow = (t: number): string => new Date(t * 1000).toISOString();
