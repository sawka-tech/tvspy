// HTTP client for the TVHeadend API. Learns the server's auth scheme (Basic or Digest) from its first
// 401 challenge and keeps using it; Digest nonces are reused with an increasing nonce count.

import { createHash, randomBytes } from 'node:crypto';

export type TvhAuthMode = 'auto' | 'basic' | 'digest';

export interface TvhConfig {
  url: string;
  username: string;
  password: string;
  auth: TvhAuthMode;
}

export type TvhErrorKind =
  | 'not_configured'
  | 'network'
  | 'timeout'
  | 'auth'
  | 'forbidden'
  | 'http'
  | 'bad_response';

export class TvhError extends Error {
  constructor(
    readonly kind: TvhErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

interface Challenge {
  scheme: string;
  params: Record<string, string>;
}

interface DigestState {
  realm: string;
  nonce: string;
  opaque: string | null;
  qop: 'auth' | null;
  nc: number;
}

const md5 = (s: string) => createHash('md5').update(s).digest('hex');

/** Parses the first challenge of a WWW-Authenticate header. */
export function parseChallenge(header: string | null): Challenge | null {
  if (!header) return null;
  const [scheme, ...rest] = header.trim().split(/\s+/);
  if (!scheme) return null;
  const params: Record<string, string> = {};
  const re = /(\w+)=(?:"([^"]*)"|([^,\s]*))/g;
  for (let m = re.exec(rest.join(' ')); m !== null; m = re.exec(rest.join(' '))) {
    params[(m[1] as string).toLowerCase()] = m[2] ?? m[3] ?? '';
  }
  return { scheme: scheme.toLowerCase(), params };
}

export class TvhClient {
  private scheme: 'basic' | 'digest' | null = null;
  private digest: DigestState | null = null;
  private configKey = '';

  constructor(private readonly config: () => TvhConfig) {}

  async json<T = unknown>(path: string, timeoutMs = 4000): Promise<T> {
    const res = await this.request(path, timeoutMs);
    try {
      return (await res.json()) as T;
    } catch {
      throw new TvhError('bad_response', 'TVHeadend returned something that is not JSON');
    }
  }

  async request(path: string, timeoutMs = 4000): Promise<Response> {
    const c = this.currentConfig();
    if (!c.url) throw new TvhError('not_configured', 'TVHeadend is not configured yet');
    const url = new URL(path.replace(/^\/+/, ''), `${c.url.replace(/\/+$/, '')}/`);
    const uri = url.pathname + url.search;

    let res = await this.fetchOnce(url, this.authorization(c, uri), timeoutMs);
    if (res.status === 401 && c.username) {
      await res.body?.cancel();
      this.learn(c, parseChallenge(res.headers.get('www-authenticate')));
      res = await this.fetchOnce(url, this.authorization(c, uri), timeoutMs);
    }
    if (res.status === 401) {
      await res.body?.cancel();
      this.scheme = null;
      this.digest = null;
      throw new TvhError('auth', 'TVHeadend rejected the login (HTTP 401): check username and password', 401);
    }
    if (res.status === 403) {
      await res.body?.cancel();
      throw new TvhError(
        'forbidden',
        'TVHeadend denied access (HTTP 403): the account needs admin rights',
        403,
      );
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new TvhError('http', `TVHeadend answered HTTP ${res.status}`, res.status);
    }
    return res;
  }

  private currentConfig(): TvhConfig {
    const c = this.config();
    const key = JSON.stringify([c.url, c.username, c.password, c.auth]);
    if (key !== this.configKey) {
      this.configKey = key;
      this.scheme = c.auth === 'basic' ? 'basic' : null;
      this.digest = null;
    }
    return c;
  }

  private learn(c: TvhConfig, challenge: Challenge | null): void {
    if (c.auth !== 'basic' && challenge?.scheme === 'digest' && challenge.params.nonce) {
      const qop = (challenge.params.qop ?? '')
        .split(',')
        .map((q) => q.trim())
        .includes('auth')
        ? 'auth'
        : null;
      this.scheme = 'digest';
      this.digest = {
        realm: challenge.params.realm ?? '',
        nonce: challenge.params.nonce,
        opaque: challenge.params.opaque ?? null,
        qop,
        nc: 0,
      };
    } else if (c.auth !== 'digest') {
      this.scheme = 'basic';
    }
  }

  private authorization(c: TvhConfig, uri: string): string | null {
    if (!c.username) return null;
    if (this.scheme === 'basic') {
      return `Basic ${Buffer.from(`${c.username}:${c.password}`).toString('base64')}`;
    }
    if (this.scheme === 'digest' && this.digest) {
      const d = this.digest;
      d.nc++;
      const nc = d.nc.toString(16).padStart(8, '0');
      const cnonce = randomBytes(8).toString('hex');
      const ha1 = md5(`${c.username}:${d.realm}:${c.password}`);
      const ha2 = md5(`GET:${uri}`);
      const response = d.qop
        ? md5(`${ha1}:${d.nonce}:${nc}:${cnonce}:${d.qop}:${ha2}`)
        : md5(`${ha1}:${d.nonce}:${ha2}`);
      let header = `Digest username="${c.username}", realm="${d.realm}", nonce="${d.nonce}", uri="${uri}", algorithm=MD5, response="${response}"`;
      if (d.qop) header += `, qop=${d.qop}, nc=${nc}, cnonce="${cnonce}"`;
      if (d.opaque !== null) header += `, opaque="${d.opaque}"`;
      return header;
    }
    return null;
  }

  private async fetchOnce(url: URL, authorization: string | null, timeoutMs: number): Promise<Response> {
    try {
      return await fetch(url, {
        headers: authorization ? { Authorization: authorization } : {},
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new TvhError('timeout', `TVHeadend did not answer within ${Math.round(timeoutMs / 1000)} s`);
      }
      const cause = (err as { cause?: { code?: string } }).cause;
      throw new TvhError('network', `Cannot reach TVHeadend (${cause?.code ?? (err as Error).message})`);
    }
  }
}
