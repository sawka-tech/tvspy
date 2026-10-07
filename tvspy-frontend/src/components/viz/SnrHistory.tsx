import { type KeyboardEvent, type PointerEvent, useRef, useState } from 'react';
import { formatTime } from '../../lib/format';
import type { SnrThresholds } from './snr';
import { useWidth } from './useWidth';

const WINDOW_SEC = 15 * 60;
const PAD_X = 6;
const PAD_Y = 6;
const AXIS_W = 22;

type Point = [number, number | null];

/**
 * SNR over the last 15 minutes. Every tuner uses the same dB scale so cards compare at a glance; gaps
 * mean the tuner had no lock. Hairlines mark the "weak" and "good" thresholds. Hover shows a crosshair
 * readout; keyboard users step through the samples with the arrow keys.
 */
export function SnrHistory({
  points,
  thresholds,
  nowMs,
  tz,
  label,
  height = 84,
}: {
  points: Point[];
  thresholds: SnrThresholds;
  nowMs: number;
  tz: string;
  label: string;
  height?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useWidth(ref, 240);
  const [active, setActive] = useState<number | null>(null);

  const end = nowMs / 1000;
  const start = end - WINDOW_SEC;
  const visible = points.filter(([t]) => t >= start);
  const values = visible.map((p) => p[1]).filter((v): v is number => v !== null);
  const top = Math.max(40, Math.ceil(Math.max(0, ...values) / 5) * 5);
  const bottom = Math.min(10, Math.floor(Math.min(top, ...values) / 5) * 5);
  const plotW = width - AXIS_W - PAD_X;
  const x = (t: number) => AXIS_W + Math.max(0, Math.min(1, (t - start) / WINDOW_SEC)) * plotW;
  const y = (v: number) => PAD_Y + (1 - (v - bottom) / (top - bottom)) * (height - 2 * PAD_Y);

  let d = '';
  let pen = false;
  for (const [t, v] of visible) {
    if (v === null) {
      pen = false;
      continue;
    }
    d += `${pen ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  }

  const last = visible.length - 1;
  const pick = (e: PointerEvent<HTMLDivElement>) => {
    if (last < 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const t = start + ((e.clientX - rect.left - AXIS_W) / plotW) * WINDOW_SEC;
    let best = 0;
    visible.forEach(([pt], i) => {
      if (Math.abs(pt - t) < Math.abs((visible[best] as Point)[0] - t)) best = i;
    });
    setActive(best);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (last < 0) return;
    if (e.key === 'ArrowLeft') setActive((a) => Math.max(0, (a ?? last) - 1));
    else if (e.key === 'ArrowRight') setActive((a) => Math.min(last, (a ?? last) + 1));
    else if (e.key === 'Home') setActive(0);
    else if (e.key === 'End') setActive(last);
    else if (e.key === 'Escape') setActive(null);
    else return;
    e.preventDefault();
  };
  const index = active ?? last;
  const cur = index >= 0 ? (visible[index] as Point) : null;
  const describe = (p: Point | null) =>
    p === null
      ? 'no data'
      : `${p[1] === null ? 'no lock' : `${p[1].toFixed(1)} dB`} at ${formatTime(new Date(p[0] * 1000).toISOString(), tz)}`;

  return (
    <div
      ref={ref}
      role="slider"
      tabIndex={0}
      aria-label={`${label}, last 15 minutes`}
      aria-valuemin={0}
      aria-valuemax={Math.max(0, last)}
      aria-valuenow={Math.max(0, index)}
      aria-valuetext={describe(cur)}
      className="relative w-full touch-none rounded-sm"
      onPointerMove={pick}
      onPointerDown={pick}
      onPointerLeave={() => setActive(null)}
      onBlur={() => setActive(null)}
      onKeyDown={onKey}
    >
      <svg width={width} height={height} className="block" aria-hidden>
        <line
          x1={AXIS_W}
          x2={width - PAD_X}
          y1={height - PAD_Y}
          y2={height - PAD_Y}
          stroke="var(--baseline)"
          strokeWidth={1}
        />
        {[thresholds.snrCriticalDb, thresholds.snrGoodDb].map((v) => (
          <g key={v}>
            <line x1={AXIS_W} x2={width - PAD_X} y1={y(v)} y2={y(v)} stroke="var(--grid)" strokeWidth={1} />
            <text
              x={AXIS_W - 4}
              y={y(v)}
              dy="0.32em"
              textAnchor="end"
              fontSize={10}
              fill="var(--ink-muted)"
              className="tnum"
            >
              {v}
            </text>
          </g>
        ))}
        <path
          d={d}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {active !== null && cur && (
          <>
            <line
              x1={x(cur[0])}
              x2={x(cur[0])}
              y1={PAD_Y - 2}
              y2={height - PAD_Y}
              stroke="var(--baseline)"
              strokeWidth={1}
            />
            {cur[1] !== null && (
              <circle
                cx={x(cur[0])}
                cy={y(cur[1])}
                r={4}
                fill="var(--accent)"
                stroke="var(--surface)"
                strokeWidth={2}
              />
            )}
          </>
        )}
      </svg>
      {active !== null && cur && (
        <div
          aria-hidden
          className="pointer-events-none absolute -top-8 z-10 -translate-x-1/2 rounded-md border border-line bg-surface px-2 py-1 text-xs whitespace-nowrap shadow-sm"
          style={{ left: Math.min(Math.max(x(cur[0]), 50), width - 50) }}
        >
          <span className="font-semibold text-ink">
            {cur[1] === null ? 'No lock' : `${cur[1].toFixed(1)} dB`}
          </span>{' '}
          <span className="text-ink-2">{formatTime(new Date(cur[0] * 1000).toISOString(), tz)}</span>
        </div>
      )}
    </div>
  );
}
