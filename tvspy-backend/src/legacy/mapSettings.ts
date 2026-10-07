// Maps the legacy `config` table to v4 settings. Secrets are copied but never reported; message
// templates are dropped because v4 uses fixed Telegram texts.

import { isIp, isValidCidr } from '../core/ip.js';

export type SettingValue = string | number | boolean | string[];

export interface MappedSettings {
  values: Record<string, SettingValue>;
  /** Legacy key → v4 key(s), for the report. Values are never included. */
  mapped: Record<string, string>;
  dropped: string[];
  secretsSet: Record<string, boolean>;
}

export const SECRET_SETTINGS = new Set(['tvh.password', 'telegram.botToken']);

const truthy = (v: string | undefined) =>
  v !== undefined && ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
const present = (v: string | undefined): v is string => v !== undefined && v !== null && v.trim() !== '';

const RULE_FLAGS: Record<string, string> = {
  telegram_notification_start_playback: 'rules.playbackStart.enabled',
  telegram_notification_stop_playback: 'rules.playbackStop.enabled',
  telegram_notification_start_recording: 'rules.recordingStart.enabled',
  telegram_notification_stop_recording: 'rules.recordingStop.enabled',
  telegram_notification_time: 'rules.longWatch.enabled',
  // Old meaning: "IP not in the allowed list"; v4 alerts on a new network for an account instead.
  telegram_notification_ip_not_allowed: 'rules.newNetwork.enabled',
};

export function mapLegacySettings(config: Record<string, string | undefined>): MappedSettings {
  const values: Record<string, SettingValue> = {};
  const mapped: Record<string, string> = {};
  const used = new Set<string>();
  const use = (legacyKey: string, target: string) => {
    used.add(legacyKey);
    mapped[legacyKey] = target;
  };

  const host = config.hostname?.trim();
  if (present(host)) {
    const protocol = config.protocol?.trim() === 'https' ? 'https' : 'http';
    const port = present(config.port) && /^\d+$/.test(config.port.trim()) ? config.port.trim() : '9981';
    values['tvh.url'] =
      `${protocol}://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`;
  }
  for (const k of ['hostname', 'protocol', 'port']) use(k, 'tvh.url');

  if (present(config.username)) values['tvh.username'] = config.username.trim();
  use('username', 'tvh.username');
  if (present(config.password)) values['tvh.password'] = config.password;
  use('password', 'tvh.password');
  values['tvh.auth'] = config.auth?.trim() === 'plain' ? 'basic' : 'auto';
  use('auth', 'tvh.auth');

  if (present(config.ip_allowed)) {
    const list = config.ip_allowed
      .split(',')
      .map((s) => s.trim())
      .filter((s) => isIp(s) || isValidCidr(s));
    if (list.length > 0) values['network.trustedIps'] = list;
  }
  use('ip_allowed', 'network.trustedIps');

  if (present(config.minimum_time) && /^\d+$/.test(config.minimum_time.trim())) {
    values['stats.minSessionSec'] = Number(config.minimum_time.trim());
  }
  use('minimum_time', 'stats.minSessionSec');

  values['log.level'] = truthy(config.debug_mode) ? 'debug' : 'info';
  use('debug_mode', 'log.level');

  values['telegram.enabled'] = truthy(config.telegram_notification);
  use('telegram_notification', 'telegram.enabled');
  if (present(config.telegram_bot_token)) values['telegram.botToken'] = config.telegram_bot_token.trim();
  use('telegram_bot_token', 'telegram.botToken');
  if (present(config.telegram_id)) values['telegram.chatId'] = config.telegram_id.trim();
  use('telegram_id', 'telegram.chatId');

  for (const [legacyKey, target] of Object.entries(RULE_FLAGS)) {
    values[target] = truthy(config[legacyKey]);
    use(legacyKey, target);
  }
  if (present(config.telegram_time_limit) && /^\d+$/.test(config.telegram_time_limit.trim())) {
    values['rules.longWatch.limitMinutes'] = Number(config.telegram_time_limit.trim());
  }
  use('telegram_time_limit', 'rules.longWatch.limitMinutes');

  const dropped = Object.keys(config)
    .filter((k) => !used.has(k))
    .sort();
  const secretsSet = Object.fromEntries([...SECRET_SETTINGS].map((k) => [k, k in values]));
  return { values, mapped, dropped, secretsSet };
}
