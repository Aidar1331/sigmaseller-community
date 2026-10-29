/**
 * FBS-остатки sync — отдельно от FBO.
 *
 * Источник: WB Marketplace API `GET /api/v3/stocks/{warehouseId}` с body
 * `{ skus: [...] }`. Возвращает только те SKU, по которым есть остаток.
 *
 * Алгоритм:
 *   1. Получить список FBS-складов продавца (`getSellerWarehouses`).
 *   2. Собрать все SKU магазина из `wb_cards.raw.sizes[].skus[]`.
 *   3. Для каждого склада запросить остатки батчами по 1000 SKU.
 *   4. Upsert в `wb_stocks_fbs_current`.
 *
 * Хранение per-SKU (баркод размера) важно — один nm_id может иметь несколько
 * SKU (по размерам), и распределение по складам тоже разное.
 */

import { db } from '../db/client.js';
import { eq, and } from 'drizzle-orm';
import { wbCards, wbStocksFbsCurrent, marketplaceShops } from '../db/schema.js';
import { getWbApiKey } from '../integrations/wb/wbClient.js';
import { getSellerWarehouses, getStocksByWarehouse } from '../integrations/wb/warehouses.js';
import { forEachWorkspace } from './workspaceIterator.js';
import { logJobs as logger } from '../lib/logger.js';

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function syncFbsForShop(workspaceId: number, shopId: number): Promise<{ rows: number; warehouses: number }> {
  const apiKey = await getWbApiKey(workspaceId, shopId);
  if (!apiKey) return { rows: 0, warehouses: 0 };

  // 1. List seller warehouses (FBS only)
  let warehouses: Awaited<ReturnType<typeof getSellerWarehouses>>;
  try {
    warehouses = await getSellerWarehouses(apiKey);
  } catch (e: any) {
    logger.warn({ err: e?.message, workspaceId, shopId }, 'FBS sync: failed to list seller warehouses');
    return { rows: 0, warehouses: 0 };
  }
  if (!warehouses.length) return { rows: 0, warehouses: 0 };

  // 2. Collect SKUs from wb_cards.raw.sizes[].skus[]
  const cards = await db
    .select({ nmId: wbCards.nmId, raw: wbCards.raw })
    .from(wbCards)
    .where(eq(wbCards.workspaceId, workspaceId));

  const skuToNmId = new Map<string, number>();
  for (const c of cards) {
    const sizes = (c.raw as any)?.sizes ?? [];
    if (!Array.isArray(sizes)) continue;
    for (const sz of sizes) {
      const skus = sz?.skus ?? [];
      if (!Array.isArray(skus)) continue;
      for (const sku of skus) {
        if (typeof sku === 'string' && sku) skuToNmId.set(sku, Number(c.nmId));
      }
    }
  }
  const skus = [...skuToNmId.keys()];
  if (!skus.length) return { rows: 0, warehouses: warehouses.length };

  // 3. For each warehouse, batch query stocks (max 1000 SKU per call)
  let totalRows = 0;
  for (const wh of warehouses) {
    for (let i = 0; i < skus.length; i += 1000) {
      const batch = skus.slice(i, i + 1000);
      let result: { stocks: Array<{ sku: string; amount: number }> } | null;
      try {
        result = await getStocksByWarehouse(apiKey, wh.id, batch);
      } catch (e: any) {
        logger.warn({ err: e?.message, workspaceId, shopId, warehouseId: wh.id }, 'FBS sync: getStocksByWarehouse failed batch');
        await sleep(500);
        continue;
      }
      const stocks = result?.stocks ?? [];
      const now = new Date();
      for (const s of stocks) {
        const nmId = skuToNmId.get(s.sku);
        if (!nmId) continue;
        try {
          await db
            .insert(wbStocksFbsCurrent)
            .values({
              workspaceId,
              shopId,
              warehouseId: wh.id,
              nmId,
              sku: s.sku,
              quantity: Math.max(0, Math.round(s.amount ?? 0)),
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: [
                wbStocksFbsCurrent.workspaceId,
                wbStocksFbsCurrent.shopId,
                wbStocksFbsCurrent.warehouseId,
                wbStocksFbsCurrent.sku,
              ],
              set: {
                nmId,
                quantity: Math.max(0, Math.round(s.amount ?? 0)),
                updatedAt: now,
              },
            });
          totalRows++;
        } catch (e: any) {
          logger.warn({ err: e?.message, workspaceId, sku: s.sku }, 'FBS sync: upsert failed');
        }
      }
      await sleep(250); // rate-limit courtesy
    }
  }

  logger.info({ workspaceId, shopId, warehouses: warehouses.length, rows: totalRows }, 'FBS stocks synced');
  return { rows: totalRows, warehouses: warehouses.length };
}

export async function runFbsStocksSync(): Promise<void> {
  await forEachWorkspace({ overrideEnvVar: 'FBS_STOCKS_SYNC_WORKSPACE_ID' }, async (workspaceId: number) => {
    const shops = await db
      .select({ shopId: marketplaceShops.shopId, platform: marketplaceShops.platform })
      .from(marketplaceShops)
      .where(
        and(
          eq(marketplaceShops.workspaceId, workspaceId),
          eq(marketplaceShops.isActive, true),
          eq(marketplaceShops.platform, 'wb'),
        ),
      );

    for (const shop of shops) {
      try {
        await syncFbsForShop(workspaceId, shop.shopId);
      } catch (e: any) {
        logger.error({ err: e?.message, workspaceId, shopId: shop.shopId }, 'FBS sync failed for shop');
      }
    }
  });
}
