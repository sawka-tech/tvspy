// The optional password for opening tvspy from networks that are not trusted (Settings → Access), and the
// browser sessions it creates. The cookie carries a random token; the database stores only its SHA-256, so
// a copy of the database (or a backup) cannot be used to log in.

import { createHash, randomBytes } from 'node:crypto';
import type { DB } from '../db/open.js';
import { DEFAULT_SCRYPT_COST, hashPassword, verifyPassword } from './password.js';

export const SESSION_COOKIE = 'tvspy_session';
export const SESSION_DAYS = 30;
/** Sliding expiry is renewed at most this often, to avoid a write on every request. */
const RENEW_AFTER_SEC = 300;

export const USERNAME_MAX = 64;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;

export class AuthError extends Error {
  constructor(
    readonly reason: 'bad_credentials' | 'weak_password',
    message: string,
  ) {
    super(message);
  }
}

export interface ClientMeta {
  ip: string | null;
  userAgent: string | null;
}

interface AdminRow {
  username: string;
  password_hash: string;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function checkPasswordPolicy(password: string): string | null {
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters`;
  if (password.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters`;
  return null;
}

export class AuthService {
  /** Hash used for logins with an unknown user name, so they take as long as real ones. */
  private dummyHash: Promise<string> | null = null;

  constructor(
    private readonly db: DB,
    private readonly opts: { scryptCost?: number; now?: () => number } = {},
  ) {}

  private now(): number {
    return this.opts.now ? this.opts.now() : Math.floor(Date.now() / 1000);
  }

  private admin(): AdminRow | undefined {
    return this.db.prepare('SELECT username, password_hash FROM admin_user WHERE id = 1').get() as
      | AdminRow
      | undefined;
  }

  /** Whether a password is set, i.e. logging in from other networks is possible. */
  hasAdmin(): boolean {
    return this.admin() !== undefined;
  }

  adminName(): string | null {
    return this.admin()?.username ?? null;
  }

  async login(username: string, password: string, meta: ClientMeta): Promise<string> {
    const admin = this.admin();
    if (!admin) throw new AuthError('bad_credentials', 'Wrong user name or password');
    const nameOk = admin.username.toLowerCase() === username.trim().toLowerCase();
    if (!nameOk) {
      this.dummyHash ??= hashPassword('not the password', this.opts.scryptCost ?? DEFAULT_SCRYPT_COST);
      await verifyPassword(password, await this.dummyHash);
      throw new AuthError('bad_credentials', 'Wrong user name or password');
    }
    if (!(await verifyPassword(password, admin.password_hash))) {
      throw new AuthError('bad_credentials', 'Wrong user name or password');
    }
    return this.createSession(meta);
  }

  private createSession(meta: ClientMeta): string {
    const token = randomBytes(32).toString('base64url');
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO auth_sessions (token_hash, created_at, last_seen_at, expires_at, ip, user_agent)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sha256(token),
        now,
        now,
        now + SESSION_DAYS * 86400,
        meta.ip,
        meta.userAgent?.slice(0, 300) ?? null,
      );
    return token;
  }

  /** Validates a cookie token and renews its expiry. Returns the admin's user name, or null. */
  session(token: string | undefined): { username: string; renewed: boolean } | null {
    if (!token || token.length > 100) return null;
    const hash = sha256(token);
    const row = this.db
      .prepare('SELECT last_seen_at, expires_at FROM auth_sessions WHERE token_hash = ?')
      .get(hash) as { last_seen_at: number; expires_at: number } | undefined;
    const now = this.now();
    if (!row) return null;
    if (row.expires_at <= now) {
      this.db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(hash);
      return null;
    }
    const admin = this.admin();
    if (!admin) return null;
    let renewed = false;
    if (now - row.last_seen_at >= RENEW_AFTER_SEC) {
      this.db
        .prepare('UPDATE auth_sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?')
        .run(now, now + SESSION_DAYS * 86400, hash);
      renewed = true;
    }
    return { username: admin.username, renewed };
  }

  logout(token: string | undefined): void {
    if (token) this.db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(sha256(token));
  }

  /** Changes the password and ends every other browser session. */
  async changePassword(token: string, current: string, next: string): Promise<void> {
    const admin = this.admin();
    if (!admin || !(await verifyPassword(current, admin.password_hash))) {
      throw new AuthError('bad_credentials', 'The current password is wrong');
    }
    const policy = checkPasswordPolicy(next);
    if (policy) throw new AuthError('weak_password', policy);
    const hash = await hashPassword(next, this.opts.scryptCost ?? DEFAULT_SCRYPT_COST);
    this.db.transaction(() => {
      this.db
        .prepare('UPDATE admin_user SET password_hash = ?, password_changed_at = ? WHERE id = 1')
        .run(hash, this.now());
      this.db.prepare('DELETE FROM auth_sessions WHERE token_hash != ?').run(sha256(token));
    })();
  }

  /** Sets or replaces the password (from a trusted network or the command line); ends all sessions. */
  async setPassword(username: string, password: string): Promise<void> {
    const policy = checkPasswordPolicy(password);
    if (policy) throw new AuthError('weak_password', policy);
    const hash = await hashPassword(password, this.opts.scryptCost ?? DEFAULT_SCRYPT_COST);
    const now = this.now();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO admin_user (id, username, password_hash, created_at, password_changed_at)
           VALUES (1, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET username = excluded.username, password_hash = excluded.password_hash,
             password_changed_at = excluded.password_changed_at`,
        )
        .run(username.trim(), hash, now, now);
      this.db.prepare('DELETE FROM auth_sessions').run();
    })();
  }

  /** Removes the password: tvspy then only opens from trusted networks. */
  removeAdmin(): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM admin_user').run();
      this.db.prepare('DELETE FROM auth_sessions').run();
    })();
  }

  pruneExpired(): number {
    return this.db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(this.now()).changes;
  }
}

/**
 * Failed logins per client address and overall within a sliding window. Successful logins clear the
 * address's failures. In memory only: a restart forgets them, which is fine for a LAN dashboard.
 */
export class LoginLimiter {
  private byIp = new Map<string, number[]>();
  private all: number[] = [];

  constructor(
    private readonly perIp = 5,
    private readonly overall = 30,
    private readonly windowSec = 900,
  ) {}

  private prune(list: number[], now: number): number[] {
    return list.filter((t) => t > now - this.windowSec);
  }

  /** Seconds until the next attempt is allowed, or 0. */
  retryAfter(ip: string, now: number): number {
    const mine = this.prune(this.byIp.get(ip) ?? [], now);
    this.all = this.prune(this.all, now);
    const wait = (list: number[], limit: number) =>
      list.length >= limit ? (list[list.length - limit] as number) + this.windowSec - now : 0;
    return Math.max(wait(mine, this.perIp), wait(this.all, this.overall), 0);
  }

  fail(ip: string, now: number): void {
    const mine = this.prune(this.byIp.get(ip) ?? [], now);
    mine.push(now);
    this.byIp.set(ip, mine);
    this.all.push(now);
    if (this.byIp.size > 10_000) this.byIp.clear();
  }

  succeed(ip: string): void {
    this.byIp.delete(ip);
  }
}
