/**
 * Search Queries Daily Sync Job
 * 
 * Syncs search report data from WB to wb_search_queries table
 * 
 * Cron: 0 4 * * * (04:00 MSK)
 * Rate limit: 3 req/min on seller-analytics-api
 */

import { registerJob, JOBS } from './scheduler.js';
import { getWbApiKey } from '../integrations/wb/wbClient.js';
import { logJobs as logger } from '../lib/logger.js';
import { getSearchReport, getProductSearchTexts } from '../integrations/wb/searchReport.js';
import { db } from '../db/client.js';
import { 
  wbSearchQueries,
  wbSyncRuns,
  workspaces,
  marketplaceShops,
} from '../db/schema.js';
import { eq, and, sql } from 'drizzle-orm';

const ENABLE_SEARCH_QUERIES_SYNC = process.env.ENABLE_SEARCH_QUERIES_SYNC !== 'false';

// Rate limit helper - 20 seconds between requests
async function rateLimitedSleep() {
  await new Promise(resolve => setTimeout(resolve, 20000));
}

export function registerSearchQueriesSyncJob() {
  if (!ENABLE_SEARCH_QUERIES_SYNC) {
    logger.info('searchQueriesSync job disabled via ENABLE_SEARCH_QUERIES_SYNC=false');
    return;
  }

  registerJob({
    name: JOBS.SEARCH_QUERIES_SYNC,
    cron: '0 4 * * *', // 04:00 daily
    handler: runSearchQueriesSync,
    enabled: true,
  });

  logger.info('searchQueriesSync job registered, cron: 0 4 * * *');
}

async function runSearchQueriesSync() {
  logger.info('searchQueriesSync starting daily sync');
  const startTime = Date.now();

  // Iterate per-shop — WB API v2 нуждается в `nmIds[]` и мы пишем shop_id,
  // поэтому группировка по shop'у обязательна.
  const activeShops = await db
    .select({
      workspaceId: marketplaceShops.workspaceId,
      shopId: marketplaceShops.shopId,
    })
    .from(marketplaceShops)
    .where(
      and(
        eq(marketplaceShops.platform, 'wb'),
        eq(marketplaceShops.isActive, true)
      )
    );

  logger.info({ count: activeShops.length }, 'found active WB shops');

  let totalQueries = 0;
  let errors = 0;

  // Yesterday's date for report
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = yesterday.toISOString().slice(0, 10);

  // WB v2 product/search-texts: max 30 nmIds per call (100 для Джем-тарифа).
  const NM_BATCH = 30;
  // Top-50 товаров с магазина — баланс покрытия и rate limit'а.
  const MAX_PRODUCTS = 50;

  for (const shop of activeShops) {
    const { workspaceId, shopId } = shop;

    const runId = `search-queries-${workspaceId}-${shopId}-${Date.now()}`;
    const [syncRun] = await db.insert(wbSyncRuns)
      .values({
        runId,
        workspaceId,
        shopId,
        stage: 'search-queries',
        status: 'running',
        startedAt: new Date(),
      })
      .returning();

    try {
      const apiKey = await getWbApiKey(workspaceId, shopId);
      if (!apiKey) {
        throw new Error('No API key');
      }

      let items: Awaited<ReturnType<typeof getSearchReport>>['data'] = [];
      try {
        const report = await getSearchReport(apiKey, {
          dateFrom: dateStr,
          dateTo: dateStr,
          limit: 1000,
        });
        items = report.data || [];
      } catch (reportErr) {
        const msg = reportErr instanceof Error ? reportErr.message : String(reportErr);
        // WB Analytics v2 требует тариф Jam. На остальных тарифах эндпоинт
        // возвращает 403 "Available only in a Jam subscription" — это
        // ограничение подписки, а не поломка кода. Завершаем run статусом
        // `skipped` без спама в error'ы.
        if (/Jam subscription|available only in a jam/i.test(msg) || /403/.test(msg)) {
          logger.warn({ workspaceId, shopId }, 'searchQueriesSync: skipping shop — WB Analytics v2 requires Jam subscription');
          await db.update(wbSyncRuns)
            .set({ status: 'skipped', error: 'no_jam_subscription', finishedAt: new Date() })
            .where(eq(wbSyncRuns.runId, syncRun.runId));
          continue;
        }
        throw reportErr;
      }
      logger.info({ workspaceId, shopId, productCount: items.length }, 'searchQueriesSync shop products');

      const nmIds = items.slice(0, MAX_PRODUCTS).map((i) => i.nmId);
      for (let i = 0; i < nmIds.length; i += NM_BATCH) {
        const batch = nmIds.slice(i, i + NM_BATCH);
        if (i > 0) await rateLimitedSleep();

        try {
          const texts = await getProductSearchTexts(apiKey, {
            dateFrom: dateStr,
            dateTo: dateStr,
            nmIds: batch,
            limit: 30,
          });

          for (const q of texts.data || []) {
            if (!q.nmId || !q.text) continue;
            await db
              .insert(wbSearchQueries)
              .values({
                workspaceId,
                shopId,
                nmId: q.nmId,
                date: new Date(dateStr),
                query: q.text,
                position: Math.round(q.avgPosition || 0),
                views: q.openCardCount || 0,
                clicks: q.addToCartCount || 0,
                orders: q.ordersCount || 0,
                ctr: q.openCardCount > 0
                  ? (q.addToCartCount / q.openCardCount) * 100
                  : 0,
              })
              .onConflictDoNothing();
            totalQueries++;
          }
        } catch (e) {
          logger.error({ err: e, workspaceId, shopId, batchSize: batch.length }, 'searchQueriesSync batch failed');
        }
      }

      await db.update(wbSyncRuns)
        .set({ status: 'done', finishedAt: new Date() })
        .where(eq(wbSyncRuns.runId, syncRun.runId));

    } catch (err) {
      errors++;
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ workspaceId, shopId, message }, 'searchQueriesSync error for shop');

      await db.update(wbSyncRuns)
        .set({ status: 'error', error: message, finishedAt: new Date() })
        .where(eq(wbSyncRuns.runId, syncRun.runId));
    }
  }

  const elapsed = Date.now() - startTime;
  logger.info({ elapsedMs: elapsed, totalQueries, errors }, 'searchQueriesSync completed');
}

// Export for manual trigger
export { runSearchQueriesSync };
