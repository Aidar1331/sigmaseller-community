/**
 * WB prices daily snapshot — раз в сутки тянет `/api/v2/list/goods/filter`
 * для каждого активного шопа и пишет дневной срез базовой цены / скидки
 * продавца в `wb_prices_history`.
 *
 * Зачем: до этого таблица была пустая. PriceChange detector сравнивает
 * `finished_price_rub` (sold price), но «сколько стоила карточка в каталоге
 * 30 дней назад» взять было неоткуда. Теперь —
 * SELECT … FROM wb_prices_history WHERE nm_id=… AND date<… ORDER BY date DESC LIMIT 1
 * вернёт реальную базовую цену.
 *
 * Endpoint лимит: 1/h (см. wbEndpointLimits.ts: prices-list/1h). Берём
 * страницами по 1000, обычно один шоп = 1-2 страницы.
 */

import { sql, and, eq } from 'drizzle-orm';
import { getQueue } from './queue.js';
import { db } from '../db/client.js';
import { marketplaceShops } from '../db/schema.js';
import { wbGetJson, getWbApiKeyByShop } from '../integrations/wb/wbClient.js';
import log from '../lib/logger.js';

const logger = log.child({ module: 'wbPricesDailySnapshot' });
const JOB_NAME = 'wb-prices-daily-snapshot';
const PRICES_API = 'https://discounts-prices-api.wildberries.ru/api/v2';

interface WbPriceItem {
  nmID: number;
  discount?: number;
  clubDiscount?: number;
  sizes?: Array<{ price?: number; discountedPrice?: number; clubDiscountedPrice?: number }>;
}

async function snapshotShop(shopId: number, workspaceId: number, date: Date): Promise<{ rows: number }> {
  let apiKey: string;
  try { apiKey = await getWbApiKeyByShop(shopId); } catch { return { rows: 0 }; }

  let total = 0;
  let offset = 0;
  for (let page = 0; page < 10; page++) {
    let resp: { data?: { listGoods?: WbPriceItem[] } };
    try {
      resp = await wbGetJson<typeof resp>(`${PRICES_API}/list/goods/filter?limit=1000&offset=${offset}`, apiKey);
    } catch (err) {
      logger.warn({ err, shopId, offset }, 'WB request failed');
      break;
    }
    const items = resp?.data?.listGoods ?? [];
    if (items.length === 0) break;

    for (const it of items) {
      const size = it.sizes?.[0];
      const priceKop = Math.round((size?.price ?? 0) * 100);
      if (!priceKop) continue;
      await db.execute(sql`
        INSERT INTO wb_prices_history (workspace_id, shop_id, nm_id, date, price, discount, club_discount)
        VALUES (
          ${workspaceId}, ${shopId}, ${it.nmID},
          ${date.toISOString()},
          ${priceKop},
          ${it.discount ?? null},
          ${it.clubDiscount ?? null}
        )
        ON CONFLICT (workspace_id, nm_id, date) DO UPDATE SET
          shop_id = EXCLUDED.shop_id,
          price = EXCLUDED.price,
          discount = EXCLUDED.discount,
          club_discount = EXCLUDED.club_discount
      `);
      total++;
    }
    if (items.length < 1000) break;
    offset += 1000;
  }
  return { rows: total };
}

export async function runPricesDailySnapshot(): Promise<void> {
  const shops = await db
    .select({ shopId: marketplaceShops.shopId, workspaceId: marketplaceShops.workspaceId })
    .from(marketplaceShops)
    .where(and(eq(marketplaceShops.platform, 'wb'), eq(marketplaceShops.isActive, true)));

  // Один срез на сутки — date нормализуем на полночь UTC.
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);

  let total = 0;
  for (const s of shops) {
    const { rows } = await snapshotShop(Number(s.shopId), Number(s.workspaceId), date);
    total += rows;
    if (rows > 0) logger.info({ shopId: s.shopId, rows }, 'snapshot done');
  }
  logger.info({ shops: shops.length, totalRows: total }, 'pass complete');
}

export async function registerWbPricesDailySnapshot(): Promise<void> {
  const boss = await getQueue();
  await boss.createQueue(JOB_NAME);
  // 04:15 MSK — после wb-card-snapshot 03:30 чтобы не конкурировать за
  // rate-limit на тот же шоп.
  await boss.schedule(JOB_NAME, '15 1 * * *', {}, { tz: 'UTC' });
  await boss.work(JOB_NAME, { localConcurrency: 1 }, async () => {
    try {
      await runPricesDailySnapshot();
    } catch (err) {
      logger.error({ err }, 'wb-prices-daily-snapshot failed');
      throw err;
    }
  });
  logger.info('registered (daily 04:15 MSK)');
}
