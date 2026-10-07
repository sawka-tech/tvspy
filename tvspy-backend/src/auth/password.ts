// Password hashing with scrypt. The stored string carries its parameters, so the cost can change later
// without invalidating existing hashes: scrypt$N$r$p$salt$key (base64).

import { randomBytes, type ScryptOptions, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';

export const DEFAULT_SCRYPT_COST = 2 ** 15;
const R = 8;
const P = 1;
const KEY_LEN = 32;

const scrypt = (password: string, salt: Buffer, keyLen: number, opts: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) =>
    scryptCb(password, salt, keyLen, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );

const maxmem = (n: number, r: number) => 256 * n * r + 1024 * 1024;

export async function hashPassword(password: string, cost = DEFAULT_SCRYPT_COST): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, KEY_LEN, {
    N: cost,
    r: R,
    p: P,
    maxmem: maxmem(cost, R),
  });
  return `scrypt$${cost}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = parts.slice(1, 4).map(Number) as [number, number, number];
  if (![n, r, p].every((v) => Number.isInteger(v) && v > 0) || n > 2 ** 20 || r > 32 || p > 16) return false;
  const salt = Buffer.from(parts[4] as string, 'base64');
  const expected = Buffer.from(parts[5] as string, 'base64');
  if (expected.length < 16) return false;
  const key = await scrypt(password.normalize('NFKC'), salt, expected.length, {
    N: n,
    r,
    p,
    maxmem: maxmem(n, r),
  });
  return timingSafeEqual(key, expected);
}
