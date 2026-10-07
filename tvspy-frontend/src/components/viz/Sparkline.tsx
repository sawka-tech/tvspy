import { type KeyboardEvent, type PointerEvent, useRef, useState } from 'react';
import { useWidth } from './useWidth';

const PAD = 6;

/**
 * A single-series trend: 2px line, a light wash, an end dot with a surface ring, and a crosshair with a
 * value readout on hover. Keyboard users move through the samples with the arrow keys (it is a slider over
 * time). The current value is always shown next to it as text, so the readout only adds detail.
 */
export function Sparkline({
  values,
  format,
  label,
  stepSec,
  height = 32,
}: {
  values: number[];
  format: (v: number) => string;
  label: string;
  /** Seconds between samples, for "12 s ago" in the readout. */
  stepSec: number;
  height?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useWidth(ref, 160);
  const [active, setActive] = useState<number | null>(null);
  const n = values.length;
  if (n < 2) {
    return <div ref={ref} style={{ height }} className="w-full" aria-hidden />;
  }

  const max = Math.max(...values) || 1;
  const x = (i: number) => PAD + (i / (n - 1)) * (width - 2 * PAD);
  const y = (v: number) => height - PAD - (v / max) * (height - 2 * PAD);
  const line = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const area = `${line}L${x(n - 1).toFixed(1)},${height - PAD}L${x(0).toFixed(1)},${height - PAD}Z`;

  const pick = (e: PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const i = Math.round(((e.clientX - rect.left - PAD) / (width - 2 * PAD)) * (n - 1));
    setActive(Math.min(n - 1, Math.max(0, i)));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft') setActive((a) => Math.max(0, (a ?? n - 1) - 1));
    else if (e.key === 'ArrowRight') setActive((a) => Math.min(n - 1, (a ?? n - 1) + 1));
    else if (e.key === 'Home') setActive(0);
    else if (e.key === 'End') setActive(n - 1);
    else if (e.key === 'Escape') setActive(null);
    else return;
    e.preventDefault();
  };
  const index = active ?? n - 1;
  const ago = (n - 1 - index) * stepSec;
  const when = ago === 0 ? 'now' : `${ago} s ago`;
  const value = values[index] as number;

  return (
    <div
      ref={ref}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={n - 1}
      aria-valuenow={index}
      aria-valuetext={`${format(value)}, ${when}`}
      className="relative w-full touch-none rounded-sm"
      onPointerMove={pick}
      onPointerDown={pick}
      onPointerLeave={() => setActive(null)}
      onBlur={() => setActive(null)}
      onKeyDown={onKey}
    >
      <svg width={width} height={height} className="block overflow-visible" aria-hidden>
        <path d={area} fill="var(--accent)" fillOpacity={0.1} />
        <path
          d={line}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {active !== null && (
          <line x1={x(index)} x2={x(index)} y1={2} y2={height - 2} stroke="var(--baseline)" strokeWidth={1} />
        )}
        <circle
          cx={x(index)}
          cy={y(value)}
          r={4}
          fill="var(--accent)"
          stroke="var(--surface)"
          strokeWidth={2}
        />
      </svg>
      {active !== null && (
        <div
          aria-hidden
          className="pointer-events-none absolute -top-9 z-10 -translate-x-1/2 rounded-md border border-line bg-surface px-2 py-1 text-xs whitespace-nowrap shadow-sm"
          style={{ left: Math.min(Math.max(x(index), 40), width - 40) }}
        >
          <span className="font-semibold text-ink">{format(value)}</span>{' '}
          <span className="text-ink-2">{when}</span>
        </div>
      )}
    </div>
  );
}
