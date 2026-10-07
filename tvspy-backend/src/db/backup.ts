// Online backups with SQLite's backup API (consistent while tvspy keeps writing).

import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from './open.js';

export const NIGHTLY = /^tvspy-(\d{4}-\d{2}-\d{2})\.db$/;

export async function backupDatabase(db: DB, dir: string, name: string): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  const tmp = `${file}.tmp`;
  rmSync(tmp, { force: true });
  await db.backup(tmp);
  renameSync(tmp, file);
  return file;
}

/** Days that already have a nightly backup, oldest first. */
export function nightlyBackups(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .map((n) => NIGHTLY.exec(n)?.[1])
    .filter((d): d is string => d !== undefined)
    .sort();
}

/** Deletes the oldest nightly backups beyond `keep`; other files (e.g. pre-migration copies) stay. */
export function pruneNightly(dir: string, keep: number): string[] {
  const days = nightlyBackups(dir);
  const remove = days.slice(0, Math.max(0, days.length - keep));
  for (const day of remove) rmSync(join(dir, `tvspy-${day}.db`), { force: true });
  return remove;
}
