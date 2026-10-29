import { env } from '../env.js';

/**
 * Send to the admin/operator channel (cron failures, deploy alerts,
 * infrastructure noise). Uses a dedicated bot when TELEGRAM_ADMIN_BOT_TOKEN
 * is set so user-facing SigmaSeller messages and admin-only paging don't
 * compete in the same chat. Falls back to the user bot when no admin token
 * is configured — single-bot deploys keep working unchanged.
 */
export async function sendTelegramModeration(payload: {
  text: string;
  buttons?: Array<Array<{ text: string; callback_data?: string; url?: string }>>;
}): Promise<void> {
  const token = env.TELEGRAM_ADMIN_BOT_TOKEN ?? env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_MODERATION_CHAT_ID;

  if (!token || !chatId) return;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = {
    chat_id: chatId,
    text: payload.text,
    parse_mode: 'HTML',
    reply_markup: payload.buttons ? { inline_keyboard: payload.buttons } : undefined,
  } as any;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Telegram sendMessage failed: ${res.status} ${text.slice(0, 200)}`);
  }
}

export async function createTelegramInvoiceLink(payload: {
  title: string;
  description: string;
  payload: string;
  currency: string;
  prices: Array<{ label: string; amount: number }>;
  providerToken?: string;
  providerData?: string;
}) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const providerToken = payload.providerToken ?? env.TELEGRAM_PAYMENT_PROVIDER_TOKEN;

  if (!token || !providerToken) {
    throw new Error('Telegram payment bot token or provider token is missing');
  }

  const url = `https://api.telegram.org/bot${token}/createInvoiceLink`;
  const body: any = {
    title: payload.title,
    description: payload.description,
    payload: payload.payload,
    provider_token: providerToken,
    currency: payload.currency,
    prices: payload.prices,
    provider_data: payload.providerData,
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Telegram createInvoiceLink failed: ${res.status} ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as any;
  if (!data?.ok || !data?.result) {
    throw new Error(`Telegram createInvoiceLink failed: ${JSON.stringify(data)?.slice(0, 200)}`);
  }

  return data.result as string;
}

export async function answerTelegramPreCheckout(payload: { queryId: string; ok: boolean; errorMessage?: string }) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error('Telegram bot token is missing');
  }

  const url = `https://api.telegram.org/bot${token}/answerPreCheckoutQuery`;
  const body: any = {
    pre_checkout_query_id: payload.queryId,
    ok: payload.ok,
  };

  if (payload.errorMessage && !payload.ok) {
    body.error_message = payload.errorMessage;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Telegram answerPreCheckoutQuery failed: ${res.status} ${text.slice(0, 200)}`);
  }
}

export function verifyTelegramWebhookSecret(headers: Record<string, string | string[] | undefined>): boolean {
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) return false;

  const header = headers['x-telegram-bot-api-secret-token'];
  if (typeof header === 'string') return header === secret;
  if (Array.isArray(header)) return header.includes(secret);
  return false;
}

/**
 * Send a message to a specific chat
 */
export async function sendTelegramMessage(
  chatId: string,
  text: string,
  options?: {
    parseMode?: string;
    buttons?: Array<Array<{ text: string; callback_data?: string; url?: string }>>;
    disableNotification?: boolean;
  }
): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body: any = {
    chat_id: chatId,
    text,
    parse_mode: options?.parseMode ?? 'HTML',
    disable_notification: options?.disableNotification ?? false,
  };

  if (options?.buttons) {
    body.reply_markup = { inline_keyboard: options.buttons };
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const resText = await res.text();
    throw new Error(`Telegram sendMessage failed: ${res.status} ${resText.slice(0, 200)}`);
  }
}

/**
 * Send a message to a specific user's linked Telegram chat.
 *
 * Looks up `user_telegram_links.tg_chat_id` by user_id. If the table
 * doesn't exist yet (pre-Day-4 migration), or the user hasn't linked
 * Telegram, this is a silent no-op so callers in billing/renewal paths
 * stay simple.
 */
export async function sendTelegramPerUser(userId: number, text: string): Promise<void> {
  const chatId = await lookupTelegramChatId(userId);
  if (!chatId) return;
  try {
    await sendTelegramMessage(chatId, text);
  } catch {
    // Best-effort notification — swallow to never block callers.
  }
}

/**
 * Look up a user's bound tg_chat_id. Handles the pre-migration case
 * where the table doesn't exist yet (code 42P01).
 */
async function lookupTelegramChatId(userId: number): Promise<string | null> {
  try {
    const { db } = await import('../db/client.js');
    const { sql } = await import('drizzle-orm');
    const result = await db.execute<{ tg_chat_id: string }>(
      sql`SELECT tg_chat_id FROM user_telegram_links WHERE user_id = ${userId} LIMIT 1`,
    );
    const row = (result as any).rows?.[0] ?? (Array.isArray(result) ? result[0] : null);
    return row?.tg_chat_id ?? null;
  } catch (err) {
    const code = (err as any)?.code;
    if (code === '42P01') return null; // table not created yet
    return null;
  }
}

/**
 * Send a document (e.g. FBS assembly-slip PDF) to the user's linked chat.
 * Returns true on delivery, false if the user has no Telegram binding or
 * the upload failed — the caller is expected to fall back to returning
 * the document inline.
 */
export async function sendTelegramPerUserDocument(
  userId: number,
  document: Buffer,
  filename: string,
  caption?: string,
): Promise<boolean> {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return false;
  const chatId = await lookupTelegramChatId(userId);
  if (!chatId) return false;

  try {
    const form = new FormData();
    form.append('chat_id', chatId);
    // Web API FormData expects a Blob. Buffer's underlying ArrayBuffer can be
    // a SharedArrayBuffer per current Node types, which BlobPart rejects —
    // copy into a fresh Uint8Array to normalise the backing store.
    const bytes = new Uint8Array(document.byteLength);
    bytes.set(document);
    form.append('document', new Blob([bytes], { type: 'application/pdf' }), filename);
    if (caption) form.append('caption', caption);

    const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
      method: 'POST',
      body: form,
    });
    return res.ok;
  } catch {
    return false;
  }
}
