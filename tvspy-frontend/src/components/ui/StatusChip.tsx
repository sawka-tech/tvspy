import { Circle, CircleCheck, CircleX, Info, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';

export type Tone = 'good' | 'warning' | 'serious' | 'critical' | 'neutral' | 'info';

const ICON: Record<Tone, ReactNode> = {
  good: <CircleCheck className="size-3.5 text-good" aria-hidden />,
  warning: <TriangleAlert className="size-3.5 text-warning" aria-hidden />,
  serious: <TriangleAlert className="size-3.5 text-serious" aria-hidden />,
  critical: <CircleX className="size-3.5 text-critical" aria-hidden />,
  neutral: <Circle className="size-3.5 text-muted" aria-hidden />,
  info: <Info className="size-3.5 text-accent" aria-hidden />,
};

/** State shown as icon + label (colour never carries the meaning alone). */
export function StatusChip({
  tone,
  children,
  icon,
  title,
}: {
  tone: Tone;
  children: ReactNode;
  icon?: ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2 py-0.5 text-xs font-medium whitespace-nowrap text-ink"
    >
      {icon ?? ICON[tone]}
      {children}
    </span>
  );
}

/** A small neutral tag for categories (route, app, kind). */
export function Tag({ children, icon, title }: { children: ReactNode; icon?: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1 rounded bg-surface-2 px-1.5 py-0.5 text-xs whitespace-nowrap text-ink-2"
    >
      {icon}
      {children}
    </span>
  );
}
