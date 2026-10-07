// Command-line tools, run inside the container: node dist/cli.js <command> [options]

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { isValidTimeZone } from './core/time.js';
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
`;

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
  const dataDir = values.data ?? process.env.TVSPY_DATA_DIR ?? DEFAULT_DATA_DIR;
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
