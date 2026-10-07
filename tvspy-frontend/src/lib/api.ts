// Fetch wrapper for the tvspy API: same-origin cookie session, the CSRF header on every write, JSON in
// and out, and errors as ApiError with the server's code and per-field messages.

import type { ApiErrorBody, ErrorCode } from '@tvspy/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | 'NETWORK',
    message: string,
    readonly fields: Record<string, string> = {},
  ) {
    super(message);
  }
}

export async function api<T>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') {
    headers['X-Tvspy-Csrf'] = '1';
    headers['Content-Type'] = 'application/json';
  }
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(
      0,
      'NETWORK',
      'tvspy is not reachable. Check the connection or whether the container runs.',
    );
  }
  if (res.status === 204) return undefined as T;
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = (data as ApiErrorBody | null)?.error;
    throw new ApiError(
      res.status,
      err?.code ?? 'INTERNAL',
      err?.message ?? `Request failed (HTTP ${res.status})`,
      err?.fields,
    );
  }
  return data as T;
}

/** Builds a query string from defined, non-empty values. */
export function query(params: Record<string, string | number | boolean | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || v === false) continue;
    q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

export const isUnauthenticated = (err: unknown) => err instanceof ApiError && err.status === 401;
