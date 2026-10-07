import Database from 'better-sqlite3';

export type DB = Database.Database;

export interface OpenOptions {
  /** WAL by default; "delete" is a fallback for filesystems where WAL's shared memory misbehaves. */
  journal?: 'wal' | 'delete';
  readonly?: boolean;
}

export function openDb(file: string, opts: OpenOptions = {}): DB {
  if (opts.readonly) {
    const db = new Database(file, { readonly: true, fileMustExist: true });
    db.pragma('query_only = ON');
    return db;
  }
  const db = new Database(file);
  db.pragma(`journal_mode = ${opts.journal === 'delete' ? 'DELETE' : 'WAL'}`);
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}
