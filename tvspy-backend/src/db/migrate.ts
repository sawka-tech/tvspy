import { migration001 } from './migrations/001_init.js';
import type { DB } from './open.js';

export interface Migration {
  version: number;
  name: string;
  up(db: DB): void;
}

export const MIGRATIONS: readonly Migration[] = [migration001];
export const SCHEMA_VERSION = MIGRATIONS.length;

export function schemaVersion(db: DB): number {
  return Number(db.pragma('user_version', { simple: true }));
}

function minCompatible(db: DB, fallback: number): number {
  try {
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'min_compatible_schema'`).get() as
      | { value: string }
      | undefined;
    return row ? Number(row.value) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Applies pending migrations, each in its own transaction. A database written by a newer tvspy is used
 * as-is when its migrations were additive (meta.min_compatible_schema <= ours); otherwise startup stops,
 * so rolling back the image can never damage data.
 */
export function migrate(db: DB): { from: number; to: number } {
  const from = schemaVersion(db);
  if (from > SCHEMA_VERSION) {
    if (minCompatible(db, from) > SCHEMA_VERSION) {
      throw new Error(
        `The database (schema v${from}) needs a newer tvspy; this version understands up to v${SCHEMA_VERSION}.`,
      );
    }
    return { from, to: from };
  }
  for (const m of MIGRATIONS) {
    if (m.version <= from) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      m.up(db);
      db.pragma(`user_version = ${m.version}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return { from, to: SCHEMA_VERSION };
}
