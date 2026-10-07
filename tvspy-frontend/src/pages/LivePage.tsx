import type { LiveSession, Tuner } from '@tvspy/shared';
import { CircleDot, Disc, Tv } from 'lucide-react';
import { Link } from 'react-router';
import { ChannelLogo } from '../components/ChannelLogo';
import { AppLabel, muxLabel, OutcomeChip, SourceTag } from '../components/SessionBits';
import { Card, PageHeader } from '../components/ui/Card';
import { EmptyState, ErrorNotice, Skeleton } from '../components/ui/Feedback';
import { StatusChip, Tag, type Tone } from '../components/ui/StatusChip';
import { SnrHistory } from '../components/viz/SnrHistory';
import { SnrMeter } from '../components/viz/SnrMeter';
import { Sparkline } from '../components/viz/Sparkline';
import { snrLabel, snrTone } from '../components/viz/snr';
import { formatAgo, formatBitrate, formatBytes, formatClock, formatDb, formatDuration } from '../lib/format';
import { useLive, useSessions, useSettings, useStatus, useTuners } from '../lib/queries';
import { useNow, useServer } from '../lib/server';

function StatTile({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3">
      <div className="text-sm text-ink-2">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-ink">{value}</div>
      {detail && <div className="mt-0.5 text-xs text-ink-2">{detail}</div>}
    </div>
  );
}

function SessionRow({ s, nowMs }: { s: LiveSession; nowMs: number }) {
  const mux = muxLabel(s.mux);
  const elapsed = (nowMs - Date.parse(s.startedAt)) / 1000;
  return (
    <li className="grid gap-x-4 gap-y-2 px-4 py-3 md:grid-cols-[minmax(0,1.7fr)_minmax(0,1.2fr)_minmax(0,1.3fr)_minmax(0,1.6fr)] md:items-center">
      <div className="flex min-w-0 items-center gap-3">
        <ChannelLogo channel={s.channel} />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-ink">{s.channel.name}</span>
            {s.kind === 'recording' && (
              <Tag icon={<Disc className="size-3" aria-hidden />} title={s.title ?? undefined}>
                Recording
              </Tag>
            )}
          </div>
          <div className="truncate text-xs text-ink-2">
            {[mux, s.tuner].filter(Boolean).join(' · ') || 'Tuner unknown'}
          </div>
        </div>
      </div>
      <div className="flex min-w-0 items-baseline gap-2 md:block">
        <div className="truncate text-sm font-medium text-ink">
          {s.kind === 'recording'
            ? (s.title?.replace(/^DVR:\s*/, '') ?? 'Recording')
            : (s.user ?? 'Anonymous')}
        </div>
        <div
          className="tnum text-xs text-ink-2"
          title={`Started ${new Date(s.startedAt).toLocaleString('en-GB')}`}
        >
          {formatClock(elapsed)}
        </div>
      </div>
      {s.kind === 'playback' ? (
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm md:flex-col md:items-start">
          <AppLabel app={s.app} />
          <SourceTag source={s.source} />
        </div>
      ) : (
        <div className="hidden text-sm text-ink-2 md:block">TVHeadend recorder</div>
      )}
      <div className="flex min-w-0 items-center gap-3">
        <div className="min-w-0 flex-1">
          <Sparkline
            values={s.rateHistory}
            format={formatBitrate}
            label={`Data rate of ${s.channel.name}`}
            stepSec={3}
          />
        </div>
        <div className="w-24 shrink-0 text-right">
          <div className="tnum text-sm font-medium text-ink">{formatBitrate(s.rateBps)}</div>
          <div className="tnum text-xs text-ink-2">{formatBytes(s.bytes)}</div>
          {s.errors > 0 && (
            <div className="mt-0.5">
              <StatusChip tone="warning" title="Errors reported by TVHeadend for this stream">
                {s.errors} errors
              </StatusChip>
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

const TUNER_STATE: Record<Tuner['state'], { tone: Tone; label: string }> = {
  streaming: { tone: 'info', label: 'In use' },
  internal: { tone: 'neutral', label: 'TVHeadend task' },
  idle: { tone: 'neutral', label: 'Idle' },
  missing: { tone: 'critical', label: 'Missing' },
};

function TunerCard({ t, nowMs }: { t: Tuner; nowMs: number }) {
  const { tz, thresholds } = useServer();
  const state = TUNER_STATE[t.state];
  const mux = muxLabel(t.mux);
  const tuned = t.mux !== null;
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-medium text-ink" title={t.name}>
            {t.label}
          </div>
          <div className="truncate text-xs text-ink-2">
            {t.state === 'missing' ? 'Not reported by TVHeadend (unplugged?)' : tuned ? mux : 'Not tuned'}
          </div>
        </div>
        <StatusChip tone={state.tone}>{state.label}</StatusChip>
      </div>
      {tuned && (
        <div className="mt-3 space-y-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm text-ink-2">Signal-to-noise</span>
            <span className="flex items-center gap-2">
              <span className="tnum text-lg font-semibold text-ink">
                {t.locked ? formatDb(t.snrDb) : '–'}
              </span>
              <StatusChip tone={snrTone(t.locked ? t.snrDb : null, thresholds)}>
                {snrLabel(t.locked ? t.snrDb : null, thresholds)}
              </StatusChip>
            </span>
          </div>
          <SnrMeter snrDb={t.locked ? t.snrDb : null} thresholds={thresholds} />
          <div className="tnum flex justify-between text-xs text-ink-2">
            <span>Signal {formatDb(t.signalDbm, 'dBm')}</span>
            {t.rateBps !== null && <span>{formatBitrate(t.rateBps)}</span>}
          </div>
        </div>
      )}
      <div className="mt-3">
        <div className="mb-1 text-xs text-ink-2">SNR, last 15 minutes (dB)</div>
        <SnrHistory
          points={t.snrHistory}
          thresholds={thresholds}
          nowMs={nowMs}
          tz={tz}
          label={`SNR of ${t.label}`}
        />
      </div>
    </div>
  );
}

function RecentlyEnded({ minSec }: { minSec: number }) {
  const { tz } = useServer();
  const now = useNow(30_000);
  const recent = useSessions(
    { sort: 'endedAt', dir: 'desc', pageSize: 6, ended: true, minSec },
    { refetchInterval: 15_000 },
  );
  return (
    <Card
      title="Recently ended"
      actions={
        <Link to="/history" className="text-sm font-medium text-accent-ink hover:underline">
          All history
        </Link>
      }
      bodyClassName=""
    >
      {recent.isPending ? (
        <div className="space-y-2 p-4">
          <Skeleton className="h-5" />
          <Skeleton className="h-5" />
        </div>
      ) : recent.error ? (
        <div className="p-4">
          <ErrorNotice error={recent.error} onRetry={() => void recent.refetch()} />
        </div>
      ) : recent.data.items.length === 0 ? (
        <EmptyState title="No sessions yet" />
      ) : (
        <ul className="divide-y divide-line">
          {recent.data.items.map((s) => (
            <li key={s.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
              <ChannelLogo channel={s.channel} size={24} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-ink">
                  {s.kind === 'recording' ? (
                    <>
                      <span className="text-ink-2">Recorded</span>{' '}
                      <span className="font-medium">{s.title?.replace(/^DVR:\s*/, '') || 'a programme'}</span>{' '}
                      <span className="text-ink-2">on</span> {s.channel.name}
                    </>
                  ) : (
                    <>
                      <span className="font-medium">{s.user ?? 'Anonymous'}</span>{' '}
                      <span className="text-ink-2">watched</span> {s.channel.name}
                    </>
                  )}
                </div>
                <div className="tnum text-xs text-ink-2">
                  {formatDuration(s.durationSec)} · {formatBytes(s.bytes)} · ended{' '}
                  {s.endedAt ? formatAgo(s.endedAt, now, tz) : ''}
                </div>
              </div>
              <OutcomeChip outcome={s.outcome} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function LivePage() {
  const live = useLive();
  const tuners = useTuners();
  const status = useStatus();
  const settings = useSettings();
  const skew = live.data ? Date.parse(live.data.serverTime) - live.dataUpdatedAt : 0;
  const now = useNow(1000, skew);

  const sessions = live.data?.sessions ?? [];
  const playback = sessions.filter((s) => s.kind === 'playback');
  const recordings = sessions.filter((s) => s.kind === 'recording');
  const totalRate = sessions.reduce((sum, s) => sum + s.rateBps, 0);
  const st = status.data;

  return (
    <>
      <PageHeader title="Live" description="Who is watching right now, refreshed every 3 seconds." />

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Watching now" value={live.data ? String(playback.length) : '–'} />
        <StatTile label="Recording" value={live.data ? String(recordings.length) : '–'} />
        <StatTile
          label="Tuners in use"
          value={st ? `${st.tuners.inUse} of ${st.tuners.expected}` : '–'}
          detail={
            st && st.tuners.detected !== st.tuners.expected ? `${st.tuners.detected} detected` : undefined
          }
        />
        <StatTile label="Total data rate" value={live.data ? formatBitrate(totalRate) : '–'} />
      </div>

      <Card title="Streams" className="mb-5" bodyClassName="">
        {live.isPending ? (
          <div className="space-y-3 p-4">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : live.error ? (
          <div className="p-4">
            <ErrorNotice error={live.error} onRetry={() => void live.refetch()} />
          </div>
        ) : sessions.length === 0 ? (
          <EmptyState icon={<Tv className="size-8" aria-hidden />} title="Nobody is watching right now">
            New streams appear here within a few seconds.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {sessions.map((s) => (
              <SessionRow key={s.id} s={s} nowMs={now} />
            ))}
          </ul>
        )}
      </Card>

      <div className="mb-3 flex items-center gap-2">
        <CircleDot className="size-4 text-ink-2" aria-hidden />
        <h2 className="text-sm font-semibold text-ink">Tuners</h2>
      </div>
      {tuners.error ? (
        <div className="mb-5">
          <ErrorNotice error={tuners.error} onRetry={() => void tuners.refetch()} />
        </div>
      ) : tuners.isPending ? (
        <div className="mb-5 grid gap-3 md:grid-cols-2">
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
        </div>
      ) : tuners.data.tuners.length === 0 ? (
        <Card className="mb-5">
          <EmptyState title="No tuners reported">TVHeadend has not listed any tuners yet.</EmptyState>
        </Card>
      ) : (
        <div className="mb-5 grid gap-3 md:grid-cols-2">
          {tuners.data.tuners.map((t) => (
            <TunerCard key={t.name} t={t} nowMs={now} />
          ))}
        </div>
      )}

      <RecentlyEnded minSec={settings.data?.monitoring.minSessionSec ?? 0} />
    </>
  );
}
