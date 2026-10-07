// Channel and mux catalog from TVH (refreshed every 15 minutes): channel logos, channel → mux mapping,
// mux frequency and whether a mux is monitored (enabled, with at least one enabled channel). Also the
// newest service `last_seen` per mux, which TVH refreshes whenever it tunes the mux (e.g. the nightly
// EPG grab): a quiet sign that reception still works when nobody watches.

import { muxFrequencyMHz } from '../core/tvhParse.js';
import type { DB } from '../db/open.js';
import { fetchChannels, fetchMuxes, fetchServices } from '../tvh/api.js';
import type { TvhClient } from '../tvh/client.js';

export interface CatalogChannel {
  uuid: string;
  name: string;
  icon: string | null;
  mux: string | null;
  number: number | null;
  enabled: boolean;
}

export interface CatalogMux {
  name: string;
  label: string | null;
  freqMHz: number | null;
  monitored: boolean;
  servicesLastSeen: number | null;
}

export class Catalog {
  private byUuid = new Map<string, CatalogChannel>();
  private byName = new Map<string, CatalogChannel>();
  private muxes = new Map<string, CatalogMux>();
  loadedAt = 0;

  constructor(private readonly db: DB) {
    this.load();
  }

  private load(): void {
    const channels = this.db.prepare('SELECT * FROM channels').all() as {
      uuid: string;
      name: string;
      number: number | null;
      icon: string | null;
      mux: string | null;
      enabled: number;
    }[];
    this.byUuid.clear();
    this.byName.clear();
    for (const c of channels) {
      const ch: CatalogChannel = { ...c, enabled: c.enabled === 1 };
      this.byUuid.set(c.uuid, ch);
      if (ch.enabled || !this.byName.has(c.name)) this.byName.set(c.name, ch);
    }
    const muxes = this.db.prepare('SELECT * FROM muxes').all() as {
      name: string;
      label: string | null;
      freq_hz: number | null;
      monitored: number;
      services_last_seen: number | null;
    }[];
    this.muxes.clear();
    for (const m of muxes) {
      this.muxes.set(m.name, {
        name: m.name,
        label: m.label,
        freqMHz: m.freq_hz ? m.freq_hz / 1e6 : muxFrequencyMHz(m.name),
        monitored: m.monitored === 1,
        servicesLastSeen: m.services_last_seen,
      });
    }
  }

  async refresh(client: TvhClient, now: number): Promise<void> {
    const [channels, services, muxes] = await Promise.all([
      fetchChannels(client),
      fetchServices(client),
      fetchMuxes(client),
    ]);
    const serviceMux = new Map(services.map((s) => [s.uuid, s.mux]));
    const lastSeen = new Map<string, number>();
    for (const s of services) {
      if (!s.enabled || !s.mux || s.lastSeen === null) continue;
      lastSeen.set(s.mux, Math.max(lastSeen.get(s.mux) ?? 0, s.lastSeen));
    }
    const channelMux = (services: string[]) => services.map((u) => serviceMux.get(u)).find(Boolean) ?? null;
    const muxWithChannel = new Set(
      channels
        .filter((c) => c.enabled)
        .map((c) => channelMux(c.services))
        .filter(Boolean),
    );

    this.db.transaction(() => {
      this.db.prepare('DELETE FROM channels').run();
      const insertChannel = this.db.prepare(
        'INSERT INTO channels (uuid, name, number, icon, mux, enabled, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      for (const c of channels) {
        insertChannel.run(c.uuid, c.name, c.number, c.icon, channelMux(c.services), c.enabled ? 1 : 0, now);
      }
      const upsertMux = this.db.prepare(`
        INSERT INTO muxes (name, uuid, network, freq_hz, delsys, enabled, monitored, scan_result, services_last_seen, updated_at)
        VALUES (@name, @uuid, @network, @freq, @delsys, @enabled, @monitored, @scanResult, @lastSeen, @now)
        ON CONFLICT (name) DO UPDATE SET uuid = excluded.uuid, network = excluded.network, freq_hz = excluded.freq_hz,
          delsys = excluded.delsys, enabled = excluded.enabled, monitored = excluded.monitored,
          scan_result = excluded.scan_result, services_last_seen = excluded.services_last_seen,
          updated_at = excluded.updated_at`);
      for (const m of muxes) {
        upsertMux.run({
          name: m.name,
          uuid: m.uuid,
          network: m.network,
          freq: m.frequency,
          delsys: m.delsys,
          enabled: m.enabled ? 1 : 0,
          monitored: m.enabled && muxWithChannel.has(m.name) ? 1 : 0,
          scanResult: m.scanResult,
          lastSeen: lastSeen.get(m.name) ?? null,
          now,
        });
      }
      // Muxes deleted in TVH keep their history but are no longer monitored.
      this.db.prepare('UPDATE muxes SET enabled = 0, monitored = 0 WHERE updated_at != ?').run(now);
    })();
    this.loadedAt = now;
    this.load();
  }

  channel(uuid: string): CatalogChannel | undefined {
    return this.byUuid.get(uuid);
  }

  channelByName(name: string | null): CatalogChannel | undefined {
    return name ? this.byName.get(name) : undefined;
  }

  mux(name: string | null): CatalogMux | undefined {
    return name ? this.muxes.get(name) : undefined;
  }

  monitoredMuxes(): CatalogMux[] {
    return [...this.muxes.values()].filter((m) => m.monitored);
  }

  channelCount(): number {
    return this.byUuid.size;
  }
}
