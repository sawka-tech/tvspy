// When a session counts as a failed start: it lasted a while but almost no data arrived (e.g. no
// reception). Shared by the live tracker and the legacy importer.

export const FAILED_MIN_SECONDS = 8;
export const FAILED_MAX_BYTES = 64 * 1024;

export function outcomeOf(durationSec: number, bytes: number): 'ok' | 'failed' {
  return durationSec >= FAILED_MIN_SECONDS && bytes < FAILED_MAX_BYTES ? 'failed' : 'ok';
}
