// Alert rules. Session events (start/stop/long watch) are one-off messages keyed by session or visit.
// Conditions (TVHeadend down, a mux without reception) are state machines persisted in alert_state:
// ok → pending → firing → ok, with one message on firing and one on recovery, also across restarts.

import type { Catalog } from '../collect/catalog.js';
import type { TrackedSession } from '../collect/sessions.js';
import type { TunerMonitor } from '../collect/tuners.js';
import type { TvhState } from '../collect/tvhState.js';
import type { DB } from '../db/open.js';
import type { SettingsStore } from '../settings/store.js';
import { messages, type SessionFacts } from './messages.js';
import type { Outbox } from './outbox.js';

/** TVHeadend must be unreachable this long before the alert fires. */
export const TVH_DOWN_AFTER_SEC = 90;
/** No TVHeadend alert in the first minutes after tvspy starts (both usually start together). */
export const TVH_STARTUP_GRACE_SEC = 180;
/** Reception alerts wait for a fresh catalog and some measurements after a start. */
export const MUX_STARTUP_GRACE_SEC = 600;

type Status = 'ok' | 'pending' | 'firing';

interface AlertState {
  rule: string;
  subject: string;
  status: Status;
  pending_since: number | null;
  firing_since: number | null;
  clear_since: number | null;
  last_notified_at: number | null;
  incident_id: number | null;
}

export interface AlertDeps {
  db: DB;
  settings: SettingsStore;
  outbox: Outbox;
  tvh: TvhState;
  catalog: Catalog;
  tuners: TunerMonitor;
  openSessions: () => Iterable<TrackedSession>;
  tz: () => string;
}

const facts = (s: TrackedSession): SessionFacts => ({
  username: s.username,
  channel: s.channel,
  title: s.title,
  app: s.app,
  device: s.device,
  platform: s.platform,
  ip: s.ip,
  route: s.route,
});

export class AlertEngine {
  /** Sessions that were already running when tvspy started without a record of their start message. */
  private readonly skip = new Set<number>();
  private readonly startHandled = new Set<number>();
  private readonly visitStart = new Map<number, { visitId: number; start: number }>();

  constructor(
    private readonly deps: AlertDeps,
    private readonly startedAt: number,
  ) {
    const legacyOpen = deps.db
      .prepare(`SELECT id FROM sessions WHERE ended_at IS NULL AND source = 'legacy'`)
      .all() as { id: number }[];
    for (const { id } of legacyOpen) this.skip.add(id);
  }

  /** After each successful subscriptions poll: start messages once a session lasted the minimum time. */
  onPoll(now: number): void {
    const { settings, outbox } = this.deps;
    const min = settings.get('stats.minSessionSec');
    for (const s of this.deps.openSessions()) {
      if (this.skip.has(s.id) || this.startHandled.has(s.id)) continue;
      if (s.lastSeenAt - s.startedAt < min) continue;
      this.startHandled.add(s.id);
      if (s.kind === 'recording') {
        if (settings.get('rules.recordingStart.enabled')) {
          outbox.enqueue(
            {
              rule: 'recordingStart',
              subject: s.channel,
              dedupeKey: `recordingStart:${s.id}`,
              text: messages.recordingStart(facts(s)),
            },
            now,
          );
        }
      } else if (settings.get('rules.playbackStart.enabled')) {
        outbox.enqueue(
          {
            rule: 'playbackStart',
            subject: s.username,
            dedupeKey: `playbackStart:${s.id}`,
            text: messages.playbackStart(facts(s)),
          },
          now,
        );
      }
    }
  }

  /** Session end (from the tracker). Stops are reported for sessions long enough to have been reported. */
  onSessionEnd(s: TrackedSession, endedAt: number, outcome: 'ok' | 'failed', now: number): void {
    this.startHandled.delete(s.id);
    this.visitStart.delete(s.id);
    if (this.skip.delete(s.id)) return;
    const { settings, outbox } = this.deps;
    const duration = Math.max(0, endedAt - s.startedAt);
    if (s.kind === 'recording') {
      // A recording that got no data matters even when short.
      if (!settings.get('rules.recordingStop.enabled')) return;
      if (outcome === 'ok' && duration < settings.get('stats.minSessionSec')) return;
      outbox.enqueue(
        {
          rule: 'recordingStop',
          subject: s.channel,
          dedupeKey: `recordingStop:${s.id}`,
          text: messages.recordingStop(facts(s), duration, s.bytes, outcome === 'failed'),
        },
        now,
      );
      return;
    }
    if (!settings.get('rules.playbackStop.enabled')) return;
    if (duration < settings.get('stats.minSessionSec')) return;
    outbox.enqueue(
      {
        rule: 'playbackStop',
        subject: s.username,
        dedupeKey: `playbackStop:${s.id}`,
        text: messages.playbackStop(facts(s), duration, s.bytes),
      },
      now,
    );
  }

  /** Periodic rules (every ~15 s). */
  evaluate(now: number): void {
    this.longWatch(now);
    this.tvhDown(now);
    this.muxStale(now);
  }

  private longWatch(now: number): void {
    const { settings, outbox, db } = this.deps;
    if (!settings.get('rules.longWatch.enabled')) return;
    const limit = settings.get('rules.longWatch.limitMinutes') * 60;
    for (const s of this.deps.openSessions()) {
      if (s.kind !== 'stream' || this.skip.has(s.id)) continue;
      let visit = this.visitStart.get(s.id);
      if (!visit) {
        const row = db
          .prepare(
            `SELECT v.visit_id AS visitId, MIN(o.started_at) AS start
             FROM sessions v JOIN sessions o ON o.visit_id = v.visit_id
             WHERE v.id = ? GROUP BY v.visit_id`,
          )
          .get(s.id) as { visitId: number; start: number } | undefined;
        visit = row ?? { visitId: s.id, start: s.startedAt };
        this.visitStart.set(s.id, visit);
      }
      const watched = s.lastSeenAt - visit.start;
      if (watched < limit) continue;
      outbox.enqueue(
        {
          rule: 'longWatch',
          subject: s.username,
          dedupeKey: `longWatch:${visit.visitId}`,
          text: messages.longWatch(facts(s), watched),
        },
        now,
      );
    }
  }

  private tvhDown(now: number): void {
    const { settings, outbox, tvh } = this.deps;
    const enabled = settings.get('rules.tvhDown.enabled');
    const st = this.state('tvhDown', '');
    if (!tvh.configured) {
      if (st.status !== 'ok') this.reset(st, now);
      return;
    }
    if (tvh.connected) {
      if (st.status === 'firing' && enabled) {
        const since = st.pending_since ?? st.firing_since ?? now;
        outbox.enqueue(
          { rule: 'tvhDown', dedupeKey: `tvhUp:${since}`, text: messages.tvhUp(now - since) },
          now,
        );
      }
      if (st.status !== 'ok') this.reset(st, now);
      return;
    }
    // Start of the current continuous outage (the state may remember an earlier one).
    const since = tvh.downSince ?? now;
    if (st.status === 'firing') return;
    if (st.status === 'ok' || st.pending_since !== since) {
      this.save({ ...st, status: 'pending', pending_since: since, firing_since: null, clear_since: null });
    }
    if (now - since < TVH_DOWN_AFTER_SEC || now - this.startedAt < TVH_STARTUP_GRACE_SEC) return;
    const auth = tvh.errorKind === 'auth' || tvh.errorKind === 'forbidden';
    const incident = this.openIncident('tvhDown', '', since, tvh.error);
    if (enabled) {
      outbox.enqueue(
        {
          rule: 'tvhDown',
          dedupeKey: `tvhDown:${since}`,
          text: messages.tvhDown(since, tvh.error, auth, this.deps.tz()),
        },
        now,
      );
    }
    this.save({
      ...st,
      status: 'firing',
      pending_since: since,
      firing_since: now,
      last_notified_at: now,
      incident_id: incident,
    });
  }

  private muxStale(now: number): void {
    const { settings, outbox, tvh, catalog } = this.deps;
    if (!tvh.connected || now - this.startedAt < MUX_STARTUP_GRACE_SEC || catalog.loadedAt < this.startedAt)
      return;
    const enabled = settings.get('rules.muxStale.enabled');
    const staleAfter = settings.get('reception.staleHours') * 3600;
    const monitored = new Set<string>();
    for (const mux of catalog.monitoredMuxes()) {
      monitored.add(mux.name);
      const lastGood = this.lastGood(mux.name, mux.servicesLastSeen, now);
      if (lastGood === null) continue;
      const st = this.state('muxStale', mux.name);
      const label = mux.label ? `${mux.label} (${mux.name})` : mux.name;
      if (now - lastGood >= staleAfter) {
        if (st.status === 'firing') continue;
        const incident = this.openIncident('muxStale', mux.name, lastGood, null);
        if (enabled) {
          outbox.enqueue(
            {
              rule: 'muxStale',
              subject: mux.name,
              dedupeKey: `muxStale:${mux.name}:${lastGood}`,
              text: messages.muxStale(label, now - lastGood),
            },
            now,
          );
        }
        this.save({
          ...st,
          status: 'firing',
          pending_since: lastGood,
          firing_since: now,
          last_notified_at: now,
          incident_id: incident,
        });
      } else if (st.status === 'firing') {
        const since = st.pending_since ?? st.firing_since ?? now;
        if (enabled) {
          outbox.enqueue(
            {
              rule: 'muxStale',
              subject: mux.name,
              dedupeKey: `muxBack:${mux.name}:${since}`,
              text: messages.muxBack(label, lastGood - since),
            },
            now,
          );
        }
        this.reset(st, now);
      }
    }
    // A mux that is no longer monitored (disabled, removed) clears silently.
    const firing = this.deps.db
      .prepare(`SELECT * FROM alert_state WHERE rule = 'muxStale' AND status != 'ok'`)
      .all() as AlertState[];
    for (const st of firing) if (!monitored.has(st.subject)) this.reset(st, now);
  }

  /** Latest evidence that the mux could be received: TVH's service timestamps, tuner locks, good streams. */
  private lastGood(mux: string, servicesLastSeen: number | null, now: number): number | null {
    const lockedNow = this.deps.tuners.snapshots(now).some((t) => t.input.mux === mux && t.input.locked);
    if (lockedNow) return now;
    const { db } = this.deps;
    const minute = db
      .prepare('SELECT MAX(ts) + 60 AS t FROM reception_minute WHERE mux = ? AND n_locked > 0')
      .get(mux) as { t: number | null };
    const session = db
      .prepare(
        `SELECT MAX(last_seen_at) AS t FROM sessions
         WHERE mux = ? AND (outcome = 'ok' OR ended_at IS NULL) AND bytes >= 1000000`,
      )
      .get(mux) as { t: number | null };
    const candidates = [servicesLastSeen, minute.t, session.t].filter((t): t is number => t !== null);
    return candidates.length ? Math.max(...candidates) : null;
  }

  private state(rule: string, subject: string): AlertState {
    const row = this.deps.db
      .prepare('SELECT * FROM alert_state WHERE rule = ? AND subject = ?')
      .get(rule, subject) as AlertState | undefined;
    return (
      row ?? {
        rule,
        subject,
        status: 'ok',
        pending_since: null,
        firing_since: null,
        clear_since: null,
        last_notified_at: null,
        incident_id: null,
      }
    );
  }

  private save(st: AlertState): void {
    this.deps.db
      .prepare(
        `INSERT INTO alert_state (rule, subject, status, pending_since, firing_since, clear_since, last_notified_at, incident_id)
         VALUES (@rule, @subject, @status, @pending_since, @firing_since, @clear_since, @last_notified_at, @incident_id)
         ON CONFLICT (rule, subject) DO UPDATE SET status = excluded.status, pending_since = excluded.pending_since,
           firing_since = excluded.firing_since, clear_since = excluded.clear_since,
           last_notified_at = excluded.last_notified_at, incident_id = excluded.incident_id`,
      )
      .run(st);
  }

  private reset(st: AlertState, now: number): void {
    if (st.incident_id !== null) {
      this.deps.db
        .prepare('UPDATE incidents SET ended_at = ? WHERE id = ? AND ended_at IS NULL')
        .run(now, st.incident_id);
    }
    this.save({
      ...st,
      status: 'ok',
      pending_since: null,
      firing_since: null,
      clear_since: now,
      incident_id: null,
    });
  }

  private openIncident(kind: string, subject: string, since: number, detail: string | null): number {
    const result = this.deps.db
      .prepare('INSERT INTO incidents (kind, subject, started_at, detail) VALUES (?, ?, ?, ?)')
      .run(kind, subject, since, detail);
    return Number(result.lastInsertRowid);
  }
}
