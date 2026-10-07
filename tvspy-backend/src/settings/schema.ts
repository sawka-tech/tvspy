import { z } from 'zod';
import { DEFAULT_LAN_CIDRS, DEFAULT_PROXY_CIDRS, isIp, isValidCidr } from '../core/ip.js';

const cidrList = z
  .array(
    z
      .string()
      .trim()
      .refine((s) => isIp(s) || isValidCidr(s), 'Not an IP address or CIDR range'),
  )
  .max(50);

const tvhUrl = z
  .string()
  .trim()
  .refine((s) => s === '' || /^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/i.test(s), 'Use http(s)://host:port');

const flag = (value: boolean) => ({ schema: z.boolean(), default: value });

interface SettingDef {
  schema: z.ZodType;
  default: unknown;
  /** Write-only: never returned by the API or written to logs. */
  secret?: boolean;
}

export const SETTINGS = {
  'tvh.url': { schema: tvhUrl, default: '' },
  'tvh.username': { schema: z.string().trim().max(200), default: '' },
  'tvh.password': { schema: z.string().max(500), default: '', secret: true },
  'tvh.auth': { schema: z.enum(['auto', 'basic', 'digest']), default: 'auto' },

  'network.proxyCidrs': { schema: cidrList, default: DEFAULT_PROXY_CIDRS },
  'network.lanCidrs': { schema: cidrList, default: DEFAULT_LAN_CIDRS },
  'network.trustedIps': { schema: cidrList, default: [] as string[] },

  'stats.minSessionSec': { schema: z.number().int().min(0).max(3600), default: 10 },
  'stats.historicalTuners': { schema: z.number().int().min(1).max(32), default: 2 },
  'stats.visitGapSec': { schema: z.number().int().min(0).max(3600), default: 60 },

  /** 0 = whatever TVH reports. */
  'monitoring.tunersExpected': { schema: z.number().int().min(0).max(32), default: 0 },
  'reception.snrGoodDb': { schema: z.number().min(0).max(60), default: 26 },
  'reception.snrCriticalDb': { schema: z.number().min(0).max(60), default: 20 },
  'reception.staleHours': { schema: z.number().int().min(1).max(240), default: 27 },

  'telegram.enabled': flag(false),
  'telegram.botToken': { schema: z.string().trim().max(200), default: '', secret: true },
  'telegram.chatId': { schema: z.string().trim().max(100), default: '' },

  'rules.playbackStart.enabled': flag(false),
  'rules.playbackStop.enabled': flag(false),
  'rules.recordingStart.enabled': flag(false),
  'rules.recordingStop.enabled': flag(false),
  'rules.longWatch.enabled': flag(false),
  'rules.longWatch.limitMinutes': { schema: z.number().int().min(1).max(1440), default: 240 },
  'rules.newNetwork.enabled': flag(false),
  'rules.tvhDown.enabled': flag(true),
  'rules.muxStale.enabled': flag(true),

  'log.level': { schema: z.enum(['debug', 'info', 'warn', 'error']), default: 'info' },
} as const satisfies Record<string, SettingDef>;

export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = z.output<(typeof SETTINGS)[K]['schema']>;

export const isSettingKey = (key: string): key is SettingKey => Object.hasOwn(SETTINGS, key);
export const isSecret = (key: SettingKey): boolean => 'secret' in SETTINGS[key];
