// Database rows and collector state → API contract shapes.

import type {
  AppInfo,
  ChannelRef,
  LiveSession,
  MuxRef,
  SessionRow,
  Source,
  TvhState as TvhStateDto,
} from '@tvspy/shared';
import type { Catalog } from '../collect/catalog.js';
import type { TrackedSession } from '../collect/sessions.js';
import type { TvhState } from '../collect/tvhState.js';
import type { Route } from '../core/ip.js';
import { muxFrequencyMHz } from '../core/tvhParse.js';
import { iso, isoNow } from './support.js';

export function tvhStateDto(t: TvhState): TvhStateDto {
  return {
    configured: t.configured,
    connected: t.connected,
    lastOkAt: iso(t.lastOkAt),
    downSince: t.connected ? null : iso(t.downSince),
    error: t.error,
    version: t.version,
  };
}

export function channelRef(catalog: Catalog, name: string | null): ChannelRef {
  return { id: catalog.channelByName(name)?.uuid ?? null, name: name ?? 'Unknown channel' };
}

export function muxRef(catalog: Catalog, name: string | null): MuxRef | null {
  if (!name) return null;
  const m = catalog.mux(name);
  return { name, label: m?.label ?? null, freqMHz: m?.freqMHz ?? muxFrequencyMHz(name) };
}

export function appInfo(r: {
  app: string | null;
  appVersion: string | null;
  device: string | null;
  platform: string | null;
  client: string | null;
}): AppInfo | null {
  if (!r.app && !r.client) return null;
  return {
    app: r.app ?? r.client ?? 'Unknown',
    version: r.appVersion,
    device: r.device,
    platform: r.platform,
    raw: r.client ?? '',
  };
}

/** Clients behind the HTTPS proxy show up with the proxy's address, which says nothing about them. */
export function source(ip: string | null, route: Route | null, country: string | null): Source {
  const r = route ?? 'none';
  return { ip: r === 'proxy' ? null : ip, route: r, country };
}

/** "Silicon Labs Si2168 #0 : DVB-T #0" → "Si2168 #0". */
export function tunerLabel(name: string): string {
  const device = name.split(' : ')[0] ?? name;
  return device
    .replace(/^(Silicon Labs|Sony|Montage|Availink|Maxlinear|Rafael Micro|NXP|Realtek)\s+/i, '')
    .trim();
}

export function liveSession(s: TrackedSession, catalog: Catalog): LiveSession {
  return {
    id: s.id,
    kind: s.kind === 'recording' ? 'recording' : 'playback',
    user: s.username,
    channel: channelRef(catalog, s.channel),
    mux: muxRef(catalog, s.mux),
    tuner: s.tuner ? tunerLabel(s.tuner) : null,
    app: appInfo(s),
    source: source(s.ip, s.route, null),
    startedAt: isoNow(s.startedAt),
    rateBps: s.rateBps,
    bytes: s.bytes,
    errors: s.errors,
    rateHistory: [...s.rateHistory],
    title: s.title,
  };
}

export interface SessionDbRow {
  id: number;
  kind: 'stream' | 'recording';
  username: string | null;
  channel: string | null;
  title: string | null;
  tuner: string | null;
  mux: string | null;
  client: string | null;
  app: string | null;
  app_version: string | null;
  device: string | null;
  platform: string | null;
  ip: string | null;
  route: Route | null;
  country: string | null;
  started_at: number;
  ended_at: number | null;
  last_seen_at: number;
  bytes: number;
  errors: number;
  outcome: 'ok' | 'failed' | null;
  quality: string | null;
  visit_id: number | null;
}

export function sessionRow(r: SessionDbRow, catalog: Catalog): SessionRow {
  return {
    id: r.id,
    kind: r.kind === 'recording' ? 'recording' : 'playback',
    user: r.username,
    channel: channelRef(catalog, r.channel),
    mux: muxRef(catalog, r.mux),
    tuner: r.tuner ? tunerLabel(r.tuner) : null,
    app: appInfo({
      app: r.app,
      appVersion: r.app_version,
      device: r.device,
      platform: r.platform,
      client: r.client,
    }),
    source: source(r.ip, r.route, r.country),
    startedAt: isoNow(r.started_at),
    endedAt: iso(r.ended_at),
    durationSec: Math.max(0, (r.ended_at ?? r.last_seen_at) - r.started_at),
    bytes: r.bytes,
    errors: r.errors,
    title: r.title,
    outcome: r.outcome,
    estimated: r.quality !== null,
    visitId: r.visit_id,
  };
}
