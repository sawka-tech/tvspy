import type { AlertLogEntry } from '@tvspy/shared';
import { BellOff } from 'lucide-react';
import { Link, useSearchParams } from 'react-router';
import { Card, PageHeader } from '../components/ui/Card';
import { Banner, EmptyState, ErrorNotice, Skeleton } from '../components/ui/Feedback';
import { Pagination } from '../components/ui/Pagination';
import { StatusChip, type Tone } from '../components/ui/StatusChip';
import { formatDateTime } from '../lib/format';
import { useAlerts, useStatus } from '../lib/queries';
import { useServer } from '../lib/server';

const RULES: Record<string, string> = {
  playbackStart: 'Playback started',
  playbackStop: 'Playback stopped',
  recordingStart: 'Recording started',
  recordingStop: 'Recording finished',
  longWatch: 'Long viewing',
  tvhDown: 'TVHeadend',
  muxStale: 'Reception',
};

const STATUS: Record<AlertLogEntry['status'], { tone: Tone; label: string }> = {
  sent: { tone: 'good', label: 'Sent' },
  pending: { tone: 'info', label: 'Queued' },
  failed: { tone: 'critical', label: 'Failed' },
  suppressed: { tone: 'neutral', label: 'Not sent' },
};

export function AlertsPage() {
  const { tz } = useServer();
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get('page')) || 1);
  const alerts = useAlerts(page);
  const status = useStatus();
  const telegram = status.data?.telegram;

  return (
    <>
      <PageHeader
        title="Alerts"
        description="Telegram notifications, including those that could not be sent."
      />
      {telegram?.blocked && (
        <div className="mb-4">
          <Banner tone="warning">
            {telegram.blocked}. Alerts are only listed here.{' '}
            <Link to="/settings" className="font-medium text-accent-ink underline">
              Telegram settings
            </Link>
          </Banner>
        </div>
      )}
      <Card bodyClassName="">
        {alerts.error ? (
          <div className="p-4">
            <ErrorNotice error={alerts.error} onRetry={() => void alerts.refetch()} />
          </div>
        ) : alerts.isPending ? (
          <div className="space-y-2 p-4">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        ) : alerts.data.items.length === 0 ? (
          <EmptyState icon={<BellOff className="size-8" aria-hidden />} title="No alerts yet">
            Alerts appear when TVHeadend stops answering, a multiplex loses reception, or for the viewing
            events you switched on in the settings.
          </EmptyState>
        ) : (
          <ul className={`divide-y divide-line ${alerts.isPlaceholderData ? 'opacity-60' : ''}`}>
            {alerts.data.items.map((a) => {
              const st = STATUS[a.status];
              return (
                <li key={a.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-ink-2">
                    <span className="tnum">{formatDateTime(a.at, tz)}</span>
                    <span>·</span>
                    <span className="font-medium text-ink">{RULES[a.rule] ?? a.rule}</span>
                    <span className="ml-auto">
                      <StatusChip tone={st.tone} title={a.error ?? undefined}>
                        {st.label}
                      </StatusChip>
                    </span>
                  </div>
                  <p className="mt-1 text-sm whitespace-pre-line text-ink">{a.text}</p>
                  {a.error && a.status !== 'sent' && <p className="mt-0.5 text-xs text-ink-2">{a.error}</p>}
                </li>
              );
            })}
          </ul>
        )}
        {alerts.data && alerts.data.total > alerts.data.pageSize && (
          <div className="border-t border-line px-4 py-2.5">
            <Pagination
              page={page}
              pageSize={alerts.data.pageSize}
              total={alerts.data.total}
              onPage={(p) => setParams(p > 1 ? { page: String(p) } : {}, { replace: true })}
            />
          </div>
        )}
      </Card>
    </>
  );
}
