import { db } from '../../db/client.js';
import { wbStocksCurrent, wbStocksDailyProducts, wbCards } from '../../db/schema.js';
import { sql, eq, and } from 'drizzle-orm';
import { getWbApiKey, wbPostJson } from './wbClient.js';
import { getInsightSettings } from '../../services/insightSettings.js';
import { getExcludedNmIds } from '../../services/insightTags.js';
import { createStockInsights } from '../../services/insightsStocks.js';
import log from '../../lib/logger.js';

const logger = log.child({ module: 'stocks' });

const ANALYTICS_API = 'https://seller-analytics-api.wildberries.ru';

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Refreshes current WB stocks (FBO) and writes a daily snapshot row.
 * Source: WB Analytics API v2 POST /api/v2/stocks-report/products/products
 * (Migrated from deprecated GET /api/v1/supplier/stocks — dies June 23, 2026)
 *
 * @param workspaceId - The workspace ID
 * @param shopId - Optional shop ID for multi-shop support.
 */
export async function syncWbStocksCurrentAndSnapshot(workspaceId: number, shopId: number): Promise<{ rows: number }> {
  const apiKey = await getWbApiKey(workspaceId, shopId);
  const today = isoDate(new Date());

  // Fetch all products via paginated POST endpoint
  const byNm = new Map<
    number,
    { quantity: number; inWayToClient: number; inWayFromClient: number }
  >();

  const url = `${ANALYTICS_API}/api/v2/stocks-report/products/products`;
  const limit = 1000;
  let offset = 0;

  while (true) {
    const body = {
      currentPeriod: { start: today, end: today },
      stockType: '',
      skipDeletedNm: true,
      orderBy: { field: 'stockCount', mode: 'desc' },
      availabilityFilters: ['deficient', 'actual', 'balanced', 'nonActual', 'nonLiquid', 'invalidData'],
      limit,
      offset,
    };

    let res: any;
    try {
      res = await wbPostJson(url, apiKey, body);
    } catch (e: any) {
      logger.error({ err: e, workspaceId, offset }, 'Failed to fetch stocks v2');
      break;
    }

    const items = res?.data?.items;
    if (!items || !Array.isArray(items) || items.length === 0) break;

    for (const item of items) {
      const nmId = Number(item?.nmID ?? item?.nmId);
      if (!Number.isFinite(nmId) || nmId <= 0) continue;

      const metrics = item.metrics ?? {};
      const qty = Number(metrics.stockCount ?? 0);
      const iwTo = Number(metrics.toClientCount ?? 0);
      const iwFrom = Number(metrics.fromClientCount ?? 0);

      const cur = byNm.get(nmId) ?? { quantity: 0, inWayToClient: 0, inWayFromClient: 0 };
      cur.quantity += Number.isFinite(qty) ? qty : 0;
      cur.inWayToClient += Number.isFinite(iwTo) ? iwTo : 0;
      cur.inWayFromClient += Number.isFinite(iwFrom) ? iwFrom : 0;
      byNm.set(nmId, cur);
    }

    logger.info({ workspaceId, offset, fetched: items.length }, 'Stocks v2 page fetched');

    if (items.length < limit) break;
    offset += limit;
  }

  const date = isoDate(new Date());

  for (const [nmId, v] of byNm.entries()) {
    const row = {
      workspaceId,
      shopId,
      nmId,
      quantity: Math.max(0, Math.round(v.quantity)),
      inWayToClient: Math.max(0, Math.round(v.inWayToClient)),
      inWayFromClient: Math.max(0, Math.round(v.inWayFromClient)),
      warehouseName: null as string | null,
      updatedAt: new Date(),
    };

    await db
      .insert(wbStocksCurrent)
      .values(row)
      .onConflictDoUpdate({
        target: [wbStocksCurrent.workspaceId, wbStocksCurrent.shopId, wbStocksCurrent.nmId],
        set: { ...row, updatedAt: new Date() },
      });

    await db
      .insert(wbStocksDailyProducts)
      .values({
        workspaceId,
        shopId,
        date,
        nmId,
        quantity: row.quantity,
        inWayToClient: row.inWayToClient,
        inWayFromClient: row.inWayFromClient,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [wbStocksDailyProducts.workspaceId, wbStocksDailyProducts.shopId, wbStocksDailyProducts.date, wbStocksDailyProducts.nmId],
        set: {
          quantity: row.quantity,
          inWayToClient: row.inWayToClient,
          inWayFromClient: row.inWayFromClient,
          updatedAt: new Date(),
        },
      });
  }

  // Backfill productTitle from wbCards
  await db.execute(sql`
    UPDATE ${wbStocksCurrent} sc
    SET product_title = c.title
    FROM ${wbCards} c
    WHERE sc.workspace_id = c.workspace_id AND sc.nm_id = c.nm_id
      AND sc.workspace_id = ${workspaceId}
      AND (sc.product_title IS NULL OR sc.product_title = '')
  `);

  if ((process.env.ENABLE_INSIGHTS_STOCKS ?? '') === '1') {
    try {
      const settings = await getInsightSettings(workspaceId);
      const excluded = await getExcludedNmIds(workspaceId, settings.excludedTagIds);
      await createStockInsights({
        workspaceId,
        date,
        minStockDays: settings.minStockDays,
        excludedNmIds: excluded,
        cooldownDays: 1,
      });
    } catch {
      // ignore insight errors in sync path
    }
  }

  return { rows: byNm.size };
}
