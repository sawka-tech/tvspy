// Notification outbox. Every message is stored before it is sent; the dedupe key makes each event
// produce at most one message, also across restarts. Messages that cannot be sent (Telegram off or
// not configured) are kept as "suppressed" so the alert log still shows them.

import type { DB } from '../db/open.js';
import { redact } from '../log.js';
import type { SettingsStore } from '../settings/store.js';
import { type FetchLike, sendTelegram } from './telegram.js';

export interface OutboxMessage {
  rule: string;
  subject?: string | null;
  dedupeKey: string;
  text: string;
}

/** Retry delays after the 1st, 2nd, … failed attempt; after the last one the message is given up. */
const BACKOFF_SEC = [10, 30, 120, 600, 1800];
/** Undelivered messages older than this are dropped: a late start/stop or outage message only confuses. */
export const EXPIRE_SEC = 3600;

export class Outbox {
  constructor(
    private readonly db: DB,
    private readonly settings: SettingsStore,
    /** False when TVSPY_TELEGRAM=off. */
    private readonly telegramAllowed: boolean,
  ) {}

  /** Why messages are not sent right now, or null when Telegram is ready. */
  blockedReason(): string | null {
    if (!this.telegramAllowed) return 'Telegram is switched off for this container (TVSPY_TELEGRAM=off)';
    if (!this.settings.get('telegram.enabled')) return 'Telegram notifications are disabled';
    if (!this.settings.isSet('telegram.botToken') || !this.settings.get('telegram.chatId')) {
      return 'Telegram is not configured';
    }
    return null;
  }

  /** Stores a message; returns false when an event with the same key was already stored. */
  enqueue(m: OutboxMessage, now: number): boolean {
    const blocked = this.blockedReason();
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO notifications (created_at, rule, subject, dedupe_key, text, status, next_attempt_at, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        now,
        m.rule,
        m.subject ?? null,
        m.dedupeKey,
        m.text,
        blocked ? 'suppressed' : 'pending',
        now,
        blocked,
      );
    return result.changes > 0;
  }

  has(dedupeKey: string): boolean {
    return this.db.prepare('SELECT 1 FROM notifications WHERE dedupe_key = ?').get(dedupeKey) !== undefined;
  }
}

interface PendingRow {
  id: number;
  created_at: number;
  text: string;
  attempts: number;
}

/** Sends due messages one at a time (Telegram allows about one message per second per chat). */
export class OutboxSender {
  private busy = false;

  constructor(
    private readonly db: DB,
    private readonly settings: SettingsStore,
    private readonly outbox: Outbox,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly apiBase?: string,
  ) {}

  async tick(now: number, max = 3): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    try {
      this.db
        .prepare(
          `UPDATE notifications SET status = 'failed', last_error = 'Expired before it could be sent'
           WHERE status = 'pending' AND created_at < ?`,
        )
        .run(now - EXPIRE_SEC);
      let sent = 0;
      for (let i = 0; i < max; i++) {
        const row = this.db
          .prepare(
            `SELECT id, created_at, text, attempts FROM notifications
             WHERE status = 'pending' AND COALESCE(next_attempt_at, 0) <= ? ORDER BY id LIMIT 1`,
          )
          .get(now) as PendingRow | undefined;
        if (!row) break;
        const blocked = this.outbox.blockedReason();
        if (blocked) {
          this.db
            .prepare(
              `UPDATE notifications SET status = 'suppressed', last_error = ? WHERE status = 'pending'`,
            )
            .run(blocked);
          break;
        }
        const result = await sendTelegram(
          this.settings.get('telegram.botToken'),
          this.settings.get('telegram.chatId'),
          row.text,
          this.fetchImpl,
          this.apiBase,
        );
        const attempts = row.attempts + 1;
        if (result.ok) {
          this.db
            .prepare(
              `UPDATE notifications SET status = 'sent', attempts = ?, sent_at = ?, last_error = NULL WHERE id = ?`,
            )
            .run(attempts, now, row.id);
          sent++;
          continue;
        }
        const giveUp = result.permanent || attempts > BACKOFF_SEC.length;
        const delay = result.retryAfterSec ?? BACKOFF_SEC[Math.min(attempts, BACKOFF_SEC.length) - 1] ?? 60;
        this.db
          .prepare(
            `UPDATE notifications SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?`,
          )
          .run(giveUp ? 'failed' : 'pending', attempts, now + delay, redact(result.message), row.id);
        // Telegram is unhappy: try the rest later.
        break;
      }
      return sent;
    } finally {
      this.busy = false;
    }
  }
}
