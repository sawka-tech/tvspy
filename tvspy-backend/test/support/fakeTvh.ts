// A scriptable stand-in for TVHeadend's HTTP API: Basic or Digest auth (like the real server), the
// status and grid endpoints tvspy reads, and channel logos. Tests change `state` between polls.

import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeTvhState {
  auth: 'digest' | 'basic' | 'none';
  username: string;
  password: string;
  /** Without admin rights, status pages and grids answer 403 (like TVH). */
  admin: boolean;
  /** Drops every connection (TVH stopped or unreachable). */
  down: boolean;
  version: string;
  subscriptions: Record<string, unknown>[];
  inputs: Record<string, unknown>[];
  channels: Record<string, unknown>[];
  services: Record<string, unknown>[];
  muxes: Record<string, unknown>[];
  images: Record<string, { type: string; body: Buffer }>;
  /** Every request: path and the Authorization header it carried. */
  requests: { path: string; authorization: string | null }[];
}

export interface FakeTvh {
  url: string;
  state: FakeTvhState;
  close(): Promise<void>;
}

const md5 = (s: string) => createHash('md5').update(s).digest('hex');
const REALM = 'tvheadend';

export const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

export const TUNER_A = 'Silicon Labs Si2168 #0 : DVB-T #0';
export const TUNER_B = 'Silicon Labs Si2168 #1 : DVB-T #0';
export const CH_TVP1 = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';
export const CH_TVN = 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2';

export function subscription(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    start: 1_790_000_000,
    hostname: '77.65.111.65',
    username: 'kapi',
    client: 'SparkleTV/1.9.6 (AFTMM, Android 7.1.2)',
    title: 'HTTP',
    channel: 'TVP1',
    service: `${TUNER_A}/dvb-t/490MHz/TVP1`,
    profile: 'pass',
    state: 'Running',
    errors: 0,
    in: 600_000,
    out: 600_000,
    total_in: 0,
    total_out: 0,
    ...over,
  };
}

export function input(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uuid: randomBytes(16).toString('hex'),
    input: TUNER_A,
    stream: '490MHz in dvb-t',
    subs: 1,
    weight: 150,
    signal: -55_000,
    signal_scale: 2,
    snr: 34_500,
    snr_scale: 2,
    ber: 0,
    unc: 0,
    bps: 5_000_000,
    te: 0,
    cc: 0,
    ...over,
  };
}

export const idleInput = (tuner: string) => ({
  uuid: randomBytes(16).toString('hex'),
  input: tuner,
  stream: '',
  subs: 0,
  weight: 0,
  signal: 0,
  signal_scale: 0,
  snr: 0,
  snr_scale: 0,
  unc: 0,
  bps: 0,
  te: 0,
  cc: 0,
});

/** Two channels on two muxes, with logos (one PNG, one SVG that tvspy must refuse). */
export function catalogFixture(): Pick<FakeTvhState, 'channels' | 'services' | 'muxes' | 'images'> {
  return {
    channels: [
      {
        uuid: CH_TVP1,
        name: 'TVP1',
        number: 1,
        enabled: true,
        icon_public_url: 'imagecache/1',
        services: ['s1'],
      },
      {
        uuid: CH_TVN,
        name: 'TVN',
        number: 5,
        enabled: true,
        icon_public_url: 'imagecache/2',
        services: ['s2'],
      },
    ],
    services: [
      {
        uuid: 's1',
        multiplex: '490MHz',
        network: 'dvb-t',
        svcname: 'TVP1',
        enabled: true,
        last_seen: 1_790_000_000,
      },
      {
        uuid: 's2',
        multiplex: '530MHz',
        network: 'dvb-t',
        svcname: 'TVN',
        enabled: true,
        last_seen: 1_789_990_000,
      },
    ],
    muxes: [
      {
        uuid: 'm1',
        name: '490MHz',
        network: 'dvb-t',
        frequency: 490_000_000,
        delsys: 'DVB-T2',
        enabled: 1,
        scan_result: 1,
      },
      {
        uuid: 'm2',
        name: '530MHz',
        network: 'dvb-t',
        frequency: 530_000_000,
        delsys: 'DVB-T2',
        enabled: 1,
        scan_result: 1,
      },
      {
        uuid: 'm3',
        name: '666MHz',
        network: 'dvb-t',
        frequency: 666_000_000,
        delsys: 'DVB-T2',
        enabled: 0,
        scan_result: 2,
      },
    ],
    images: {
      '1': { type: 'image/png', body: PNG_1X1 },
      '2': {
        type: 'image/svg+xml',
        body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'),
      },
    },
  };
}

function params(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of header.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)) out[m[1] as string] = m[2] ?? m[3] ?? '';
  return out;
}

export async function startFakeTvh(init: Partial<FakeTvhState> = {}): Promise<FakeTvh> {
  const nonces = new Set<string>();
  const state: FakeTvhState = {
    auth: 'digest',
    username: 'spy',
    password: 'secret-pass',
    admin: true,
    down: false,
    version: '4.3-2345~gabcdef',
    subscriptions: [],
    inputs: [],
    channels: [],
    services: [],
    muxes: [],
    images: {},
    requests: [],
    ...init,
  };

  const authorized = (req: IncomingMessage): boolean => {
    if (state.auth === 'none') return true;
    const header = req.headers.authorization ?? '';
    if (state.auth === 'basic') {
      return header === `Basic ${Buffer.from(`${state.username}:${state.password}`).toString('base64')}`;
    }
    if (!header.startsWith('Digest ')) return false;
    const p = params(header.slice(7));
    if (p.username !== state.username || !p.nonce || !nonces.has(p.nonce) || p.uri !== req.url) return false;
    const ha1 = md5(`${state.username}:${REALM}:${state.password}`);
    const ha2 = md5(`${req.method}:${p.uri}`);
    const expected = p.qop
      ? md5(`${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`)
      : md5(`${ha1}:${p.nonce}:${ha2}`);
    return p.response === expected;
  };

  const challenge = (res: ServerResponse) => {
    if (state.auth === 'basic') {
      res.setHeader('WWW-Authenticate', `Basic realm="${REALM}"`);
    } else {
      const nonce = randomBytes(16).toString('hex');
      nonces.add(nonce);
      res.setHeader(
        'WWW-Authenticate',
        `Digest realm="${REALM}", qop="auth", nonce="${nonce}", opaque="${md5(REALM)}"`,
      );
    }
    res.writeHead(401).end();
  };

  const json = (res: ServerResponse, body: unknown) => {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  };

  const server = createServer((req, res) => {
    if (state.down) {
      req.socket.destroy();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://fake');
    state.requests.push({
      path: url.pathname + url.search,
      authorization: req.headers.authorization ?? null,
    });
    if (!authorized(req)) return challenge(res);

    const adminOnly = url.pathname.startsWith('/api/status/') || url.pathname.endsWith('/grid');
    if (adminOnly && !state.admin) return void res.writeHead(403).end();

    const grid = (entries: unknown[]) => {
      const limit = Number(url.searchParams.get('limit') ?? 50);
      json(res, { entries: entries.slice(0, limit), total: entries.length });
    };
    switch (url.pathname) {
      case '/api/serverinfo':
        return json(res, { sw_version: state.version, api_version: 19, name: 'Tvheadend' });
      case '/api/status/subscriptions':
        return json(res, { entries: state.subscriptions, totalCount: state.subscriptions.length });
      case '/api/status/inputs':
        return json(res, { entries: state.inputs, totalCount: state.inputs.length });
      case '/api/channel/grid':
        return grid(state.channels);
      case '/api/mpegts/service/grid':
        return grid(state.services);
      case '/api/mpegts/mux/grid':
        return grid(state.muxes);
    }
    const image = /^\/imagecache\/(\d+)$/.exec(url.pathname);
    const found = image ? state.images[image[1] as string] : undefined;
    if (found) return void res.writeHead(200, { 'Content-Type': found.type }).end(found.body);
    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
