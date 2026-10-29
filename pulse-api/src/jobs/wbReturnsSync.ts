/**
 * WB returns sync — каждые 15 минут идёт в `/api/v1/claims` и апсёртит
 * активные + архивные заявки в `wb_returns`.
 *
 * Зачем: до 2026-05-26 returns sync job не было. Эндпоинт `/api/v1/claims`
 * требует обязательный `is_archive` параметр и отдаёт snake_case поля —
 * парсер уже исправлен в returns.ts. Тут только периодически апсёртим в БД.
 */

import { and, eq, sql } from 'drizzle-orm';
import { getQueue } from './queue.js';
import { db } from '../db/client.js';
import { marketplaceShops } from '../db/schema.js';
import { getClaims } from '../integrations/wb/returns.js';
import { getWbApiKeyByShop } from '../integrations/wb/wbClient.js';
import log from '../lib/logger.js';

const logger = log.child({ module: 'wbReturnsSync' });
const JOB_NAME = 'wb-returns-sync';

async function syncShop(shopId: number, workspaceId: number): Promise<{ upserted: number }> {
  let apiKey: string;
  try {
    apiKey = await getWbApiKeyByShop(shopId);
  } catch (err) {
    logger.warn({ err, shopId }, 'no api key, skipping');
    return { upserted: 0 };
  }

  let upserted = 0;
  for (const isArchive of [false, true]) {
    let offset = 0;
    for (let page = 0; page < 5; page++) {
      let res: Awaited<ReturnType<typeof getClaims>>;
      try {
        res = await getClaims(apiKey, { isArchive, limit: 50, offset });
      } catch (err) {
        logger.warn({ err, shopId, isArchive, offset }, 'WB request failed');
        break;
      }
      const claims = res.data ?? [];
      if (claims.length === 0) break;

      for (const c of claims) {
        const status = isArchive ? (c.status || 'archived') : (c.status || 'pending');
        // return_id в схеме — bigint NOT NULL, но WB claim id — UUID-строка.
        // Хешируем UUID в стабильный bigint через первые 15 hex символов.
        const numericId = Number.parseInt(c.id.replace(/-/g, '').slice(0, 15), 16);
        if (!Number.isFinite(numericId)) continue;
        await db.execute(sql`
          INSERT INTO wb_returns (workspace_id, shop_id, return_id, order_id, nm_id, status, reason, customer_comment, photos)
          VALUES (
            ${workspaceId},
            ${shopId},
            ${numericId},
            ${c.orderId ?? null},
            ${c.nmId ?? null},
            ${status},
            ${c.reason ?? null},
            ${c.buyerComment ?? null},
            ${c.photoUrls ? JSON.stringify(c.photoUrls) : null}::jsonb
          )
          ON CONFLICT (workspace_id, return_id) DO UPDATE SET
            shop_id = EXCLUDED.shop_id,
            status = EXCLUDED.status,
            reason = EXCLUDED.reason,
            customer_comment = EXCLUDED.customer_comment,
            photos = EXCLUDED.photos,
            updated_at = now()
        `);
        upserted++;
      }

      if (!res.hasNext) break;
      offset += 50;
    }
  }
  return { upserted };
}

async function runReturnsSync(): Promise<void> {
  const shops = await db
    .select({ shopId: marketplaceShops.shopId, workspaceId: marketplaceShops.workspaceId })
    .from(marketplaceShops)
    .where(and(eq(marketplaceShops.platform, 'wb'), eq(marketplaceShops.isActive, true)));

  let total = 0;
  for (const s of shops) {
    const { upserted } = await syncShop(Number(s.shopId), Number(s.workspaceId));
    total += upserted;
    if (upserted > 0) {
      logger.info({ shopId: s.shopId, workspaceId: s.workspaceId, upserted }, 'shop done');
    }
  }
  logger.info({ shops: shops.length, totalUpserted: total }, 'pass complete');
}

export async function registerWbReturnsSync(): Promise<void> {
  const boss = await getQueue();
  await boss.createQueue(JOB_NAME);
  // Cost-cap 2026-06-18: every 6h instead of every 15 min (WB bills per entity).
  await boss.schedule(JOB_NAME, '20 */6 * * *', {}, { tz: 'Europe/Moscow' });
  await boss.work(JOB_NAME, { localConcurrency: 1 }, async () => {
    try {
      await runReturnsSync();
    } catch (err) {
      logger.error({ err }, 'wb-returns-sync failed');
      throw err;
    }
  });
  logger.info('registered (every 6h)');
}

export { runReturnsSync };
