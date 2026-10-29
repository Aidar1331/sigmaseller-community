/**
 * Stocks History Daily Sync Job
 *
 * Syncs per-product stock history from WB to wb_stocks_daily table.
 * Source: POST /api/analytics/v3/stocks-history (per-product, paginated)
 * Fallback: CSV STOCK_HISTORY_REPORT_CSV
 *
 * Cron: 30 6 * * * (06:30 MSK daily)
 * Rate limit: 3 req/min on seller-analytics-api
 */

import { getWbApiKey } from '../integrations/wb/wbClient.js';
import { logJobs as logger } from '../lib/logger.js';
import { downloadStocksHistoryDailyCsv, downloadStocksHistoryCsv } from '../integrations/wb/stocksHistory.js';
import { db } from '../db/client.js';
import { wbStocksDaily, wbSyncRuns, marketplaceShops } from '../db/schema.js';
import { eq, and, sql } from 'drizzle-orm';

const DAYS_BACK_DEFAULT = 90;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Sync stocks history for a single shop.
 * Exported for use in manual refresh pipeline (wb.ts runRefreshForShop).
 */
export async function runStocksHistorySyncForShop(
  workspaceId: number,
  shopId: number,
  daysBack?: number,
): Promise<{ rows: number; source: string }> {
  // F5 (двунаправленный gap-fill): гарантируем глубину истории 90 дней.
  // Если в БД нет данных — full backfill (90).
  // Если есть данные за полные 90 дней + сегодня устарело — только catch-up forward.
  // Если данных меньше 90 дней назад — догружаем historic horizon до 90.
  const REQUIRED_HISTORY = 90;
  const explicitDaysBack = daysBack ?? (process.env.STOCKS_HISTORY_DAYS_BACK ? Number.parseInt(process.env.STOCKS_HISTORY_DAYS_BACK, 10) : undefined);
  let effectiveDays: number;
  if (explicitDaysBack !== undefined) {
    effectiveDays = explicitDaysBack;
  } else {
    const [bounds] = await db
      .select({
        minDate: sql<string | null>`min(${wbStocksDaily.date})::text`,
        maxDate: sql<string | null>`max(${wbStocksDaily.date})::text`,
      })
      .from(wbStocksDaily)
      .where(and(eq(wbStocksDaily.workspaceId, workspaceId), eq(wbStocksDaily.shopId, shopId)));
    if (bounds?.maxDate && bounds?.minDate) {
      const now = Date.now();
      const gapForward = Math.max(0, Math.floor((now - new Date(bounds.maxDate).getTime()) / 86400000));
      const firstDateAge = Math.max(0, Math.floor((now - new Date(bounds.minDate).getTime()) / 86400000));
      const gapBackward = Math.max(0, REQUIRED_HISTORY - firstDateAge);
      effectiveDays = Math.min(REQUIRED_HISTORY, Math.max(2, gapForward + 1, gapBackward));
    } else {
      effectiveDays = REQUIRED_HISTORY;
    }
  }

  const apiKey = await getWbApiKey(workspaceId, shopId);
  if (!apiKey) throw new Error(`No API key for workspace ${workspaceId} shop ${shopId}`);

  const today = new Date();
  const dateTo = isoDate(today);

  // WB STOCK_HISTORY_*_CSV rejects start older than 3 calendar months; "today - 90 days" lands 1 day too early when Feb is in range.
  const earliestAllowed = new Date(today);
  earliestAllowed.setMonth(earliestAllowed.getMonth() - 3);
  earliestAllowed.setDate(earliestAllowed.getDate() + 1);

  let candidateFrom = new Date(today.getTime() - effectiveDays * 86400000);
  if (candidateFrom < earliestAllowed) candidateFrom = earliestAllowed;
  const dateFrom = isoDate(candidateFrom);

  logger.info({ workspaceId, shopId, dateFrom, dateTo, daysBack: effectiveDays }, 'Fetching stocks history');

  let totalRows = 0;
  let source = 'csv-daily';

  // Primary: STOCK_HISTORY_DAILY_CSV (per-product, per-day, per-warehouse — no Jam required)
  // Fallback: STOCK_HISTORY_REPORT_CSV (aggregated metrics)
  try {
    const csvRows = await downloadStocksHistoryDailyCsv(apiKey, { dateFrom, dateTo });
    logger.info({ workspaceId, shopId, csvRows: csvRows.length }, 'Daily CSV fetched');

    for (const row of csvRows) {
      const nmId = Number(row.nmId);
      if (!Number.isFinite(nmId) || nmId <= 0) continue;
      const dateStr = typeof row.date === 'string' ? row.date.slice(0, 10) : null;
      if (!dateStr) continue;

      await db.execute(sql`
        INSERT INTO wb_stocks_daily (workspace_id, shop_id, nm_id, date, warehouse_id, warehouse_name, qty, in_way_to_client, in_way_from_client)
        VALUES (${workspaceId}, ${shopId}, ${nmId}, ${dateStr}::timestamptz, 0, ${row.warehouseName ?? 'unknown'}, ${row.quantity ?? 0}, ${row.inWayToClient ?? 0}, ${row.inWayFromClient ?? 0})
        ON CONFLICT (workspace_id, shop_id, nm_id, date) WHERE shop_id IS NOT NULL
        DO UPDATE SET qty = EXCLUDED.qty, in_way_to_client = EXCLUDED.in_way_to_client, in_way_from_client = EXCLUDED.in_way_from_client, warehouse_name = EXCLUDED.warehouse_name
      `);
      totalRows++;
    }
  } catch (dailyErr) {
    const errMsg = dailyErr instanceof Error ? dailyErr.message : String(dailyErr);
    logger.warn({ workspaceId, shopId, error: errMsg }, 'DAILY_CSV failed, trying REPORT_CSV fallback');
    source = 'csv-report';

    try {
      const csvRows = await downloadStocksHistoryCsv(apiKey, { dateFrom, dateTo });
      logger.info({ workspaceId, shopId, csvRows: csvRows.length }, 'Report CSV fallback fetched');

      for (const row of csvRows) {
        const nmId = Number(row.nmId);
        if (!Number.isFinite(nmId) || nmId <= 0) continue;
        const dateStr = typeof row.date === 'string' ? row.date.slice(0, 10) : null;
        if (!dateStr) continue;

        await db.execute(sql`
          INSERT INTO wb_stocks_daily (workspace_id, shop_id, nm_id, date, warehouse_id, warehouse_name, qty, in_way_to_client, in_way_from_client)
          VALUES (${workspaceId}, ${shopId}, ${nmId}, ${dateStr}::timestamptz, 0, ${row.warehouseName ?? 'unknown'}, ${row.quantity ?? 0}, ${row.inWayToClient ?? 0}, ${row.inWayFromClient ?? 0})
          ON CONFLICT (workspace_id, shop_id, nm_id, date) WHERE shop_id IS NOT NULL
          DO UPDATE SET qty = EXCLUDED.qty, in_way_to_client = EXCLUDED.in_way_to_client, in_way_from_client = EXCLUDED.in_way_from_client, warehouse_name = EXCLUDED.warehouse_name
        `);
        totalRows++;
      }
    } catch (reportErr) {
      const reportMsg = reportErr instanceof Error ? reportErr.message : String(reportErr);
      logger.error({ workspaceId, shopId, dailyErr: errMsg, reportErr: reportMsg }, 'Both CSV reports failed');
      throw new Error(`CSV reports failed: daily=${errMsg}, report=${reportMsg}`);
    }
  }

  logger.info({ workspaceId, shopId, totalRows, source }, 'Stocks history sync done for shop');
  return { rows: totalRows, source };
}

/**
 * Run stocks history sync for ALL active shops across all workspaces.
 * Called by cron scheduler.
 */
export async function runStocksHistorySync(): Promise<void> {
  logger.info('Starting daily stocks history sync');
  const startTime = Date.now();

  const activeShops = await db
    .select({ workspaceId: marketplaceShops.workspaceId, shopId: marketplaceShops.shopId })
    .from(marketplaceShops)
    .where(and(eq(marketplaceShops.platform, 'wb'), eq(marketplaceShops.isActive, true)));

  logger.info({ count: activeShops.length }, 'Found active WB shops');

  let totalRecords = 0;
  let errors = 0;

  for (const shop of activeShops) {
    const { randomUUID } = await import('node:crypto');
    const runId = randomUUID();

    await db.insert(wbSyncRuns).values({
      runId,
      workspaceId: shop.workspaceId,
      shopId: shop.shopId,
      stage: 'stocks-history:cron',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    try {
      const result = await runStocksHistorySyncForShop(shop.workspaceId, shop.shopId);
      totalRecords += result.rows;

      await db.update(wbSyncRuns).set({
        stage: 'stocks-history:done',
        status: 'done',
        finishedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(wbSyncRuns.runId, runId));
    } catch (err) {
      errors++;
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ workspaceId: shop.workspaceId, shopId: shop.shopId, error: message }, 'Stocks history error');

      await db.update(wbSyncRuns).set({
        stage: 'stocks-history:failed',
        status: 'failed',
        error: message.slice(0, 500),
        finishedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(wbSyncRuns.runId, runId));
    }

    // Rate limit between shops
    await new Promise(r => setTimeout(r, 21_000));
  }

  const elapsed = Date.now() - startTime;
  logger.info({ elapsedMs: elapsed, totalRecords, errors }, 'Stocks history sync completed');
}
