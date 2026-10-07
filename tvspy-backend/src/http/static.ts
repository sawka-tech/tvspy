// Serves the built frontend. Hashed files under /assets are cached for a year; everything else,
// including the index.html fallback for client-side routes, is revalidated on every load.

import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from './support.js';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export function serveFrontend(dir: string): MiddlewareHandler<AppEnv> {
  const root = resolve(dir);
  const index = join(root, 'index.html');

  const send = async (file: string, cache: string) => {
    const body = await readFile(file);
    return new Response(new Uint8Array(body), {
      headers: {
        'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
        'Cache-Control': cache,
      },
    });
  };

  return async (c, next) => {
    const method = c.req.method;
    const path = c.req.path;
    if ((method !== 'GET' && method !== 'HEAD') || path === '/api' || path.startsWith('/api/')) return next();

    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      return c.text('Bad request', 400);
    }
    const file = resolve(root, `.${decoded}`);
    if (file !== root && !file.startsWith(root + sep)) return c.text('Not found', 404);

    const info = await stat(file).catch(() => null);
    if (info?.isFile()) {
      const immutable = decoded.startsWith('/assets/');
      return send(file, immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
    }
    // Client-side routes get the app; missing files with an extension are real 404s.
    if (extname(decoded) !== '') return c.text('Not found', 404);
    const app = await stat(index).catch(() => null);
    if (!app) return c.text('The frontend is not built', 404);
    return send(index, 'no-cache');
  };
}
