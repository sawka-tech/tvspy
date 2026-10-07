import { type SnrThresholds, snrTone, toneColor } from './snr';

const MAX_DB = 40;

/** Current SNR as a meter: the fill carries the severity, ticks mark the thresholds. */
export function SnrMeter({ snrDb, thresholds }: { snrDb: number | null; thresholds: SnrThresholds }) {
  const pct = snrDb === null ? 0 : Math.max(2, Math.min(100, (snrDb / MAX_DB) * 100));
  const tick = (v: number) => `${Math.min(100, (v / MAX_DB) * 100)}%`;
  return (
    <div className="relative h-2 w-full rounded-full bg-surface-2" aria-hidden>
      <div
        className="absolute inset-y-0 left-0 rounded-full transition-[width]"
        style={{ width: `${pct}%`, background: toneColor[snrTone(snrDb, thresholds)] }}
      />
      {[thresholds.snrCriticalDb, thresholds.snrGoodDb].map((v) => (
        <div key={v} className="absolute -inset-y-0.5 w-0.5 bg-surface" style={{ left: tick(v) }} />
      ))}
    </div>
  );
}
