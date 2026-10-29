/**
 * Reports Daily Sync Job
 * 
 * Runs async WB reports daily:
 * - hidden-products → alerts for hidden items
 * - deductions → штрафы и удержания
 * - storage → стоимость хранения
 * - warehouse-remains → детальные остатки
 * - region-sales → продажи по регионам
 * 
 * Cron: 0 6 * * * (06:00 MSK)
 */

import { registerJob, JOBS } from './scheduler.js';
import { getBannedProducts, getDeductions, getRegionSales, runWarehouseRemains } from '../integrations/wb/reportsV2.js';
import { logJobs as logger } from '../lib/logger.js';
import { getWbApiKey } from '../integrations/wb/wbClient.js';
import { db } from '../db/client.js';
import {
  wbDeductionsDaily,
  wbHiddenProducts,
  wbRegionSales,
  wbStocksDaily,
  wbSyncRuns,
  marketplaceShops,
} from '../db/schema.js';
import { eq, and } from 'drizzle-orm';

// ============================================================================
// Types for WB Report Data
// ============================================================================

interface HiddenProductItem {
  nmId: number;
  reason?: string;
  hiddenAt?: string;
}

interface DeductionItem {
  nmId?: number;
  date: string;
  type: string;
  amount: number;
  reason?: string;
  documentNumber?: string;
}

interface StorageItem {
  nmId: number;
  date: string;
  warehouseId?: number;
  warehouseName?: string;
  volume?: number;
  cost: number;
  days?: number;
}

interface RegionSaleItem {
  nmId: number;
  date: string;
  regionId?: number;
  regionName?: string;
  districtName?: string;
  orders: number;
  sales: number;
}

interface WarehouseRemainItem {
  nmId: number;
  vendorCode?: string;
  barcode?: string;
  techSize?: string;
  warehouseId?: number;
  warehouseName?: string;
  quantity: number;
  inWayToClient?: number;
  inWayFromClient?: number;
}


// ============================================================================
// Main Job Handler
// ============================================================================

interface ShopRunCounts {
  regions: number;
  deductions: number;
  warehouse: number;
  hidden: number;
}

async function processShopReportsDaily(
  shop: { workspaceId: number; shopId: number },
): Promise<ShopRunCounts> {
  const { workspaceId, shopId } = shop;
  const counts: ShopRunCounts = { regions: 0, deductions: 0, warehouse: 0, hidden: 0 };

  // Create per-shop sync run row. Bucket key in wbEndpointBucket is now
  // (workspace, sellerId, host, label), so shops belonging to DIFFERENT WB
  // sellers have independent budgets; shops belonging to the SAME WB seller
  // serialize on their shared bucket. Either way Promise.allSettled across
  // shops is safe and roughly cuts wall time to max(per-seller-time).
  const runId = `reports-daily-${workspaceId}-${shopId}-${Date.now()}`;
  const [syncRun] = await db.insert(wbSyncRuns)
    .values({
      runId,
      workspaceId,
      shopId,
      stage: 'reports-daily',
      status: 'running',
      startedAt: new Date(),
    })
    .returning();

  try {
    const apiKey = await getWbApiKey(workspaceId, shopId);

    // Date window: last 30 days for sync-style reports. WB enforces per-endpoint
    // rate limits at the wbClient layer; per-seller bucket means within one
    // seller these still serialize.
    const today = new Date();
    const dateTo = today.toISOString().slice(0, 10);
    const dateFrom = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    // 1) Region sales — direct GET, returns the city/region breakdown.
    try {
      const rows = await getRegionSales({ apiKey, workspaceId, shopId, dateFrom, dateTo });
      logger.info({ workspaceId, shopId, count: rows.length }, 'region-sales fetched');
      for (const r of rows) {
        // Existing schema only has (workspaceId, shopId, nmId, date, regionName,
        // districtName, orders, sales). WB returns no per-date breakdown — assign
        // today's date and store cityName in `districtName` for "город" filter
        // in the UI; aggregate by city if multiple rows per city.
        await db.insert(wbRegionSales).values({
          workspaceId,
          shopId,
          nmId: r.nmID,
          date: today,
          regionId: null,
          regionName: r.regionName || r.countryName || null,
          districtName: r.cityName || null,
          orders: Math.round(r.saleItemInvoiceQty ?? 0),
          sales: Math.round((r.saleInvoiceCostPrice ?? 0) * 100), // → kopecks
        }).onConflictDoNothing();
        counts.regions++;
      }
    } catch (e: any) {
      logger.warn({ workspaceId, shopId, err: e?.message }, 'region-sales fetch failed');
    }

    // 2) Deductions — substitutions + wrong-attachments. Paginate by limit/offset.
    try {
      const all: Array<Awaited<ReturnType<typeof getDeductions>>[number]> = [];
      for (let offset = 0; offset < 10000; offset += 1000) {
        const page = await getDeductions({
          apiKey, workspaceId, shopId,
          dateFrom: `${dateFrom}T00:00:00Z`, dateTo: `${dateTo}T23:59:59Z`,
          limit: 1000, offset,
        });
        all.push(...page);
        if (page.length < 1000) break;
      }
      logger.info({ workspaceId, shopId, count: all.length }, 'deductions fetched');
      for (const d of all) {
        await db.insert(wbDeductionsDaily).values({
          workspaceId,
          shopId,
          nmId: d.nmId ?? null,
          date: new Date(d.dtBonus),
          type: d.bonusType ?? 'unknown',
          amount: Math.round((d.bonusSumm ?? 0) * 100),
          reason: null,
          documentNumber: null,
        });
        counts.deductions++;
      }
    } catch (e: any) {
      logger.warn({ workspaceId, shopId, err: e?.message }, 'deductions fetch failed');
    }

      // 4) Banned products — blocked + shadowed cards. Upsert into
      //    wb_hidden_products so previously-hidden items get marked
      //    resolved when WB no longer returns them.
      try {
        const banned = await getBannedProducts({ apiKey, workspaceId, shopId });
        logger.info({ workspaceId, shopId, count: banned.length }, 'banned-products fetched');

        // Mark all currently-recorded as potentially resolved; the upserts
        // below will flip back is_resolved=false for ones still banned.
        await db.update(wbHiddenProducts)
          .set({ isResolved: true, resolvedAt: new Date() })
          .where(and(
            eq(wbHiddenProducts.workspaceId, workspaceId),
            eq(wbHiddenProducts.isResolved, false),
          ));

        for (const b of banned) {
          await db.insert(wbHiddenProducts).values({
            workspaceId,
            shopId,
            nmId: b.nmId,
            reason: b.reason || null,
            hiddenAt: null,
            isResolved: false,
            resolvedAt: null,
          }).onConflictDoUpdate({
            target: [wbHiddenProducts.workspaceId, wbHiddenProducts.nmId],
            set: {
              shopId,
              reason: b.reason || null,
              isResolved: false,
              resolvedAt: null,
            },
          });
          counts.hidden++;
        }
      } catch (e: any) {
        logger.warn({ workspaceId, shopId, err: e?.message }, 'banned-products fetch failed');
      }

      // 3) Warehouse remains — async 3-step, gives current FBO stocks per warehouse.
      // Run with groupByNm=true (default) so each row is one nmId × warehouse.
      try {
        const items = await runWarehouseRemains({ apiKey, workspaceId, shopId });
        logger.info({ workspaceId, shopId, count: items.length }, 'warehouse-remains fetched');
        const todayStart = new Date(today.getTime());
        todayStart.setUTCHours(0, 0, 0, 0);
        for (const it of items) {
          // wb_stocks_daily stores per-warehouse breakdown if items.warehouses[] is set
          if (Array.isArray(it.warehouses)) {
            for (const w of it.warehouses) {
              await db.insert(wbStocksDaily).values({
                workspaceId, shopId,
                nmId: it.nmId,
                date: todayStart,
                warehouseId: null,
                warehouseName: w.warehouseName || null,
                qty: w.quantity || 0,
              }).onConflictDoNothing();
              counts.warehouse++;
            }
          } else {
            await db.insert(wbStocksDaily).values({
              workspaceId, shopId,
              nmId: it.nmId,
              date: todayStart,
              warehouseId: null,
              warehouseName: 'all',
              qty: it.quantityWarehousesFull || 0,
            }).onConflictDoNothing();
            counts.warehouse++;
          }
        }
      } catch (e: any) {
        logger.warn({ workspaceId, shopId, err: e?.message }, 'warehouse-remains fetch failed');
      }

    await db.update(wbSyncRuns)
      .set({
        status: 'done',
        finishedAt: new Date(),
        rowsWritten: counts.regions + counts.deductions + counts.warehouse + counts.hidden,
      })
      .where(eq(wbSyncRuns.runId, syncRun.runId));

    return counts;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ workspaceId, shopId, message }, 'reportsDailySync error for shop');

    await db.update(wbSyncRuns)
      .set({
        status: 'error',
        error: message,
        finishedAt: new Date(),
      })
      .where(eq(wbSyncRuns.runId, syncRun.runId));

    throw err;
  }
}

export async function runReportsDailySync(): Promise<void> {
  logger.info('starting daily reports sync');
  const startTime = Date.now();

  // Get all active workspaces with WB shops
  const activeShops = await db
    .select({
      workspaceId: marketplaceShops.workspaceId,
      shopId: marketplaceShops.shopId,
    })
    .from(marketplaceShops)
    .where(and(
      eq(marketplaceShops.platform, 'wb'),
      eq(marketplaceShops.isActive, true)
    ));

  logger.info({ count: activeShops.length }, 'found active WB shops');

  // Run all shops concurrently. Per-endpoint quotas in wbEndpointBucket are
  // keyed by (workspace, sellerId, host, label), so:
  //   - Shops belonging to DIFFERENT WB sellers run with truly independent
  //     budgets — total wall time collapses to max(per-seller-time).
  //   - Shops belonging to the SAME WB seller serialize on their shared
  //     bucket (the wait/throw logic inside acquireEndpoint handles this).
  // Promise.allSettled keeps a failing shop from blocking the others; each
  // processShopReportsDaily writes its own wb_sync_runs row.
  const results = await Promise.allSettled(
    activeShops.map((shop) => processShopReportsDaily(shop)),
  );

  let totalRegions = 0, totalDeductions = 0, totalWarehouse = 0, totalHidden = 0, errors = 0;
  for (const r of results) {
    if (r.status === 'fulfilled') {
      totalRegions   += r.value.regions;
      totalDeductions += r.value.deductions;
      totalWarehouse  += r.value.warehouse;
      totalHidden     += r.value.hidden;
    } else {
      errors++;
    }
  }

  const elapsed = Date.now() - startTime;
  logger.info(
    { elapsedMs: elapsed, totalHidden, totalDeductions, totalRegions, totalWarehouse, errors, shops: activeShops.length },
    'reportsDailySync completed',
  );
}

// ============================================================================
// Job Registration
// ============================================================================

export function registerReportsDailySync(): void {
  registerJob({
    name: 'REPORTS_DAILY_SYNC',
    cron: '0 6 * * *',  // 06:00 MSK daily
    enabled: process.env.ENABLE_REPORTS_DAILY_SYNC !== '0',
    handler: runReportsDailySync,
  });
}
