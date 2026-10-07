import { describe, expect, it } from 'vitest';
import { readEnv } from '../../src/env.js';
import { redact } from '../../src/log.js';

describe('log redaction', () => {
  it('removes Telegram tokens, URL credentials and secret fields', () => {
    expect(redact('POST https://api.telegram.org/bot123456:AAH-x_y/sendMessage failed')).toBe(
      'POST https://api.telegram.org/bot<redacted>/sendMessage failed',
    );
    expect(redact('GET http://spy:hunter2@192.168.1.10:9981/api')).toBe(
      'GET http://spy:<redacted>@192.168.1.10:9981/api',
    );
    expect(redact('{"password":"hunter2","user":"spy"}')).toBe('{"password":<redacted>,"user":"spy"}');
    expect(redact('setupCode=12345678')).toBe('setupCode=<redacted>');
  });
});

describe('environment', () => {
  it('uses safe defaults and ignores invalid values', () => {
    expect(readEnv({})).toMatchObject({
      dataDir: '/app/backend/src/database/file',
      port: 80,
      tz: 'Europe/Warsaw',
      journal: 'wal',
      telegramEnabled: true,
    });
    expect(
      readEnv({ TZ: 'Mars/Olympus', PORT: '99999', TVSPY_TELEGRAM: 'off', TVSPY_SQLITE_JOURNAL: 'delete' }),
    ).toMatchObject({
      tz: 'Europe/Warsaw',
      port: 80,
      telegramEnabled: false,
      journal: 'delete',
    });
  });
});
