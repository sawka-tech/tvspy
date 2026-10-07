import { CircleX, RefreshCw, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { ApiError } from '../../lib/api';
import { Button } from './Button';

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-surface-2 ${className}`} aria-hidden />;
}

export function EmptyState({
  icon,
  title,
  children,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-4 py-10 text-center">
      {icon && <div className="mb-3 text-muted">{icon}</div>}
      <p className="text-sm font-medium text-ink">{title}</p>
      {children && <div className="mt-1 max-w-md text-sm text-ink-2">{children}</div>}
    </div>
  );
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : 'Something went wrong';
}

/** Inline error for a failed load, with a retry button. */
export function ErrorNotice({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-md border border-line bg-critical-wash px-3 py-2.5 text-sm text-ink"
    >
      <CircleX className="mt-0.5 size-4 shrink-0 text-critical" aria-hidden />
      <p className="min-w-0 flex-1">{errorMessage(error)}</p>
      {onRetry && (
        <Button
          size="sm"
          variant="ghost"
          icon={<RefreshCw className="size-3.5" aria-hidden />}
          onClick={onRetry}
        >
          Retry
        </Button>
      )}
    </div>
  );
}

/** A page-wide notice (TVHeadend down, Telegram off, …). */
export function Banner({ tone, children }: { tone: 'warning' | 'critical'; children: ReactNode }) {
  const wash = tone === 'critical' ? 'bg-critical-wash' : 'bg-warning-wash';
  const icon =
    tone === 'critical' ? (
      <CircleX className="mt-0.5 size-4 shrink-0 text-critical" aria-hidden />
    ) : (
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
    );
  return (
    <div
      role="status"
      className={`flex items-start gap-2.5 rounded-md border border-line px-3 py-2.5 text-sm text-ink ${wash}`}
    >
      {icon}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
