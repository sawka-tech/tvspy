// Channel logos, fetched through TVHeadend (with tvspy's login) and cached on disk for a week. Only
// known channels and only raster images: an SVG served from our origin could run script.

import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TvhClient } from '../tvh/client.js';
import type { Catalog } from './catalog.js';

const TTL_SEC = 7 * 86400;
/** After a failed fetch, wait this long before asking TVH again. */
const RETRY_SEC = 3600;
const MAX_BYTES = 512 * 1024;
const UUID = /^[0-9a-f]{32}$/;

export interface Logo {
  type: string;
  body: Buffer;
}

export function sniffImage(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a)
    return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  const head = buf.toString('latin1', 0, 12);
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'image/gif';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** TVH path for a channel icon: relative paths (imagecache/…) or absolute URLs on the TVH server itself. */
export function iconPath(icon: string, tvhUrl: string): string | null {
  if (!/^[a-z][a-z0-9+.-]*:/i.test(icon)) return icon.startsWith('/') ? icon : `/${icon}`;
  try {
    const url = new URL(icon);
    const tvh = new URL(tvhUrl);
    if (url.origin !== tvh.origin) return null;
    return url.pathname + url.search;
  } catch {
    return null;
  }
}

export class LogoCache {
  private inflight = new Map<string, Promise<Logo | null>>();
  private failedUntil = new Map<string, number>();

  constructor(
    private readonly dir: string,
    private readonly client: TvhClient,
    private readonly catalog: Catalog,
    private readonly tvhUrl: () => string,
  ) {}

  async get(uuid: string, now: number): Promise<Logo | null> {
    if (!UUID.test(uuid)) return null;
    const channel = this.catalog.channel(uuid);
    if (!channel?.icon) return null;
    const file = join(this.dir, uuid);
    const cached = await this.read(file);
    if (cached && now - cached.mtime < TTL_SEC) return cached.logo;
    if ((this.failedUntil.get(uuid) ?? 0) > now) return cached?.logo ?? null;

    let pending = this.inflight.get(uuid);
    if (!pending) {
      pending = this.fetch(channel.icon, file).finally(() => this.inflight.delete(uuid));
      this.inflight.set(uuid, pending);
    }
    const fresh = await pending;
    if (!fresh) this.failedUntil.set(uuid, now + RETRY_SEC);
    else this.failedUntil.delete(uuid);
    // A stale logo beats none when TVH is unreachable.
    return fresh ?? cached?.logo ?? null;
  }

  private async read(file: string): Promise<{ logo: Logo; mtime: number } | null> {
    try {
      const [body, info] = await Promise.all([readFile(file), stat(file)]);
      const type = sniffImage(body);
      return type ? { logo: { type, body }, mtime: info.mtimeMs / 1000 } : null;
    } catch {
      return null;
    }
  }

  private async fetch(icon: string, file: string): Promise<Logo | null> {
    const path = iconPath(icon, this.tvhUrl());
    if (!path) return null;
    try {
      const res = await this.client.request(path, 8000);
      if (Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) {
        await res.body?.cancel();
        return null;
      }
      const body = Buffer.from(await res.arrayBuffer());
      const type = body.length <= MAX_BYTES ? sniffImage(body) : null;
      if (!type) return null;
      await mkdir(this.dir, { recursive: true });
      await writeFile(`${file}.tmp`, body);
      await rename(`${file}.tmp`, file);
      return { type, body };
    } catch {
      return null;
    }
  }
}
