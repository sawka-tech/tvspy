import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/auth/password.js';
import { AuthError, AuthService, LoginLimiter, SESSION_DAYS } from '../../src/auth/service.js';
import { migrate } from '../../src/db/migrate.js';
import { type DB, openDb } from '../../src/db/open.js';

const COST = 1024; // fast for tests; production uses 2^15
const meta = { ip: '192.168.1.20', userAgent: 'test' };

describe('password hashing', () => {
  it('verifies the right password only', async () => {
    const hash = await hashPassword('correct horse', COST);
    expect(hash).toMatch(/^scrypt\$1024\$8\$1\$/);
    expect(await verifyPassword('correct horse', hash)).toBe(true);
    expect(await verifyPassword('correct hors', hash)).toBe(false);
    expect(await hashPassword('correct horse', COST)).not.toBe(hash); // salted
  });

  it('rejects malformed or absurd hashes without throwing', async () => {
    for (const bad of [
      '',
      'plain',
      'scrypt$1$8$1$AA$AA',
      'scrypt$99999999$8$1$AAAA$AAAAAAAAAAAAAAAAAAAAAAAA',
    ]) {
      expect(await verifyPassword('x', bad)).toBe(false);
    }
  });
});

describe('password for other networks and sessions', () => {
  let db: DB;
  let now: number;
  let auth: AuthService;
  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    now = 1_790_000_000;
    auth = new AuthService(db, { scryptCost: COST, now: () => now });
  });

  const setup = async () => {
    await auth.setPassword('Kacper', 'long enough pw');
    return auth.login('kacper', 'long enough pw', meta);
  };

  it('has no password until one is set, and can remove it again', async () => {
    expect(auth.hasAdmin()).toBe(false);
    await expect(auth.login('admin', 'anything at all', meta)).rejects.toMatchObject({
      reason: 'bad_credentials',
    });
    await expect(auth.setPassword('kacper', 'short')).rejects.toMatchObject({ reason: 'weak_password' });
    const token = await setup();
    expect([auth.hasAdmin(), auth.adminName()]).toEqual([true, 'Kacper']);
    expect(auth.session(token)?.username).toBe('Kacper');
    auth.removeAdmin();
    expect(auth.hasAdmin()).toBe(false);
    expect(auth.session(token)).toBeNull();
  });

  it('stores only a hash of the session token', async () => {
    const token = await setup();
    const rows = db.prepare('SELECT * FROM auth_sessions').all() as { token_hash: string }[];
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(rows[0]?.token_hash).toBe(createHash('sha256').update(token).digest('hex'));
  });

  it('logs in case-insensitively by name and rejects wrong passwords', async () => {
    await setup();
    expect(auth.session(await auth.login('KACPER', 'long enough pw', meta))?.username).toBe('Kacper');
    await expect(auth.login('kacper', 'wrong password', meta)).rejects.toBeInstanceOf(AuthError);
    await expect(auth.login('someone', 'long enough pw', meta)).rejects.toMatchObject({
      reason: 'bad_credentials',
    });
  });

  it('expires sessions after 30 days without use and slides on use', async () => {
    const token = await setup();
    now += SESSION_DAYS * 86400 - 10;
    expect(auth.session(token)?.renewed).toBe(true); // used just in time: renewed
    now += SESSION_DAYS * 86400 - 10;
    expect(auth.session(token)).not.toBeNull();
    now += SESSION_DAYS * 86400 + 1;
    expect(auth.session(token)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get()).toEqual({ n: 0 });
    expect(auth.session('nonsense')).toBeNull();
    expect(auth.session(undefined)).toBeNull();
  });

  it('logs out, and a password change ends every other session', async () => {
    const first = await setup();
    const second = await auth.login('kacper', 'long enough pw', meta);
    const third = await auth.login('kacper', 'long enough pw', meta);
    auth.logout(third);
    expect(auth.session(third)).toBeNull();
    await expect(auth.changePassword(first, 'wrong', 'another long pw')).rejects.toMatchObject({
      reason: 'bad_credentials',
    });
    await auth.changePassword(first, 'long enough pw', 'another long pw');
    expect(auth.session(first)).not.toBeNull();
    expect(auth.session(second)).toBeNull();
    await expect(auth.login('kacper', 'long enough pw', meta)).rejects.toBeInstanceOf(AuthError);
    await auth.login('kacper', 'another long pw', meta);
  });

  it('replaces the password (from home or the command line) and logs everyone out', async () => {
    const token = await setup();
    await auth.setPassword('admin', 'recovered password');
    expect(auth.session(token)).toBeNull();
    await auth.login('admin', 'recovered password', meta);
  });
});

describe('login limiter', () => {
  it('blocks an address after 5 failures for the rest of the window', () => {
    const l = new LoginLimiter(5, 30, 900);
    for (let i = 0; i < 5; i++) {
      expect(l.retryAfter('a', 1000 + i)).toBe(0);
      l.fail('a', 1000 + i);
    }
    expect(l.retryAfter('a', 1010)).toBe(890);
    expect(l.retryAfter('b', 1010)).toBe(0);
    expect(l.retryAfter('a', 1900)).toBe(0); // oldest failure left the window
    l.succeed('a');
    expect(l.retryAfter('a', 1010)).toBe(0);
  });

  it('blocks everyone after too many failures overall', () => {
    const l = new LoginLimiter(5, 10, 900);
    for (let i = 0; i < 10; i++) l.fail(`ip${i}`, 1000);
    expect(l.retryAfter('fresh', 1001)).toBe(899);
  });
});
