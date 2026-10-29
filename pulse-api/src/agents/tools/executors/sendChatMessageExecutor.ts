/**
 * `send_chat_message` executor. Ownership in wb_chats(workspace_id, chat_id).
 * Resolves WB API key (per-shop) and calls sendMessage.
 */

import { sql } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { sendSellerMessage, getSellerChats } from '../../../integrations/wb/chats.js';
import { getWbApiKey } from '../../../integrations/wb/wbClient.js';
import { assertAgentAuth } from '../locks.js';
import type { ActionExecutor } from '../actionQueue.js';
import { logAgent as logger } from '../../../lib/logger.js';

interface SendChatArgs { chatId: string; text: string; }

const retryable = (msg: string): boolean => {
  const m = msg.toLowerCase();
  return /\b5\d\d\b/.test(m) || m.includes('timeout') || m.includes('econn') || m.includes('rate-limit') || m.includes('429');
};

export const sendChatMessageExecutor: ActionExecutor = async (args, ctx) => {
  const a = args as unknown as SendChatArgs;
  if (!a.chatId) return { status: 'error', error: 'bad chatId', retryable: false };
  if (!a.text?.trim()) return { status: 'error', error: 'empty text', retryable: false };
  if (ctx.shopId == null) return { status: 'error', error: 'shop_id missing', retryable: false };
  try { await assertAgentAuth(ctx.userId ?? undefined, ctx.workspaceId); }
  catch (err) { return { status: 'error', error: `auth: ${err instanceof Error ? err.message : err}`, retryable: false }; }

  const ownedRes = await db.execute<{ exists: number }>(sql`
    SELECT 1 AS exists FROM wb_chats
    WHERE workspace_id = ${ctx.workspaceId} AND chat_id = ${a.chatId}
    LIMIT 1
  `);
  if (!Array.isArray(((ownedRes as any).rows ?? ownedRes)) || (((ownedRes as any).rows ?? ownedRes) as any[]).length === 0) {
    return { status: 'error', error: `chatId=${a.chatId} not in workspace=${ctx.workspaceId}`, retryable: false };
  }

  try {
    const apiKey = await getWbApiKey(ctx.workspaceId, ctx.shopId);
    if (!apiKey) return { status: 'error', error: 'WB API key not configured', retryable: false };

    // WB Buyer Chat API требует replySign (криптоподпись чата) — chatId сам по
    // себе не годится. У нас в wb_chats эта подпись пока не хранится (TODO:
    // добавить колонку и сохранять при синке). Поэтому подтягиваем on-the-fly:
    // запрашиваем активные чаты и ищем нужный по chatId.
    const list = await getSellerChats(apiKey, { status: 'active', limit: 200 });
    const match = (list.data ?? []).find((c) => c.chatId === a.chatId);
    if (!match?.replySign) {
      return { status: 'error', error: `replySign not found for chatId=${a.chatId} (maybe chat is closed)`, retryable: false };
    }

    const result = await sendSellerMessage(apiKey, { replySign: match.replySign, text: a.text });
    return { status: 'success', result: { chatId: a.chatId, messageId: result.messageId, message: `✅ Сообщение в чат ${a.chatId} отправлено` } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ actionId: ctx.actionId, chatId: a.chatId, errMsg: msg }, 'send_chat_message: WB rejected');
    return { status: 'error', error: msg, retryable: retryable(msg) };
  }
};
