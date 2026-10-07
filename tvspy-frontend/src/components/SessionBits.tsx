// Small labels shared by the live view and the history.

import type { AppInfo, MuxRef, Source } from '@tvspy/shared';
import { Globe, House, ShieldCheck } from 'lucide-react';
import { StatusChip, Tag } from './ui/StatusChip';

export function muxLabel(mux: MuxRef | null): string | null {
  if (!mux) return null;
  const freq = mux.freqMHz !== null ? `${mux.freqMHz} MHz` : mux.name;
  return mux.label ? `${mux.label} · ${freq}` : freq;
}

export function SourceTag({ source }: { source: Source }) {
  switch (source.route) {
    case 'proxy':
      return (
        <Tag
          icon={<ShieldCheck className="size-3" aria-hidden />}
          title="Through the HTTPS proxy; TVHeadend only sees the proxy's address"
        >
          HTTPS proxy
        </Tag>
      );
    case 'lan':
      return (
        <Tag icon={<House className="size-3" aria-hidden />} title={source.ip ?? undefined}>
          Home network
        </Tag>
      );
    case 'direct':
      return (
        <Tag
          icon={<Globe className="size-3" aria-hidden />}
          title="Directly to TVHeadend's port from the internet"
        >
          {source.ip ?? 'Internet'}
        </Tag>
      );
    default:
      return <span className="text-muted">–</span>;
  }
}

export function appText(app: AppInfo | null): { name: string; detail: string | null } {
  if (!app) return { name: 'Unknown app', detail: null };
  const name = app.version ? `${app.app} ${app.version}` : app.app;
  return { name, detail: app.device ?? app.platform };
}

export function AppLabel({ app }: { app: AppInfo | null }) {
  const { name, detail } = appText(app);
  return (
    <div className="min-w-0" title={app?.raw || undefined}>
      <div className="truncate text-ink">{name}</div>
      {detail && <div className="truncate text-xs text-ink-2">{detail}</div>}
    </div>
  );
}

export function OutcomeChip({ outcome }: { outcome: 'ok' | 'failed' | null }) {
  if (outcome === 'failed') {
    return (
      <StatusChip
        tone="critical"
        title="Lasted a few seconds but received almost no data (no reception or no free tuner)"
      >
        Failed
      </StatusChip>
    );
  }
  if (outcome === null) return <StatusChip tone="info">Running</StatusChip>;
  return null;
}
