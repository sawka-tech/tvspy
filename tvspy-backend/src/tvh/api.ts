// Typed, defensive wrappers around the TVHeadend endpoints tvspy reads. Grids are paginated by TVH
// (50 rows by default), so every grid call passes an explicit limit.

import { parseInput, parseSubscription, type TvhInput, type TvhSubscription } from '../core/tvhParse.js';
import type { TvhClient } from './client.js';

type Entry = Record<string, unknown>;

const entries = (body: unknown): Entry[] => {
  const list = (body as { entries?: unknown } | null)?.entries;
  return Array.isArray(list) ? (list.filter((e) => e && typeof e === 'object') as Entry[]) : [];
};
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export async function fetchSubscriptions(client: TvhClient): Promise<TvhSubscription[]> {
  return entries(await client.json('/api/status/subscriptions'))
    .map(parseSubscription)
    .filter((s): s is TvhSubscription => s !== null);
}

export async function fetchInputs(client: TvhClient): Promise<TvhInput[]> {
  return entries(await client.json('/api/status/inputs'))
    .map(parseInput)
    .filter((i): i is TvhInput => i !== null);
}

export async function fetchServerInfo(client: TvhClient): Promise<{ version: string | null }> {
  const body = (await client.json('/api/serverinfo')) as Entry;
  return { version: str(body?.sw_version) };
}

export interface TvhChannel {
  uuid: string;
  name: string;
  number: number | null;
  icon: string | null;
  enabled: boolean;
  services: string[];
}

export async function fetchChannels(client: TvhClient): Promise<TvhChannel[]> {
  return entries(await client.json('/api/channel/grid?all=1&limit=5000', 15_000)).flatMap((e) => {
    const uuid = str(e.uuid);
    if (!uuid) return [];
    return [
      {
        uuid,
        name: str(e.name) ?? '',
        number: num(e.number),
        icon: str(e.icon_public_url) ?? str(e.icon),
        enabled: e.enabled !== false,
        services: Array.isArray(e.services)
          ? e.services.filter((s): s is string => typeof s === 'string')
          : [],
      },
    ];
  });
}

export interface TvhService {
  uuid: string;
  mux: string | null;
  network: string | null;
  name: string | null;
  enabled: boolean;
  lastSeen: number | null;
}

export async function fetchServices(client: TvhClient): Promise<TvhService[]> {
  return entries(await client.json('/api/mpegts/service/grid?limit=20000', 15_000)).flatMap((e) => {
    const uuid = str(e.uuid);
    if (!uuid) return [];
    return [
      {
        uuid,
        mux: str(e.multiplex),
        network: str(e.network),
        name: str(e.svcname),
        enabled: e.enabled !== false,
        lastSeen: num(e.last_seen),
      },
    ];
  });
}

export interface TvhMux {
  uuid: string;
  name: string;
  network: string | null;
  frequency: number | null;
  delsys: string | null;
  enabled: boolean;
  scanResult: string | null;
}

export async function fetchMuxes(client: TvhClient): Promise<TvhMux[]> {
  return entries(await client.json('/api/mpegts/mux/grid?limit=1000', 15_000)).flatMap((e) => {
    const uuid = str(e.uuid);
    const name = str(e.name);
    if (!uuid || !name) return [];
    const enabled = typeof e.enabled === 'number' ? e.enabled !== 0 : e.enabled !== false;
    return [
      {
        uuid,
        name,
        network: str(e.network),
        frequency: num(e.frequency),
        delsys: str(e.delsys),
        enabled,
        scanResult: e.scan_result === undefined || e.scan_result === null ? null : String(e.scan_result),
      },
    ];
  });
}
