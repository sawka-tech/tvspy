import type { SessionRow, SessionSort } from '@tvspy/shared';
import { Disc, Search, X } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ChannelLogo } from '../components/ChannelLogo';
import { AppLabel, appText, muxLabel, OutcomeChip, SourceTag } from '../components/SessionBits';
import { Card, PageHeader } from '../components/ui/Card';
import { type Column, DataTable } from '../components/ui/DataTable';
import { Dialog } from '../components/ui/Dialog';
import { EmptyState, ErrorNotice, Skeleton } from '../components/ui/Feedback';
import { Select, TextInput } from '../components/ui/Field';
import { Pagination } from '../components/ui/Pagination';
import { StatusChip, Tag } from '../components/ui/StatusChip';
import { formatBytes, formatDate, formatDateTime, formatDuration, localDay, plural } from '../lib/format';
import { type SessionQuery, useLookups, useSessions, useSettings } from '../lib/queries';
import { useServer } from '../lib/server';

const SORTS: SessionSort[] = ['startedAt', 'endedAt', 'durationSec', 'bytes', 'user', 'channel', 'errors'];
const PAGE_SIZES = [25, 50, 100];

type Preset = { id: string; label: string; range: (tz: string) => { from?: string; to?: string } };
const PRESETS: Preset[] = [
  { id: 'all', label: 'All time', range: () => ({}) },
  { id: 'today', label: 'Today', range: (tz) => ({ from: localDay(tz), to: localDay(tz) }) },
  {
    id: 'yesterday',
    label: 'Yesterday',
    range: (tz) => ({ from: localDay(tz, Date.now(), -1), to: localDay(tz, Date.now(), -1) }),
  },
  {
    id: '7d',
    label: 'Last 7 days',
    range: (tz) => ({ from: localDay(tz, Date.now(), -6), to: localDay(tz) }),
  },
  {
    id: '30d',
    label: 'Last 30 days',
    range: (tz) => ({ from: localDay(tz, Date.now(), -29), to: localDay(tz) }),
  },
  {
    id: 'year',
    label: 'This year',
    range: (tz) => ({ from: `${localDay(tz).slice(0, 4)}-01-01`, to: localDay(tz) }),
  },
];

/** Reads the filters from the URL, so every view can be bookmarked and shared. */
function useFilters() {
  const [params, setParams] = useSearchParams();
  const get = (k: string) => params.get(k) ?? undefined;
  const num = (k: string, fallback: number) => {
    const v = Number(params.get(k));
    return Number.isInteger(v) && v > 0 ? v : fallback;
  };
  const sort = get('sort');
  const filters = {
    page: num('page', 1),
    pageSize: PAGE_SIZES.includes(num('pageSize', 50)) ? num('pageSize', 50) : 50,
    sort: (SORTS.includes(sort as SessionSort) ? sort : 'startedAt') as SessionSort,
    dir: (get('dir') === 'asc' ? 'asc' : 'desc') as 'asc' | 'desc',
    kind: (['playback', 'recording'].includes(get('kind') ?? '')
      ? get('kind')
      : undefined) as SessionQuery['kind'],
    user: get('user'),
    channel: get('channel'),
    app: get('app'),
    outcome: (['ok', 'failed'].includes(get('outcome') ?? '')
      ? get('outcome')
      : undefined) as SessionQuery['outcome'],
    from: get('from'),
    to: get('to'),
    q: get('q'),
    visit: params.get('visit') ? num('visit', 0) || undefined : undefined,
    includeShort: params.get('short') === '1',
  };
  const update = (changes: Record<string, string | number | undefined | null>, resetPage = true) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) {
      if (v === undefined || v === null || v === '') next.delete(k);
      else next.set(k, String(v));
    }
    if (resetPage && !('page' in changes)) next.delete('page');
    setParams(next, { replace: true });
  };
  return { filters, update };
}

function SearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  useEffect(() => {
    if (text === value) return;
    const id = setTimeout(() => onChange(text.trim()), 350);
    return () => clearTimeout(id);
  }, [text, value, onChange]);
  return (
    <div className="relative">
      <Search
        className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted"
        aria-hidden
      />
      <TextInput
        type="search"
        aria-label="Search user, channel, address or app"
        placeholder="Search user, channel, address, app"
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="pl-8"
      />
    </div>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-2 py-1.5 text-sm">
      <dt className="text-ink-2">{label}</dt>
      <dd className="min-w-0 break-words text-ink">{children}</dd>
    </div>
  );
}

function SessionDetails({ s, onVisit }: { s: SessionRow; onVisit: (visitId: number) => void }) {
  const { tz } = useServer();
  return (
    <dl className="divide-y divide-line">
      <Detail label="Channel">
        {s.channel.name}
        {s.mux && <span className="text-ink-2"> · {muxLabel(s.mux)}</span>}
      </Detail>
      <Detail label="Tuner">{s.tuner ?? '–'}</Detail>
      <Detail label={s.kind === 'recording' ? 'Recording' : 'Viewer'}>
        {s.kind === 'recording' ? (s.title ?? 'Recording') : (s.user ?? 'Anonymous')}
      </Detail>
      {s.kind === 'playback' && (
        <Detail label="App">
          {appText(s.app).name}
          {appText(s.app).detail && <span className="text-ink-2"> · {appText(s.app).detail}</span>}
          {s.app?.raw && <div className="mt-0.5 font-mono text-xs text-ink-2">{s.app.raw}</div>}
        </Detail>
      )}
      <Detail label="Connection">
        <SourceTag source={s.source} />
      </Detail>
      <Detail label="Started">{formatDateTime(s.startedAt, tz)}</Detail>
      <Detail label="Ended">{s.endedAt ? formatDateTime(s.endedAt, tz) : 'Still running'}</Detail>
      <Detail label="Duration">
        {formatDuration(s.durationSec)}
        {s.estimated && (
          <span className="text-ink-2">
            {' '}
            (estimated: the old tvspy stored no reliable end, so it was derived from the data volume)
          </span>
        )}
      </Detail>
      <Detail label="Data">{formatBytes(s.bytes)}</Detail>
      <Detail label="Errors">{s.errors.toLocaleString('en-GB')}</Detail>
      {s.outcome === 'failed' && (
        <Detail label="Result">
          <OutcomeChip outcome="failed" />
        </Detail>
      )}
      {s.visitId !== null && s.visitId !== undefined && (
        <Detail label="Visit">
          <button
            type="button"
            className="font-medium text-accent-ink hover:underline"
            onClick={() => onVisit(s.visitId as number)}
          >
            Show every channel of this visit
          </button>
        </Detail>
      )}
    </dl>
  );
}

export function HistoryPage() {
  const { tz } = useServer();
  const { filters: f, update } = useFilters();
  const lookups = useLookups();
  const settings = useSettings();
  const [selected, setSelected] = useState<SessionRow | null>(null);
  const minSessionSec = settings.data?.monitoring.minSessionSec ?? 0;

  const query: SessionQuery = {
    page: f.page,
    pageSize: f.pageSize,
    sort: f.sort,
    dir: f.dir,
    kind: f.kind,
    user: f.user,
    channel: f.channel,
    app: f.app,
    outcome: f.outcome,
    from: f.from,
    to: f.to,
    q: f.q,
    visit: f.visit,
    minSec: f.includeShort || minSessionSec === 0 ? undefined : minSessionSec,
  };
  const sessions = useSessions(query);

  const preset = useMemo(() => {
    if (!f.from && !f.to) return 'all';
    return (
      PRESETS.find((p) => {
        const r = p.range(tz);
        return r.from === f.from && r.to === f.to;
      })?.id ?? 'custom'
    );
  }, [f.from, f.to, tz]);

  const columns: Column<SessionRow>[] = [
    {
      key: 'started',
      header: 'Started',
      sort: 'startedAt',
      className: 'whitespace-nowrap',
      cell: (s) => <span className="tnum text-ink">{formatDateTime(s.startedAt, tz)}</span>,
    },
    {
      key: 'user',
      header: 'Viewer',
      sort: 'user',
      cell: (s) =>
        s.kind === 'recording' ? (
          <Tag icon={<Disc className="size-3" aria-hidden />} title={s.title ?? undefined}>
            Recording
          </Tag>
        ) : (
          <span className="font-medium text-ink">
            {s.user ?? <span className="font-normal text-ink-2">Anonymous</span>}
          </span>
        ),
    },
    {
      key: 'channel',
      header: 'Channel',
      sort: 'channel',
      cell: (s) => (
        <div className="flex min-w-0 items-center gap-2">
          <ChannelLogo channel={s.channel} size={22} />
          <span className="truncate text-ink">{s.channel.name}</span>
        </div>
      ),
    },
    {
      key: 'app',
      header: 'App',
      className: 'max-w-48',
      cell: (s) => (s.kind === 'playback' ? <AppLabel app={s.app} /> : null),
    },
    { key: 'source', header: 'Connection', cell: (s) => <SourceTag source={s.source} /> },
    {
      key: 'duration',
      header: 'Duration',
      sort: 'durationSec',
      align: 'right',
      className: 'whitespace-nowrap',
      cell: (s) => (
        <span title={s.estimated ? 'Estimated from the data volume' : undefined}>
          {s.estimated ? '≈ ' : ''}
          {formatDuration(s.durationSec)}
        </span>
      ),
    },
    {
      key: 'bytes',
      header: 'Data',
      sort: 'bytes',
      align: 'right',
      className: 'whitespace-nowrap',
      cell: (s) => formatBytes(s.bytes),
    },
    {
      key: 'outcome',
      header: <span className="sr-only">Result</span>,
      cell: (s) =>
        s.endedAt === null ? <OutcomeChip outcome={null} /> : <OutcomeChip outcome={s.outcome} />,
    },
  ];

  const data = sessions.data;
  const activeFilters: { label: string; clear: Record<string, undefined> }[] = [];
  if (f.visit) activeFilters.push({ label: `Visit #${f.visit}`, clear: { visit: undefined } });

  return (
    <>
      <PageHeader
        title="History"
        description="Every stream and recording, newest first. Zapping between channels forms one visit."
      />

      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-[repeat(4,minmax(0,1fr))_minmax(0,1.5fr)]">
        <Select
          aria-label="Period"
          value={preset}
          onChange={(e) => {
            if (e.target.value === 'custom')
              return update({ from: f.from ?? localDay(tz, Date.now(), -6), to: f.to ?? localDay(tz) });
            const p = PRESETS.find((x) => x.id === e.target.value);
            if (p) {
              const r = p.range(tz);
              update({ from: r.from, to: r.to });
            }
          }}
        >
          {PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
          <option value="custom">Custom dates…</option>
        </Select>
        <Select aria-label="Viewer" value={f.user ?? ''} onChange={(e) => update({ user: e.target.value })}>
          <option value="">All viewers</option>
          {lookups.data?.users.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Channel"
          value={f.channel ?? ''}
          onChange={(e) => update({ channel: e.target.value })}
        >
          <option value="">All channels</option>
          {lookups.data?.channels.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
        </Select>
        <Select aria-label="App" value={f.app ?? ''} onChange={(e) => update({ app: e.target.value })}>
          <option value="">All apps</option>
          {lookups.data?.apps.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </Select>
        <SearchBox value={f.q ?? ''} onChange={(q) => update({ q })} />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        {preset === 'custom' && (
          <div className="flex items-center gap-2">
            <TextInput
              type="date"
              aria-label="From"
              value={f.from ?? ''}
              max={f.to}
              onChange={(e) => update({ from: e.target.value })}
              className="w-auto"
            />
            <span className="text-ink-2">to</span>
            <TextInput
              type="date"
              aria-label="To"
              value={f.to ?? ''}
              min={f.from}
              onChange={(e) => update({ to: e.target.value })}
              className="w-auto"
            />
          </div>
        )}
        <Select
          aria-label="Type"
          value={f.kind ?? ''}
          onChange={(e) => update({ kind: e.target.value })}
          className="w-auto"
        >
          <option value="">Streams and recordings</option>
          <option value="playback">Streams only</option>
          <option value="recording">Recordings only</option>
        </Select>
        <Select
          aria-label="Result"
          value={f.outcome ?? ''}
          onChange={(e) => update({ outcome: e.target.value })}
          className="w-auto"
        >
          <option value="">Any result</option>
          <option value="ok">Worked</option>
          <option value="failed">Failed starts</option>
        </Select>
        {minSessionSec > 0 && (
          <label className="inline-flex items-center gap-2 text-ink-2">
            <input
              type="checkbox"
              checked={f.includeShort}
              onChange={(e) => update({ short: e.target.checked ? '1' : undefined })}
              className="size-4 accent-[var(--accent)]"
            />
            Include sessions under {minSessionSec} s
          </label>
        )}
        {activeFilters.map((a) => (
          <button
            key={a.label}
            type="button"
            onClick={() => update(a.clear)}
            className="inline-flex items-center gap-1 rounded-full border border-line-strong px-2 py-0.5 text-xs text-ink hover:bg-surface-2"
            aria-label={`Remove filter ${a.label}`}
          >
            {a.label}
            <X className="size-3" aria-hidden />
          </button>
        ))}
      </div>

      <Card bodyClassName="">
        {data && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-4 py-2.5 text-sm text-ink-2">
            <span>
              <strong className="font-semibold text-ink">{plural(data.summary.sessions, 'session')}</strong>
            </span>
            <span>{plural(data.summary.visits, 'visit')}</span>
            <span>{formatDuration(data.summary.watchSec)} watched</span>
            <span>{formatBytes(data.summary.bytes)}</span>
            {(f.from || f.to) && (
              <span>
                {f.from ? formatDate(f.from) : 'start'} – {f.to ? formatDate(f.to) : 'today'}
              </span>
            )}
          </div>
        )}
        {sessions.error ? (
          <div className="p-4">
            <ErrorNotice error={sessions.error} onRetry={() => void sessions.refetch()} />
          </div>
        ) : !data ? (
          <div className="space-y-2 p-4">
            {['a', 'b', 'c', 'd', 'e', 'f'].map((k) => (
              <Skeleton key={k} className="h-8" />
            ))}
          </div>
        ) : data.items.length === 0 ? (
          <EmptyState icon={<Search className="size-8" aria-hidden />} title="No sessions match">
            Try another period or fewer filters.
          </EmptyState>
        ) : (
          <DataTable
            caption="Sessions"
            columns={columns}
            rows={data.items}
            rowKey={(s) => s.id}
            sort={f.sort}
            dir={f.dir}
            loading={sessions.isPlaceholderData}
            onSort={(sort) => update({ sort, dir: sort === f.sort && f.dir === 'desc' ? 'asc' : 'desc' })}
            onRowClick={setSelected}
          />
        )}
        {data && data.total > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-2.5">
            <Pagination
              page={f.page}
              pageSize={f.pageSize}
              total={data.total}
              onPage={(page) => update({ page }, false)}
            />
            <Select
              aria-label="Rows per page"
              value={String(f.pageSize)}
              onChange={(e) => update({ pageSize: e.target.value })}
              className="w-auto"
            >
              {PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n} per page
                </option>
              ))}
            </Select>
          </div>
        )}
      </Card>

      {data?.items.some((s) => s.estimated) && (
        <p className="mt-3 text-xs text-ink-2">
          <StatusChip tone="neutral">≈</StatusChip> Durations marked ≈ come from the old tvspy and were
          estimated from the data volume.
        </p>
      )}

      <Dialog
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected ? `${selected.channel.name} session` : 'Session'}
      >
        {selected && (
          <SessionDetails
            s={selected}
            onVisit={(visit) => {
              setSelected(null);
              update({
                visit,
                user: undefined,
                channel: undefined,
                from: undefined,
                to: undefined,
                q: undefined,
              });
            }}
          />
        )}
      </Dialog>

      {sessions.isFetching && !sessions.isPending && <span className="sr-only">Loading</span>}
    </>
  );
}
