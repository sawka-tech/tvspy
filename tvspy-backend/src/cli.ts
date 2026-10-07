// Command-line tools, run inside the container: node dist/cli.js <command> [options]

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { AuthError, AuthService, USERNAME_MAX } from './auth/service.js';
import { isValidTimeZone } from './core/time.js';
import { backupDatabase } from './db/backup.js';
import { migrate } from './db/migrate.js';
import { openDb } from './db/open.js';
import { importLegacy } from './legacy/importLegacy.js';
import { formatReport } from './legacy/report.js';

const DEFAULT_DATA_DIR = '/app/backend/src/database/file';

const USAGE = `Usage: node dist/cli.js <command>

Commands:
  import-legacy [--legacy <file>] [--data <dir>] [--tz <zone>] [--dry-run] [--repair]
      Import the old tvspy database (read-only). --dry-run imports into memory and only prints the
      report. Defaults: --legacy <data>/database.db, --data $TVSPY_DATA_DIR or ${DEFAULT_DATA_DIR},
      --tz $TZ or Europe/Warsaw.

  set-password [--user <name>] [--data <dir>]
      Create the admin account or reset its password (asks for it, or reads one line from stdin) and
      log out every browser. Default user: the existing admin, or "admin".

  backup [--data <dir>]
      Write a consistent copy of tvspy.db to <data>/backups/tvspy-manual-<time>.db.
`;

/** Reads a line without echoing it on a terminal; from a pipe, reads the first line. */
async function readSecret(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    let data = '';
    for await (const chunk of stdin) data += String(chunk);
    return data.split(/\r?\n/)[0] ?? '';
  }
  process.stdout.write(question);
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (err?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stdout.write('\n');
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u0003') return finish(new Error('Cancelled'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

const dataDirOf = (data: string | undefined) => data ?? process.env.TVSPY_DATA_DIR ?? DEFAULT_DATA_DIR;

async function setPasswordCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { user: { type: 'string' }, data: { type: 'string' } } });
  const dataDir = dataDirOf(values.data);
  mkdirSync(dataDir, { recursive: true });
  const db = openDb(join(dataDir, 'tvspy.db'));
  try {
    migrate(db);
    const existing = db.prepare('SELECT username FROM admin_user WHERE id = 1').get() as
      | { username: string }
      | undefined;
    const user = (values.user ?? existing?.username ?? 'admin').trim();
    if (!user || user.length > USERNAME_MAX) {
      console.error('Invalid user name');
      return 2;
    }
    const password = await readSecret(`New password for ${user}: `);
    if (process.stdin.isTTY && (await readSecret('Repeat it: ')) !== password) {
      console.error('The passwords differ; nothing changed');
      return 2;
    }
    await new AuthService(db).setPassword(user, password);
    console.log(`Password ${existing ? 'reset' : 'set'} for ${user}; all browser sessions were logged out.`);
    return 0;
  } catch (err) {
    if (err instanceof AuthError) {
      console.error(err.message);
      return 2;
    }
    throw err;
  } finally {
    db.close();
  }
}

async function backupCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { data: { type: 'string' } } });
  const dataDir = dataDirOf(values.data);
  const file = join(dataDir, 'tvspy.db');
  if (!existsSync(file)) {
    console.error(`No database at ${file}`);
    return 2;
  }
  const db = openDb(file);
  try {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
    console.log(
      `Backup written: ${await backupDatabase(db, join(dataDir, 'backups'), `tvspy-manual-${stamp}.db`)}`,
    );
    return 0;
  } finally {
    db.close();
  }
}

async function importLegacyCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      legacy: { type: 'string' },
      data: { type: 'string' },
      tz: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      repair: { type: 'boolean', default: false },
    },
  });
  const dataDir = dataDirOf(values.data);
  const legacyPath = values.legacy ?? join(dataDir, 'database.db');
  const tz = values.tz ?? process.env.TZ ?? 'Europe/Warsaw';
  const dryRun = values['dry-run'] ?? false;
  if (!isValidTimeZone(tz)) {
    console.error(`Unknown time zone: ${tz}`);
    return 2;
  }
  if (!existsSync(legacyPath)) {
    console.error(`Legacy database not found: ${legacyPath}`);
    return 2;
  }
  if (!dryRun) mkdirSync(dataDir, { recursive: true });

  const db = openDb(dryRun ? ':memory:' : join(dataDir, 'tvspy.db'));
  try {
    migrate(db);
    const report = await importLegacy(db, legacyPath, { tz, repair: values.repair ?? false });
    console.log(formatReport(report, { dryRun }));
    return 0;
  } finally {
    db.close();
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'import-legacy':
      return importLegacyCommand(rest);
    case 'set-password':
      return setPasswordCommand(rest);
    case 'backup':
      return backupCommand(rest);
    default:
      console.log(USAGE);
      return command && command !== 'help' && command !== '--help' ? 2 : 0;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
