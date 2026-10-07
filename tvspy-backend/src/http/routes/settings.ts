// Settings API: the stored keys are mapped to the contract's nested shape. Secrets are write-only.

import type { Settings, TestResult } from '@tvspy/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { messages } from '../../alerts/messages.js';
import { sendTelegram } from '../../alerts/telegram.js';
import { inAny } from '../../core/ip.js';
import type { SettingKey } from '../../settings/schema.js';
import { SettingsValidationError } from '../../settings/store.js';
import { fetchChannels, fetchInputs, fetchServerInfo } from '../../tvh/api.js';
import { TvhClient, TvhError } from '../../tvh/client.js';
import {
  ApiError,
  type AppDeps,
  type AppEnv,
  clientIp,
  displayIp,
  hostOf,
  isTrusted,
  readJson,
} from '../support.js';

/** API path → stored key. */
const KEYS = {
  'access.openNetworks': 'access.openNetworks',
  'access.hostnames': 'access.hostnames',
  'tvh.url': 'tvh.url',
  'tvh.username': 'tvh.username',
  'tvh.password': 'tvh.password',
  'telegram.enabled': 'telegram.enabled',
  'telegram.chatId': 'telegram.chatId',
  'telegram.botToken': 'telegram.botToken',
  'monitoring.tunersExpected': 'monitoring.tunersExpected',
  'monitoring.snrGoodDb': 'reception.snrGoodDb',
  'monitoring.snrCriticalDb': 'reception.snrCriticalDb',
  'monitoring.minSessionSec': 'stats.minSessionSec',
  'monitoring.proxyCidrs': 'network.proxyCidrs',
  'monitoring.lanCidrs': 'network.lanCidrs',
  'monitoring.trustedIps': 'network.trustedIps',
  'rules.playbackStart': 'rules.playbackStart.enabled',
  'rules.playbackStop': 'rules.playbackStop.enabled',
  'rules.recordingStart': 'rules.recordingStart.enabled',
  'rules.recordingStop': 'rules.recordingStop.enabled',
  'rules.longWatch.enabled': 'rules.longWatch.enabled',
  'rules.longWatch.limitMinutes': 'rules.longWatch.limitMinutes',
  'rules.tvhDown': 'rules.tvhDown.enabled',
  'rules.muxStale': 'rules.muxStale.enabled',
} as const satisfies Record<string, SettingKey>;

const API_PATH = Object.fromEntries(Object.entries(KEYS).map(([path, key]) => [key, path])) as Record<
  string,
  string
>;

// Shapes only; values are validated by the settings schema. Unknown fields are rejected.
const secret = z.string().max(500).nullable();
const patchSchema = z.strictObject({
  access: z
    .strictObject({ openNetworks: z.array(z.string()), hostnames: z.array(z.string()) })
    .partial()
    .optional(),
  tvh: z.strictObject({ url: z.string(), username: z.string(), password: secret }).partial().optional(),
  telegram: z
    .strictObject({ enabled: z.boolean(), chatId: z.string(), botToken: secret })
    .partial()
    .optional(),
  monitoring: z
    .strictObject({
      tunersExpected: z.number(),
      snrGoodDb: z.number(),
      snrCriticalDb: z.number(),
      minSessionSec: z.number(),
      proxyCidrs: z.array(z.string()),
      lanCidrs: z.array(z.string()),
      trustedIps: z.array(z.string()),
    })
    .partial()
    .optional(),
  rules: z
    .strictObject({
      playbackStart: z.boolean(),
      playbackStop: z.boolean(),
      recordingStart: z.boolean(),
      recordingStop: z.boolean(),
      longWatch: z.strictObject({ enabled: z.boolean(), limitMinutes: z.number() }).partial(),
      tvhDown: z.boolean(),
      muxStale: z.boolean(),
    })
    .partial()
    .optional(),
});

function flatten(obj: Record<string, unknown>, prefix = ''): [string, unknown][] {
  return Object.entries(obj).flatMap(([k, v]) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? flatten(v as Record<string, unknown>, `${prefix}${k}.`)
      : [[`${prefix}${k}`, v] as [string, unknown]],
  );
}

export function apiSettings(d: AppDeps): Settings {
  const s = d.settings;
  return {
    access: { openNetworks: [...s.get('access.openNetworks')], hostnames: [...s.get('access.hostnames')] },
    tvh: { url: s.get('tvh.url'), username: s.get('tvh.username'), passwordSet: s.isSet('tvh.password') },
    telegram: {
      enabled: s.get('telegram.enabled'),
      chatId: s.get('telegram.chatId'),
      botTokenSet: s.isSet('telegram.botToken'),
    },
    monitoring: {
      tunersExpected: s.get('monitoring.tunersExpected'),
      snrGoodDb: s.get('reception.snrGoodDb'),
      snrCriticalDb: s.get('reception.snrCriticalDb'),
      minSessionSec: s.get('stats.minSessionSec'),
      proxyCidrs: [...s.get('network.proxyCidrs')],
      lanCidrs: [...s.get('network.lanCidrs')],
      trustedIps: [...s.get('network.trustedIps')],
    },
    rules: {
      playbackStart: s.get('rules.playbackStart.enabled'),
      playbackStop: s.get('rules.playbackStop.enabled'),
      recordingStart: s.get('rules.recordingStart.enabled'),
      recordingStop: s.get('rules.recordingStop.enabled'),
      longWatch: {
        enabled: s.get('rules.longWatch.enabled'),
        limitMinutes: s.get('rules.longWatch.limitMinutes'),
      },
      tvhDown: s.get('rules.tvhDown.enabled'),
      muxStale: s.get('rules.muxStale.enabled'),
    },
  };
}

const sameOrigin = (a: string, b: string) => {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
};

export function settingsRoutes(d: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/', (c) => c.json(apiSettings(d)));

  app.patch('/', async (c) => {
    const patch = await readJson(c, patchSchema);
    const changes: Partial<Record<SettingKey, unknown>> = {};
    for (const [path, value] of flatten(patch)) {
      const key = KEYS[path as keyof typeof KEYS];
      if (key) changes[key] = value;
    }
    const good = (changes['reception.snrGoodDb'] ?? d.settings.get('reception.snrGoodDb')) as number;
    const critical = (changes['reception.snrCriticalDb'] ??
      d.settings.get('reception.snrCriticalDb')) as number;
    if (typeof good === 'number' && typeof critical === 'number' && critical >= good) {
      throw new ApiError(400, 'VALIDATION', 'Invalid settings', {
        'monitoring.snrCriticalDb': 'Must be lower than the "good" threshold',
      });
    }
    // Changing who may skip the login must not shut out the browser making the change.
    if (c.get('trusted') && (changes['access.openNetworks'] || changes['access.hostnames'])) {
      const ip = clientIp(c);
      const nets = (changes['access.openNetworks'] ?? d.settings.get('access.openNetworks')) as string[];
      const names = (changes['access.hostnames'] ?? d.settings.get('access.hostnames')) as string[];
      const valid = (list: unknown) =>
        Array.isArray(list) && list.every((v) => typeof v === 'string' && v.length > 0);
      if (
        valid(nets) &&
        valid(names) &&
        !isTrusted(
          ip,
          c.req.header('host'),
          nets.map((n) => n.trim()),
          names.map((n) => n.trim().toLowerCase()),
        )
      ) {
        const field = inAny(
          ip,
          nets.map((n) => n.trim()),
        )
          ? 'access.hostnames'
          : 'access.openNetworks';
        throw new ApiError(400, 'VALIDATION', 'Invalid settings', {
          [field]:
            field === 'access.openNetworks'
              ? `This would lock you out: your address ${displayIp(ip)} is not in the list`
              : `This would lock you out: you opened tvspy as "${hostOf(c.req.header('host'))}", which is not in the list`,
        });
      }
    }
    try {
      const changed = d.settings.update(changes, d.now());
      if (changed.length) d.log.info(`Settings changed: ${changed.join(', ')}`);
    } catch (err) {
      if (!(err instanceof SettingsValidationError)) throw err;
      const fields = Object.fromEntries(Object.entries(err.fields).map(([k, v]) => [API_PATH[k] ?? k, v]));
      throw new ApiError(400, 'VALIDATION', 'Invalid settings', fields);
    }
    return c.json(apiSettings(d));
  });

  app.post('/tvh/test', async (c) => {
    const body = await readJson(
      c,
      z.strictObject({
        url: z.string().max(500).optional(),
        username: z.string().max(200).optional(),
        password: z.string().max(500).optional(),
      }),
    );
    const url = (body.url ?? d.settings.get('tvh.url')).trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/i.test(url)) {
      throw new ApiError(400, 'VALIDATION', 'Invalid request', { url: 'Use http(s)://host:port' });
    }
    // The stored password only ever goes to the stored server.
    const password =
      body.password ?? (sameOrigin(url, d.settings.get('tvh.url')) ? d.settings.get('tvh.password') : '');
    const client = new TvhClient(() => ({
      url,
      username: body.username ?? d.settings.get('tvh.username'),
      password,
      auth: d.settings.get('tvh.auth'),
    }));
    let result: TestResult;
    try {
      const info = await fetchServerInfo(client);
      let admin = true;
      let tuners = 0;
      try {
        tuners = new Set((await fetchInputs(client)).map((i) => i.tuner)).size;
      } catch (err) {
        if (!(err instanceof TvhError && err.kind === 'forbidden')) throw err;
        admin = false;
      }
      const channels = admin ? (await fetchChannels(client)).length : 0;
      result = admin
        ? {
            ok: true,
            detail: `TVHeadend ${info.version ?? '(unknown version)'}: ${tuners} tuner${tuners === 1 ? '' : 's'}, ${channels} channels`,
            tvh: { version: info.version, tuners, channels, admin },
          }
        : {
            ok: false,
            message: 'The login works, but the account needs admin rights to read tuner and stream status',
          };
    } catch (err) {
      result = { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
    return c.json(result);
  });

  app.post('/telegram/test', async (c) => {
    const body = await readJson(
      c,
      z.strictObject({
        botToken: z.string().trim().max(200).optional(),
        chatId: z.string().trim().max(100).optional(),
      }),
    );
    if (!d.telegramAllowed) {
      return c.json({
        ok: false,
        message: 'Telegram is switched off for this container (TVSPY_TELEGRAM=off)',
      } satisfies TestResult);
    }
    const token = body.botToken || d.settings.get('telegram.botToken');
    const chatId = body.chatId || d.settings.get('telegram.chatId');
    if (!token || !chatId) {
      return c.json({ ok: false, message: 'Enter the bot token and the chat ID first' } satisfies TestResult);
    }
    const sent = await sendTelegram(token, chatId, messages.test(), d.telegramFetch, d.telegramApi);
    const result: TestResult = sent.ok
      ? { ok: true, detail: 'Test message sent' }
      : { ok: false, message: sent.message };
    return c.json(result);
  });

  return app;
}
