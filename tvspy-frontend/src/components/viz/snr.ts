import type { Tone } from '../ui/StatusChip';

export interface SnrThresholds {
  snrGoodDb: number;
  snrCriticalDb: number;
}

export function snrTone(snrDb: number | null, t: SnrThresholds): Tone {
  if (snrDb === null) return 'neutral';
  if (snrDb >= t.snrGoodDb) return 'good';
  if (snrDb >= t.snrCriticalDb) return 'warning';
  return 'critical';
}

export function snrLabel(snrDb: number | null, t: SnrThresholds): string {
  if (snrDb === null) return 'No lock';
  if (snrDb >= t.snrGoodDb) return 'Good';
  if (snrDb >= t.snrCriticalDb) return 'Weak';
  return 'Critical';
}

/** CSS colour of a status tone (status colours are fixed in both themes). */
export const toneColor: Record<Tone, string> = {
  good: 'var(--good)',
  warning: 'var(--warning)',
  serious: 'var(--serious)',
  critical: 'var(--critical)',
  neutral: 'var(--ink-muted)',
  info: 'var(--accent)',
};
