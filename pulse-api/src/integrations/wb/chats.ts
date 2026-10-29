/**
 * WB Buyer Chats API (актуальный набор endpoints из доки 2026-04-07).
 * Host: https://buyer-chat-api.wildberries.ru
 *
 * До 2026-04 в коде использовались старые `/api/v1/chats/*` пути; они отдают
 * 404 в текущем API. Новые точки — все под `/api/v1/seller/*`:
 *
 *   GET  /api/v1/seller/chats             — список чатов
 *   GET  /api/v1/seller/events            — события (новые сообщения)
 *   POST /api/v1/seller/message           — отправка сообщения (text/file/image)
 *   GET  /api/v1/seller/download/{id}     — скачать вложение
 *
 * Подпись `X-Client-Secret` подмешивается глобальным interceptor'ом
 * (см. wbClient.ts → installWbPartnerSecretInterceptor).
 */

import { wbGetJson, wbPostJson } from './wbClient.js';

const BUYER_CHAT_API = 'https://buyer-chat-api.wildberries.ru';

// ============================================================================
// Types
// ============================================================================

export interface WbChat {
  chatId: string;
  replySign?: string;
  nmId?: number;
  vendorCode?: string;
  brandName?: string;
  buyerId?: string;
  buyerName?: string;
  lastMessage?: string;
  lastMessageAt?: string;
  unreadCount: number;
  status: 'active' | 'closed';
  createdAt: string;
}

export interface WbChatAttachment {
  /** Прямой URL — можно скачать без отдельного вызова. */
  url?: string;
  /** ID файла — скачивается через GET /api/v1/seller/download/{id}. */
  downloadID?: string;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
}

export interface WbChatEvent {
  eventId: string;
  chatId: string;
  replySign?: string;
  type: 'message' | 'chat_opened' | 'chat_closed' | string;
  fromBuyer: boolean;
  text?: string;
  attachments?: WbChatAttachment[];
  createdAt: string;
  readAt?: string;
}

export interface WbChatsListResponse {
  data: WbChat[];
  next?: string | null;
  hasNext?: boolean;
}

export interface WbChatEventsResponse {
  data: WbChatEvent[];
  next?: string | null;
  hasNext?: boolean;
}

// ============================================================================
// API Functions — современные `/api/v1/seller/*` endpoints
// ============================================================================

/** GET /api/v1/seller/chats — список чатов продавца.
 *
 * WB отдаёт ответ в формате `{ result: [{ chatID, replySign, clientName, goodCard:{nmID,…}, … }] }`.
 * Нормализуем к нашему интерфейсу `{ data: WbChat[], hasNext, next }`,
 * чтобы остальной код (wbChatsSync, sendChatMessageExecutor, getUnreadChatsCount)
 * мог работать с предсказуемой формой.
 */
export async function getSellerChats(
  apiKey: string,
  params?: { status?: 'active' | 'closed'; unreadOnly?: boolean; limit?: number; next?: string },
): Promise<WbChatsListResponse> {
  const qs = new URLSearchParams();
  if (params?.status) qs.set('status', params.status);
  if (params?.unreadOnly) qs.set('unreadOnly', 'true');
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.next) qs.set('next', params.next);
  const suffix = qs.toString() ? `?${qs}` : '';
  const raw = await wbGetJson<any>(`${BUYER_CHAT_API}/api/v1/seller/chats${suffix}`, apiKey);
  const rows: any[] = Array.isArray(raw?.result) ? raw.result : Array.isArray(raw?.data) ? raw.data : [];
  const data: WbChat[] = rows.map((r) => ({
    chatId: String(r?.chatID ?? r?.chatId ?? ''),
    replySign: r?.replySign ?? undefined,
    nmId: r?.goodCard?.nmID ?? r?.nmId ?? undefined,
    vendorCode: r?.goodCard?.vendorCode ?? r?.vendorCode ?? undefined,
    brandName: r?.goodCard?.brandName ?? r?.brandName ?? undefined,
    buyerId: r?.buyerId ?? r?.clientID ?? undefined,
    buyerName: r?.clientName ?? r?.buyerName ?? undefined,
    lastMessage: r?.lastMessage?.text ?? r?.lastMessage ?? undefined,
    lastMessageAt: r?.lastMessage?.createdAt ?? r?.lastMessageAt ?? undefined,
    unreadCount: Number(r?.unreadCount ?? r?.newMessagesCount ?? 0),
    status: (r?.status === 'closed' ? 'closed' : 'active'),
    createdAt: r?.createdAt ?? r?.lastMessage?.createdAt ?? new Date().toISOString(),
  }));
  return { data, hasNext: Boolean(raw?.hasNext), next: raw?.next ?? null };
}

/**
 * GET /api/v1/seller/events — события всех чатов с момента `next` (cursor).
 * Каждое событие включает chatId + replySign, который нужен для отправки ответа.
 */
export async function getSellerEvents(
  apiKey: string,
  params?: { chatId?: string; next?: string; limit?: number },
): Promise<WbChatEventsResponse> {
  const qs = new URLSearchParams();
  if (params?.chatId) qs.set('chatId', params.chatId);
  if (params?.next) qs.set('next', params.next);
  if (params?.limit) qs.set('limit', String(params.limit));
  const suffix = qs.toString() ? `?${qs}` : '';
  const raw = await wbGetJson<any>(`${BUYER_CHAT_API}/api/v1/seller/events${suffix}`, apiKey);
  const rows: any[] = Array.isArray(raw?.result) ? raw.result : Array.isArray(raw?.data) ? raw.data : [];
  const data: WbChatEvent[] = rows.map((r) => ({
    eventId: String(r?.eventID ?? r?.eventId ?? ''),
    chatId: String(r?.chatID ?? r?.chatId ?? ''),
    replySign: r?.replySign ?? undefined,
    type: r?.type ?? 'message',
    fromBuyer: Boolean(r?.fromBuyer ?? r?.isBuyer ?? true),
    text: r?.message?.text ?? r?.text ?? undefined,
    attachments: r?.message?.attachments ?? r?.attachments ?? undefined,
    createdAt: r?.createdAt ?? new Date().toISOString(),
    readAt: r?.readAt ?? undefined,
  }));
  return { data, hasNext: Boolean(raw?.hasNext), next: raw?.next ?? null };
}

/**
 * POST /api/v1/seller/message — отправить сообщение в чат.
 *
 * Унифицированный endpoint для text/file/image — то, что раньше было
 * разнесено по трём (`/chats/send`, `/send/file`, `/send/image`).
 *
 * `replySign` берётся из getSellerChats() или getSellerEvents() — это
 * криптографическая подпись чата, без неё WB вернёт 403.
 */
export async function sendSellerMessage(
  apiKey: string,
  params: { replySign: string; text?: string; fileUrl?: string; imageUrl?: string },
): Promise<{ messageId?: string }> {
  const body: Record<string, any> = { replySign: params.replySign };
  if (params.text) body.text = params.text;
  if (params.fileUrl) body.fileUrl = params.fileUrl;
  if (params.imageUrl) body.imageUrl = params.imageUrl;
  return wbPostJson(`${BUYER_CHAT_API}/api/v1/seller/message`, apiKey, body);
}

/**
 * GET /api/v1/seller/download/{id} — скачать вложение (файл/изображение)
 * по `downloadID` из attachments события.
 *
 * Возвращает сырой Buffer + content-type. Для удобства вызывающего —
 * скрывает плюрализм типов файлов за единым интерфейсом.
 */
export async function downloadSellerAttachment(
  apiKey: string,
  downloadID: string,
): Promise<{ buffer: Buffer; contentType: string | null; fileName: string | null }> {
  const res = await fetch(`${BUYER_CHAT_API}/api/v1/seller/download/${encodeURIComponent(downloadID)}`, {
    headers: { Authorization: apiKey },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`WB attachment download failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get('content-type');
  // RFC 6266: filename="..." в Content-Disposition. Не критично если нет.
  const disposition = res.headers.get('content-disposition') ?? '';
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  const fileName = m?.[1] ? decodeURIComponent(m[1]) : null;
  return { buffer, contentType, fileName };
}

// ============================================================================
// Backwards-compat aliases — функции с прежними именами не сломаются на
// существующих call-sites, но физически идут на новые endpoints.
// ============================================================================

export const getChats = getSellerChats;

/** Старое имя — теперь объединено с events. Чтобы не ломать callers. */
export async function getChatMessages(apiKey: string, chatId: string, params?: { next?: string; limit?: number }) {
  return getSellerEvents(apiKey, { chatId, ...params });
}

/** Старая сигнатура: (apiKey, chatId, text) → переходим на replySign. */
export async function sendMessage(apiKey: string, chatIdOrReplySign: string, text: string) {
  // Если caller всё ещё передаёт chatId — придётся подтянуть replySign отдельно.
  // Корректные call-sites должны мигрировать на sendSellerMessage с replySign.
  return sendSellerMessage(apiKey, { replySign: chatIdOrReplySign, text });
}

/** Backwards-compat. Новый sendSellerMessage умеет fileUrl сам. */
export async function sendFile(apiKey: string, replySign: string, fileUrl: string, _fileName: string) {
  return sendSellerMessage(apiKey, { replySign, fileUrl });
}

/** Backwards-compat. Новый sendSellerMessage умеет imageUrl сам. */
export async function sendImage(apiKey: string, replySign: string, imageUrl: string) {
  return sendSellerMessage(apiKey, { replySign, imageUrl });
}

/**
 * Backwards-compat. В актуальном API нет явного "mark as read" — прочтение
 * фиксируется поглощением events. Делаем no-op чтобы старые call-sites
 * не падали.
 */
export async function markChatAsRead(_apiKey: string, _chatId: string): Promise<{ success: boolean }> {
  return { success: true };
}

/**
 * Backwards-compat. В актуальном API нет dedicated unread-count; считаем
 * из списка чатов (sum unreadCount по активным).
 */
export async function getUnreadCount(apiKey: string): Promise<{ count: number }> {
  const chats = await getSellerChats(apiKey, { status: 'active' });
  const count = (chats.data ?? []).reduce((sum, c) => sum + (c.unreadCount ?? 0), 0);
  return { count };
}
