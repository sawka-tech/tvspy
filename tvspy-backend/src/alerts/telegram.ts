// Telegram Bot API client. The token is part of the URL path, so errors never include the URL.

import { networkReason } from '../tvh/client.js';

export type SendResult =
  | { ok: true }
  | { ok: false; message: string; permanent: boolean; retryAfterSec: number | null };

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const TELEGRAM_API = 'https://api.telegram.org';

export async function sendTelegram(
  botToken: string,
  chatId: string,
  text: string,
  fetchImpl: FetchLike = fetch,
  base = TELEGRAM_API,
): Promise<SendResult> {
  if (!/^\d+:[\w-]+$/.test(botToken)) {
    return { ok: false, message: 'The bot token has the wrong format', permanent: true, retryAfterSec: null };
  }
  let res: Response;
  try {
    res = await fetchImpl(`${base}/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    const timeout = err instanceof DOMException && err.name === 'TimeoutError';
    return {
      ok: false,
      message: timeout
        ? 'Telegram did not answer within 10 s'
        : `Cannot reach Telegram (${networkReason(err)})`,
      permanent: false,
      retryAfterSec: null,
    };
  }
  let body: { ok?: boolean; description?: string; parameters?: { retry_after?: number } } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    // Not JSON: judged by the status alone.
  }
  if (res.ok && body.ok !== false) return { ok: true };
  const description = (body.description ?? `HTTP ${res.status}`).slice(0, 200);
  if (res.status === 429) {
    return {
      ok: false,
      message: description,
      permanent: false,
      retryAfterSec: body.parameters?.retry_after ?? 30,
    };
  }
  // Wrong token (401/404) or chat (400/403) will not fix itself.
  const permanent = res.status >= 400 && res.status < 500;
  return { ok: false, message: `Telegram: ${description}`, permanent, retryAfterSec: null };
}
