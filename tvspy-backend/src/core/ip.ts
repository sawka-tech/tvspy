// IP parsing and CIDR matching (IPv4 and IPv6) used to tell how a client reached TVH.

export type Route = 'proxy' | 'lan' | 'direct' | 'none';

export const DEFAULT_LAN_CIDRS = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
];

/** The reverse proxy (Nginx Proxy Manager) talks to TVH from the default Docker bridge. */
export const DEFAULT_PROXY_CIDRS = ['172.17.0.0/16'];

interface ParsedIp {
  v: 4 | 6;
  n: bigint;
}

function parseV4(s: string): bigint | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  let n = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    n = (n << 8n) | BigInt(Number(p));
  }
  return n;
}

function parseV6(s: string): bigint | null {
  let text = s;
  let tail: bigint | null = null;
  const lastColon = text.lastIndexOf(':');
  if (text.includes('.') && lastColon >= 0) {
    tail = parseV4(text.slice(lastColon + 1));
    if (tail === null) return null;
    text = `${text.slice(0, lastColon)}:0:0`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    n = (n << 16n) | BigInt(Number.parseInt(g, 16));
  }
  if (tail !== null) n = (n & ~0xffffffffn) | tail;
  return n;
}

export function parseIp(raw: string | null | undefined): ParsedIp | null {
  const s = raw
    ?.trim()
    .replace(/^\[|\]$/g, '')
    .replace(/%.*$/, '');
  if (!s) return null;
  const v4 = parseV4(s);
  if (v4 !== null) return { v: 4, n: v4 };
  const v6 = parseV6(s);
  if (v6 === null) return null;
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) is treated as IPv4.
  if (v6 >> 32n === 0xffffn) return { v: 4, n: v6 & 0xffffffffn };
  return { v: 6, n: v6 };
}

export function isIp(raw: string | null | undefined): boolean {
  return parseIp(raw) !== null;
}

export function inCidr(ip: string, cidr: string): boolean {
  const [base, bitsText] = cidr.split('/');
  const a = parseIp(ip);
  const b = parseIp(base);
  if (!a || !b || a.v !== b.v) return false;
  const width = a.v === 4 ? 32 : 128;
  const bits = bitsText === undefined ? width : Number(bitsText);
  if (!Number.isInteger(bits) || bits < 0 || bits > width) return false;
  const shift = BigInt(width - bits);
  return a.n >> shift === b.n >> shift;
}

export function isValidCidr(cidr: string): boolean {
  const [base, bitsText] = cidr.split('/');
  const p = parseIp(base);
  if (!p) return false;
  if (bitsText === undefined) return true;
  const bits = Number(bitsText);
  return Number.isInteger(bits) && bits >= 0 && bits <= (p.v === 4 ? 32 : 128);
}

export function inAny(ip: string, cidrs: readonly string[]): boolean {
  return cidrs.some((c) => inCidr(ip, c));
}

/** Proxy is checked before LAN: the Docker bridge is a private range too. */
export function classifyRoute(
  ip: string | null | undefined,
  opts: { proxyCidrs?: readonly string[]; lanCidrs?: readonly string[] } = {},
): Route {
  if (!ip || !isIp(ip)) return 'none';
  if (inAny(ip, opts.proxyCidrs ?? DEFAULT_PROXY_CIDRS)) return 'proxy';
  if (inAny(ip, opts.lanCidrs ?? DEFAULT_LAN_CIDRS)) return 'lan';
  return 'direct';
}
