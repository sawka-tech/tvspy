import type { TvhErrorKind } from '../tvh/client.js';
import { TvhError } from '../tvh/client.js';

/** Connectivity to TVHeadend as seen by the subscription poller. */
export class TvhState {
  configured = false;
  connected = false;
  lastOkAt: number | null = null;
  downSince: number | null = null;
  error: string | null = null;
  errorKind: TvhErrorKind | null = null;
  version: string | null = null;
  /** Consecutive successful polls since the last failure. */
  okStreak = 0;

  markOk(now: number): void {
    this.configured = true;
    this.connected = true;
    this.lastOkAt = now;
    this.downSince = null;
    this.error = null;
    this.errorKind = null;
    this.okStreak++;
  }

  markFail(err: unknown, now: number): void {
    const kind: TvhErrorKind = err instanceof TvhError ? err.kind : 'network';
    this.configured = kind !== 'not_configured';
    if (this.connected || this.downSince === null) this.downSince = now;
    this.connected = false;
    this.error = err instanceof Error ? err.message : String(err);
    this.errorKind = kind;
    this.okStreak = 0;
  }
}
