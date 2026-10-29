/**
 * WB buyer chats sync — каждые 10 минут идёт в `/api/v1/seller/chats` и
 * апсёртит активные чаты в `wb_chats` (с replySign в новой колонке).
 *
 * Зачем: до 2026-05-26 chat-sync job не было; `sendChatMessageExecutor`
 * подтягивал replySign on-the-fly при каждой отправке. После миграции 0129
 * + этого job — replySign уже лежит в БД, executor выберет его быстрее.
 *
 * Бежит для каждого активного WB-шопа в системе по очереди. WB rate-limit
 * на /seller/chats — мягкий (60 rpm), 10 минут с шопа = разумно.
 */

import { sql } from 'drizzle-orm';
import { getQueue } from './queue.js';
import { db } from '../db/client.js';
import { marketplaceShops } from '../db/schema.js';
import { getSellerChats } from '../integrations/wb/chats.js';
import { getWbApiKeyByShop } from '../integrations/wb/wbClient.js';
import { eq, and } from 'drizzle-orm';
import log from '../lib/logger.js';

const logger = log.child({ module: 'wbChatsSync' });
const JOB_NAME = 'wb-chats-sync';

async function syncShop(shopId: number, workspaceId: number): Promise<{ upserted: number }> {
  let apiKey: string;
  try {
    apiKey = await getWbApiKeyByShop(shopId);
  } catch (err) {
    logger.warn({ err, shopId }, 'wb-chats-sync: no api key, skipping shop');
    return { upserted: 0 };
  }

  let upserted = 0;
  let cursor: string | undefined = undefined;
  // Безопасный лимит на проход — 5 страниц по 200 = 1000 чатов / шоп / 10 мин.
  // Если у магазина больше — наполнится за несколько проходов.
  for (let page = 0; page < 5; page++) {
    let res: Awaited<ReturnType<typeof getSellerChats>>;
    try {
      res = await getSellerChats(apiKey, { limit: 200, next: cursor });
    } catch (err) {
      logger.warn({ err, shopId, page }, 'wb-chats-sync: WB request failed');
      break;
    }
    const chats = res.data ?? [];
    if (chats.length === 0) break;

    for (const c of chats) {
      // Upsert: workspace_id + chat_id уникален (см. wb_chats_chat_idx).
      // Обновляем replySign, last_message*, unread_count, status — остальное
      // храним из БД.
      await db.execute(sql`
        INSERT INTO wb_chats (workspace_id, shop_id, chat_id, reply_sign, nm_id, buyer_id,
                               last_message, last_message_at, unread_count, status)
        VALUES (
          ${workspaceId},
          ${shopId},
          ${c.chatId},
          ${c.replySign ?? null},
          ${c.nmId ?? null},
          ${c.buyerId ?? null},
          ${c.lastMessage ?? null},
          ${c.lastMessageAt ?? null},
          ${c.unreadCount ?? 0},
          ${c.status === 'closed' ? 'closed' : 'open'}
        )
        ON CONFLICT (workspace_id, chat_id) DO UPDATE SET
          reply_sign = EXCLUDED.reply_sign,
          shop_id = EXCLUDED.shop_id,
          last_message = EXCLUDED.last_message,
          last_message_at = EXCLUDED.last_message_at,
          unread_count = EXCLUDED.unread_count,
          status = EXCLUDED.status,
          updated_at = now()
      `);
      upserted++;
    }

    if (!res.hasNext || !res.next) break;
    cursor = res.next;
  }
  return { upserted };
}

export async function runChatsSync(): Promise<void> {
  const shops = await db
    .select({ shopId: marketplaceShops.shopId, workspaceId: marketplaceShops.workspaceId })
    .from(marketplaceShops)
    .where(and(eq(marketplaceShops.platform, 'wb'), eq(marketplaceShops.isActive, true)));

  let total = 0;
  for (const s of shops) {
    const { upserted } = await syncShop(Number(s.shopId), Number(s.workspaceId));
    total += upserted;
    if (upserted > 0) {
      logger.info({ shopId: s.shopId, workspaceId: s.workspaceId, upserted }, 'wb-chats-sync: shop done');
    }
  }
  logger.info({ shops: shops.length, totalUpserted: total }, 'wb-chats-sync: pass complete');
}

export async function registerWbChatsSync(): Promise<void> {
  const boss = await getQueue();
  await boss.createQueue(JOB_NAME);
  // Cost-cap 2026-06-18: every 6h instead of every 10 min (WB bills per entity).
  await boss.schedule(JOB_NAME, '40 */6 * * *', {}, { tz: 'Europe/Moscow' });
  await boss.work(JOB_NAME, { localConcurrency: 1 }, async () => {
    try {
      await runChatsSync();
    } catch (err) {
      logger.error({ err }, 'wb-chats-sync failed');
      throw err;
    }
  });
  logger.info('registered (every 6h)');
}
