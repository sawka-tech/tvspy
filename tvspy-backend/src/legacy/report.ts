import type { ImportReport } from './importLegacy.js';

const n = (v: number) => v.toLocaleString('en-GB');

/** Human-readable import report. Contains counts and setting names only, never setting values. */
export function formatReport(r: ImportReport, opts: { dryRun: boolean }): string {
  const lines: string[] = [];
  const add = (s = '') => lines.push(s);

  add(`Legacy import ${opts.dryRun ? 'DRY RUN (nothing written)' : 'report'}`);
  add(`File: ${r.file.path}  (${n(r.file.sizeBytes)} bytes, modified ${r.file.modifiedAt})`);
  add(`SHA-256: ${r.file.sha256}  (opened read-only; this hash must not change)`);
  add();
  add(`Rows: ${n(r.rows)}`);
  add(`  viewing sessions  ${n(r.classes.stream).padStart(8)}   imported`);
  add(`  recordings        ${n(r.classes.recording).padStart(8)}   imported`);
  add(`  TVH-internal      ${n(r.classes.internal).padStart(8)}   NOT imported (guide updates, scans)`);
  add(`  unreadable start  ${n(r.classes.invalid).padStart(8)}   skipped`);
  add('  Cross-check (client address / user / "DVR:" title):');
  for (const [k, v] of Object.entries(r.crossTab).sort()) add(`    ${k.padEnd(36)} ${n(v).padStart(8)}`);
  add();
  add('Per year (viewing / recordings / internal):');
  for (const [year, c] of Object.entries(r.byYear).sort()) {
    if (c.stream + c.recording + c.internal === 0) continue;
    add(
      `  ${year}  ${n(c.stream).padStart(7)} / ${n(c.recording).padStart(5)} / ${n(c.internal).padStart(7)}`,
    );
  }
  add();
  add('Session end times:');
  add(`  exact as stored          ${n(r.quality.exact).padStart(7)}`);
  add(`  estimated from data      ${n(r.quality.end_estimated).padStart(7)}   (stored with zero length)`);
  add(
    `  suspicious               ${n(r.quality.end_suspect).padStart(7)}   (length contradicts data volume; ${
      r.repair ? 're-estimated (--repair)' : 'kept as stored; --repair re-estimates them'
    })`,
  );
  add(`  never closed             ${n(r.quality.unclosed).padStart(7)}   (counted with zero length)`);
  add(
    `  still open               ${n(r.quality.open).padStart(7)}   (resumed or closed by the live monitor)`,
  );
  add(`  failed starts            ${n(r.failedStarts).padStart(7)}   (no data received)`);
  add();
  add(`Watch time: ${n(r.hours.asStored)} h as stored → ${n(r.hours.imported)} h imported`);
  add(
    `  suspicious sessions: ${n(r.hours.suspectAsStored)} h as stored, ${n(r.hours.suspectIfRepaired)} h if repaired`,
  );
  add(`Data volume: ${r.terabytes} TB`);
  add(`Days with data: ${n(r.days.withData)} (${r.days.first ?? '-'} … ${r.days.last ?? '-'})`);
  if (r.days.monthsWithoutData.length > 0)
    add(`Months without any data: ${r.days.monthsWithoutData.join(', ')}`);
  add(`Users: ${r.users}`);
  add(
    `Apps: ${Object.entries(r.apps)
      .sort((a, b) => b[1] - a[1])
      .map(([app, count]) => `${app} ${n(count)}`)
      .join(', ')}`,
  );
  add();
  add(
    `Imported now: ${n(r.imported.sessions)} sessions, ${n(r.imported.usageRows)} hourly usage rows; ` +
      `${n(r.imported.alreadyPresent)} already present; peak concurrency for ${n(r.imported.sweptDays)} days`,
  );
  add();
  add(`Settings: ${r.settings.imported ? 'imported' : 'already imported earlier (not touched)'}`);
  const byTarget = new Map<string, string[]>();
  for (const [legacyKey, target] of Object.entries(r.settings.mapped)) {
    byTarget.set(target, [...(byTarget.get(target) ?? []), legacyKey]);
  }
  for (const [target, keys] of [...byTarget].sort()) add(`  ${target.padEnd(30)} ← ${keys.join(', ')}`);
  for (const [secret, set] of Object.entries(r.settings.secretsSet)) {
    add(`  ${secret.padEnd(30)}   ${set ? 'set (value not shown)' : 'not set'}`);
  }
  if (r.settings.dropped.length > 0) add(`  dropped: ${r.settings.dropped.join(', ')}`);
  return lines.join('\n');
}
