import type { Migration } from '../migrate.js';

// Conventions: instants are INTEGER unix seconds (UTC); calendar days are TEXT 'YYYY-MM-DD' in the
// configured zone; bytes are INTEGER. No column is called "end" (an SQL keyword).
export const migration001: Migration = {
  version: 1,
  name: 'init',
  up(db) {
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,              -- JSON
        updated_at INTEGER NOT NULL
      ) WITHOUT ROWID;

      CREATE TABLE admin_user (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        username TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        password_changed_at INTEGER NOT NULL
      );

      CREATE TABLE auth_sessions (
        token_hash TEXT PRIMARY KEY,      -- SHA-256 of the cookie token; the token itself is never stored
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        ip TEXT,
        user_agent TEXT
      ) WITHOUT ROWID;

      CREATE TABLE sessions (
        id INTEGER PRIMARY KEY,
        sub_key TEXT NOT NULL UNIQUE,     -- '<start>-<tvh subscription id>' | 'legacy-<registries.id>'
        legacy_id INTEGER UNIQUE,
        source TEXT NOT NULL CHECK (source IN ('live', 'legacy')),
        kind TEXT NOT NULL CHECK (kind IN ('stream', 'recording')),
        username TEXT,
        channel TEXT,
        title TEXT,
        service TEXT,
        profile TEXT,
        tuner TEXT,
        network TEXT,
        mux TEXT,
        client TEXT,
        app TEXT,
        app_version TEXT,
        device TEXT,
        platform TEXT,
        ip TEXT,
        route TEXT CHECK (route IN ('proxy', 'lan', 'direct', 'none')),
        country TEXT,
        asn INTEGER,
        as_org TEXT,
        started_at INTEGER NOT NULL,
        start_day TEXT NOT NULL,
        last_seen_at INTEGER NOT NULL,    -- watermark: time accounted in usage_hourly so far
        ended_at INTEGER,                 -- NULL while open
        bytes INTEGER NOT NULL DEFAULT 0, -- watermark: volume accounted in usage_hourly so far
        bytes_in INTEGER NOT NULL DEFAULT 0,
        bytes_out INTEGER,
        errors INTEGER NOT NULL DEFAULT 0,
        outcome TEXT CHECK (outcome IN ('ok', 'failed')),
        quality TEXT CHECK (quality IN ('end_estimated', 'end_suspect', 'unclosed')),
        visit_id INTEGER
      );
      CREATE INDEX sessions_open ON sessions (id) WHERE ended_at IS NULL;
      CREATE INDEX sessions_start ON sessions (started_at);
      CREATE INDEX sessions_day ON sessions (start_day, kind);
      CREATE INDEX sessions_user ON sessions (username, started_at);
      CREATE INDEX sessions_channel ON sessions (channel, started_at);
      CREATE INDEX sessions_visit ON sessions (visit_id);
      CREATE INDEX sessions_mux ON sessions (mux, last_seen_at);

      -- One row per session and local hour: exact per-day watch time and data, any dimension via a join.
      CREATE TABLE usage_hourly (
        session_id INTEGER NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
        hour_start INTEGER NOT NULL,
        day TEXT NOT NULL,
        hour INTEGER NOT NULL,
        watch_s INTEGER NOT NULL,
        bytes INTEGER NOT NULL,
        PRIMARY KEY (session_id, hour_start)
      ) WITHOUT ROWID;
      CREATE INDEX usage_day ON usage_hourly (day);

      CREATE TABLE concurrency_daily (
        day TEXT PRIMARY KEY,
        source TEXT NOT NULL CHECK (source IN ('live', 'sweep')),
        peak_streams INTEGER NOT NULL,
        peak_streams_at INTEGER,
        peak_tuners INTEGER NOT NULL,
        peak_tuners_at INTEGER,
        tuners_total INTEGER,
        saturated_s INTEGER NOT NULL DEFAULT 0,
        failed_while_full INTEGER NOT NULL DEFAULT 0
      ) WITHOUT ROWID;

      -- Which days were monitored at all, so gaps show as "no data" rather than zero viewing.
      CREATE TABLE coverage_daily (
        day TEXT PRIMARY KEY,
        source TEXT NOT NULL CHECK (source IN ('live', 'legacy')),
        monitored_s INTEGER,
        tvh_up_s INTEGER
      ) WITHOUT ROWID;

      CREATE TABLE user_devices (
        username TEXT NOT NULL,
        app TEXT NOT NULL,
        platform TEXT NOT NULL DEFAULT '',
        device TEXT NOT NULL DEFAULT '',
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        sessions INTEGER NOT NULL,
        last_client TEXT,
        PRIMARY KEY (username, app, platform, device)
      ) WITHOUT ROWID;

      CREATE TABLE user_ips (
        username TEXT NOT NULL,
        ip TEXT NOT NULL,
        route TEXT NOT NULL,
        country TEXT,
        asn INTEGER,
        as_org TEXT,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        sessions INTEGER NOT NULL,
        PRIMARY KEY (username, ip)
      ) WITHOUT ROWID;
      CREATE INDEX user_ips_asn ON user_ips (username, asn);

      CREATE TABLE channels (
        uuid TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        number REAL,
        icon TEXT,
        mux TEXT,
        enabled INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) WITHOUT ROWID;
      CREATE INDEX channels_name ON channels (name);

      CREATE TABLE muxes (
        name TEXT PRIMARY KEY,
        uuid TEXT,
        network TEXT,
        freq_hz INTEGER,
        delsys TEXT,
        label TEXT,
        enabled INTEGER,
        monitored INTEGER NOT NULL DEFAULT 1,
        scan_result TEXT,
        services_last_seen INTEGER,
        updated_at INTEGER NOT NULL
      ) WITHOUT ROWID;

      CREATE TABLE tuners (
        name TEXT PRIMARY KEY,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL
      ) WITHOUT ROWID;

      -- Reception per mux and tuner: minutes kept 90 days, hours forever. SNR from locked samples only.
      CREATE TABLE reception_minute (
        mux TEXT NOT NULL,
        tuner TEXT NOT NULL,
        ts INTEGER NOT NULL,
        n INTEGER NOT NULL,
        n_locked INTEGER NOT NULL,
        subs_max INTEGER NOT NULL,
        weight_max INTEGER NOT NULL,
        snr_min REAL,
        snr_avg REAL,
        snr_max REAL,
        sig_min REAL,
        sig_med REAL,
        sig_max REAL,
        ber_max INTEGER,
        unc INTEGER NOT NULL,
        te INTEGER NOT NULL,
        cc INTEGER NOT NULL,
        bps_avg INTEGER,
        PRIMARY KEY (mux, ts, tuner)
      ) WITHOUT ROWID;
      CREATE INDEX reception_minute_ts ON reception_minute (ts);

      CREATE TABLE reception_hourly (
        mux TEXT NOT NULL,
        tuner TEXT NOT NULL,
        ts INTEGER NOT NULL,
        minutes INTEGER NOT NULL,
        locked_minutes INTEGER NOT NULL,
        error_minutes INTEGER NOT NULL,
        snr_min REAL,
        snr_avg REAL,
        snr_max REAL,
        sig_med REAL,
        unc INTEGER,
        te INTEGER,
        cc INTEGER,
        PRIMARY KEY (mux, ts, tuner)
      ) WITHOUT ROWID;

      CREATE TABLE mux_health (
        mux TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        since INTEGER NOT NULL,
        last_ok_at INTEGER,
        last_fail_at INTEGER,
        snr_baseline REAL,
        detail TEXT
      ) WITHOUT ROWID;

      CREATE TABLE incidents (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,
        subject TEXT NOT NULL DEFAULT '',
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        detail TEXT
      );
      CREATE INDEX incidents_open ON incidents (kind, subject) WHERE ended_at IS NULL;
      CREATE INDEX incidents_time ON incidents (started_at);

      CREATE TABLE alert_state (
        rule TEXT NOT NULL,
        subject TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        pending_since INTEGER,
        firing_since INTEGER,
        clear_since INTEGER,
        last_notified_at INTEGER,
        incident_id INTEGER,
        PRIMARY KEY (rule, subject)
      ) WITHOUT ROWID;

      -- Outbox: every Telegram message is stored first; dedupe_key makes each event send at most once.
      CREATE TABLE notifications (
        id INTEGER PRIMARY KEY,
        created_at INTEGER NOT NULL,
        rule TEXT NOT NULL,
        subject TEXT,
        dedupe_key TEXT UNIQUE,
        text TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'suppressed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER,
        last_error TEXT,
        sent_at INTEGER
      );
      CREATE INDEX notifications_due ON notifications (next_attempt_at) WHERE status = 'pending';
    `);
  },
};
