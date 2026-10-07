import { EventEmitter } from 'node:events';
import type { DB } from '../db/open.js';
import { isSecret, isSettingKey, SETTINGS, type SettingKey, type SettingValue } from './schema.js';

export class SettingsValidationError extends Error {
  constructor(readonly fields: Record<string, string>) {
    super('Some settings are invalid');
  }
}

/**
 * Settings live in the `settings` table as JSON; anything missing or invalid falls back to its default.
 * Emits "change" with the changed keys so collectors pick up new values without a restart.
 */
export class SettingsStore extends EventEmitter<{ change: [SettingKey[]] }> {
  private values = new Map<SettingKey, unknown>();

  constructor(
    private readonly db: DB,
    private readonly onInvalid: (key: string, reason: string) => void = () => {},
  ) {
    super();
    this.reload();
  }

  reload(): void {
    this.values.clear();
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    for (const { key, value } of rows) {
      if (!isSettingKey(key)) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        this.onInvalid(key, 'not valid JSON');
        continue;
      }
      const result = SETTINGS[key].schema.safeParse(parsed);
      if (result.success) this.values.set(key, result.data);
      else this.onInvalid(key, result.error.issues[0]?.message ?? 'invalid');
    }
  }

  get<K extends SettingKey>(key: K): SettingValue<K> {
    return (this.values.has(key) ? this.values.get(key) : SETTINGS[key].default) as SettingValue<K>;
  }

  /** For secrets: whether a non-empty value is stored. */
  isSet(key: SettingKey): boolean {
    const v = this.get(key);
    return typeof v === 'string' ? v.length > 0 : v !== undefined && v !== null;
  }

  /**
   * Applies changes atomically. `null` resets a setting to its default (clears a secret). All values are
   * validated before anything is written.
   */
  update(changes: Partial<Record<SettingKey, unknown>>, now = Math.floor(Date.now() / 1000)): SettingKey[] {
    const errors: Record<string, string> = {};
    const writes: [SettingKey, unknown][] = [];
    for (const [key, raw] of Object.entries(changes) as [SettingKey, unknown][]) {
      if (raw === undefined) continue;
      if (raw === null) {
        writes.push([key, null]);
        continue;
      }
      const result = SETTINGS[key].schema.safeParse(raw);
      if (result.success) writes.push([key, result.data]);
      else errors[key] = result.error.issues[0]?.message ?? 'Invalid value';
    }
    if (Object.keys(errors).length > 0) throw new SettingsValidationError(errors);

    const upsert = this.db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    const remove = this.db.prepare('DELETE FROM settings WHERE key = ?');
    const changed: SettingKey[] = [];
    this.db.transaction(() => {
      for (const [key, value] of writes) {
        if (value === null) remove.run(key);
        else upsert.run(key, JSON.stringify(value), now);
      }
    })();
    // Memory changes only after the commit, so a failed write leaves both unchanged.
    for (const [key, value] of writes) {
      const before = JSON.stringify(this.get(key));
      if (value === null) this.values.delete(key);
      else this.values.set(key, value);
      if (JSON.stringify(this.get(key)) !== before) changed.push(key);
    }
    if (changed.length > 0) this.emit('change', changed);
    return changed;
  }

  /** Every setting with secrets replaced by whether they are set; safe to log or return. */
  publicSnapshot(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(SETTINGS) as SettingKey[]) {
      out[key] = isSecret(key) ? { set: this.isSet(key) } : this.get(key);
    }
    return out;
  }
}
