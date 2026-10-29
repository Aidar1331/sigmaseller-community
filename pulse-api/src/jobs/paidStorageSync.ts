/**
 * Paid Storage Daily Sync Job
 *
 * Pulls фактическую стоимость платного хранения per-nmId per-day from WB
 * Seller Analytics API (`/api/v1/paid_storage`) and writes into
 * `wb_storage_daily` (the same table the AI `query_storage` tool reads).
 *
 * Replaces the legacy `statistics-api` /reports/storage path, which was
 * disabled in 2026-03 (returns 404).
 *
 * Default window: last 8 days on cron. Use runPaidStorageSyncForShop with
 * custom `daysBack` (e.g. 60/90) for backfill via scripts/backfill-paid-storage.ts.
 */

import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { marketplaceShops, wbStorageDaily, wbSyncRuns } from '../db/schema.js';
import { getWbApiKey } from '../integrations/wb/wbClient.js';
import { chunkDateRange, runPaidStorageReport, type PaidStorageRow } from '../integrations/wb/paidStorage.js';
import { logJobs as logger } from '../lib/logger.js';

const DAYS_BACK_DEFAULT = 8;
/** Pause between WB tasks to stay well under the 3 req/min cap. */
const INTER_CHUNK_PAUSE_MS = 21_000;

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function hashWarehouse(name: string): number {
  // Stable deterministic hash for warehouse_name → warehouse_id (WB doesn't
  // return officeId everywhere). Keeps the int column populated for indexing.
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

async function insertRows(
  workspaceId: number,
  shopId: number,
  dateFrom: string,
  dateTo: string,
  rows: PaidStorageRow[],
): Promise<number> {
  if (rows.length === 0) return 0;

  // Replace the whole [dateFrom, dateTo] window for this shop so re-runs are
  // idempotent even without a unique constraint on the target table.
  await db
    .delete(wbStorageDaily)
    .where(
      and(
        eq(wbStorageDaily.workspaceId, workspaceId),
        eq(wbStorageDaily.shopId, shopId),
        gte(wbStorageDaily.date, new Date(`${dateFrom}T00:00:00Z`)),
        lte(wbStorageDaily.date, new Date(`${dateTo}T23:59:59Z`)),
      ),
    );

  const values = rows
    .map((r) => {
      const nmId = Number(r.nmId);
      if (!Number.isFinite(nmId) || nmId <= 0) return null;
      const rawDate = r.date || r.originalDate;
      if (!rawDate) return null;
      const date = new Date(rawDate);
      if (Number.isNaN(date.getTime())) return null;
      const warehouseName = r.warehouse ?? 'unknown';
      const warehouseId = r.officeId ?? hashWarehouse(warehouseName);
      const costKopecks = Math.round(Number(r.warehousePrice ?? 0) * 100);
      return {
        workspaceId,
        shopId,
        nmId,
        date,
        warehouseId,
        warehouseName,
        volume: Number(r.volume ?? 0) || null,
        cost: costKopecks,
        days: 1,
      };
    })
    .filter((v): v is NonNullable<typeof v> => v !== null);

  if (values.length === 0) return 0;

  // Batch insert to avoid 64k parameter limit for huge periods.
  const BATCH = 500;
  for (let i = 0; i < values.length; i += BATCH) {
    await db.insert(wbStorageDaily).values(values.slice(i, i + BATCH));
  }
  return values.length;
}

/**
 * Run paid_storage sync for a single shop. Splits the window into ≤8-day
 * chunks and respects the rate limit between chunks.
 */
export async function runPaidStorageSyncForShop(
  workspaceId: number,
  shopId: number,
  daysBack?: number,
): Promise<{ rows: number; chunks: number }> {
  const effectiveDays = daysBack ?? Number.parseInt(process.env.PAID_STORAGE_DAYS_BACK || String(DAYS_BACK_DEFAULT), 10);

  const apiKey = await getWbApiKey(workspaceId, shopId);
  if (!apiKey) throw new Error(`No API key for workspace ${workspaceId} shop ${shopId}`);

  const today = new Date();
  const dateTo = isoDay(today);
  const dateFrom = isoDay(new Date(today.getTime() - effectiveDays * 86_400_000));

  const chunks = chunkDateRange(dateFrom, dateTo);
  logger.info({ workspaceId, shopId, dateFrom, dateTo, chunks: chunks.length }, 'paid_storage sync starting');

  let totalRows = 0;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    try {
      const rows = await runPaidStorageReport(apiKey, c.from, c.to);
      const inserted = await insertRows(workspaceId, shopId, c.from, c.to, rows);
      totalRows += inserted;
      logger.info({ workspaceId, shopId, from: c.from, to: c.to, fetched: rows.length, inserted }, 'paid_storage chunk done');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ workspaceId, shopId, from: c.from, to: c.to, error: message }, 'paid_storage chunk failed');
    }
    if (i < chunks.length - 1) {
      await new Promise((r) => setTimeout(r, INTER_CHUNK_PAUSE_MS));
    }
  }

  return { rows: totalRows, chunks: chunks.length };
}

/**
 * Run paid_storage sync for ALL active WB shops. Called by cron.
 */
export async function runPaidStorageSync(): Promise<void> {
  logger.info('paid_storage daily sync started');
  const started = Date.now();

  const activeShops = await db
    .select({ workspaceId: marketplaceShops.workspaceId, shopId: marketplaceShops.shopId })
    .from(marketplaceShops)
    .where(and(eq(marketplaceShops.platform, 'wb'), eq(marketplaceShops.isActive, true)));

  logger.info({ count: activeShops.length }, 'paid_storage: active WB shops');

  let totalRows = 0;
  let errors = 0;

  for (const shop of activeShops) {
    const { randomUUID } = await import('node:crypto');
    const runId = randomUUID();

    await db.insert(wbSyncRuns).values({
      runId,
      workspaceId: shop.workspaceId,
      shopId: shop.shopId,
      stage: 'paid-storage:cron',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    try {
      const r = await runPaidStorageSyncForShop(shop.workspaceId, shop.shopId);
      totalRows += r.rows;
      await db
        .update(wbSyncRuns)
        .set({ stage: 'paid-storage:done', status: 'done', finishedAt: new Date(), updatedAt: new Date() })
        .where(eq(wbSyncRuns.runId, runId));
    } catch (err) {
      errors++;
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ workspaceId: shop.workspaceId, shopId: shop.shopId, error: message }, 'paid_storage shop failed');
      await db
        .update(wbSyncRuns)
        .set({ stage: 'paid-storage:failed', status: 'failed', error: message.slice(0, 500), finishedAt: new Date(), updatedAt: new Date() })
        .where(eq(wbSyncRuns.runId, runId));
    }

    // Pause between shops to stay under WB per-key rate limit.
    await new Promise((r) => setTimeout(r, INTER_CHUNK_PAUSE_MS));
  }

  // 2026-06-01: Прокидываем свежесинкнутый storage в wb_finance_daily_products
  // — там WB API не возвращает storage_kopecks по товарам, всё лежит в
  // wb_storage_daily. Без этого UPDATE finance-таблица показывает storage=0
  // и расчёты прибыли/маржи занижают расходы. Запрос идемпотентный, JOIN
  // по (workspace_id, shop_id, date, nm_id).
  try {
    const result = await db.execute(sql`
      WITH agg AS (
        SELECT workspace_id, shop_id, TO_CHAR(date::date, 'YYYY-MM-DD') AS d, nm_id, SUM(cost)::bigint AS storage_kop
        FROM wb_storage_daily
        WHERE date::date >= CURRENT_DATE - INTERVAL '60 days'
        GROUP BY 1,2,3,4
      )
      UPDATE wb_finance_daily_products f
      SET storage_kopecks = a.storage_kop, updated_at = NOW()
      FROM agg a
      WHERE f.workspace_id = a.workspace_id
        AND f.shop_id = a.shop_id
        AND f.date = a.d
        AND f.nm_id = a.nm_id
        AND f.storage_kopecks IS DISTINCT FROM a.storage_kop
    `);
    logger.info({ updated: (result as any).rowCount }, 'paid_storage → finance: storage_kopecks backfilled');
  } catch (err) {
    logger.error({ err }, 'paid_storage → finance backfill failed (non-fatal)');
  }

  logger.info({ elapsedMs: Date.now() - started, totalRows, errors }, 'paid_storage daily sync completed');
}
