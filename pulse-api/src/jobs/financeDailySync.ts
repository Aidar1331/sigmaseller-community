import { db } from '../db/client.js';
import { eq, and, desc, like } from 'drizzle-orm';
import { wbSyncRuns, marketplaceShops } from '../db/schema.js';
import { getQueue, JOB_FINANCE_WEEKLY_PRODUCTS } from './queue.js';
import { forEachWorkspace } from './workspaceIterator.js';
import { spawnAndWait } from '../lib/spawnWithTracking.js';
import { logJobs as logger } from '../lib/logger.js';

type Config = {
  enabled: boolean;
  daysBack: number;
  windowDays: number;
  minIntervalHours: number;
};

export function getFinanceDailySyncConfig(): Config {
  const enabled = (process.env.ENABLE_FINANCE_DAILY_SYNC ?? '') === '1';
  const daysBack = Number.parseInt(process.env.FINANCE_SYNC_DAYS_BACK || '7', 10);
  const windowDays = Number.parseInt(process.env.FINANCE_SYNC_WINDOW_DAYS || '60', 10);
  const minIntervalHours = Number.parseInt(process.env.FINANCE_SYNC_MIN_INTERVAL_HOURS || '20', 10);
  return { enabled, daysBack, windowDays, minIntervalHours };
}

export async function startFinanceSyncForWorkspace(
  workspaceId: number,
  reason: string,
  cfg: Config,
  overrideShopId?: number,
): Promise<{ started: boolean; message: string }> {
  // F-017b: dedup only on SUCCESSFUL runs. A failed run (orphan, SIGTERM, 5xx)
  // must not block retry for 20h — otherwise a new shop that has one failure
  // never recovers until the next day. The completed-only filter ensures
  // back-to-back retries are allowed while still throttling healthy shops.
  const runs = await db
    .select({ createdAt: wbSyncRuns.createdAt, stage: wbSyncRuns.stage })
    .from(wbSyncRuns)
    .where(and(
      eq(wbSyncRuns.workspaceId, workspaceId),
      like(wbSyncRuns.stage, 'finance-weekly-products:%'),
      eq(wbSyncRuns.status, 'completed'),
      ...(overrideShopId ? [eq(wbSyncRuns.shopId, overrideShopId)] : []),
    ))
    .orderBy(desc(wbSyncRuns.createdAt))
    .limit(1);

  const last = runs[0];
  if (last?.createdAt) {
    const ageMs = Date.now() - new Date(last.createdAt).getTime();
    if (ageMs < cfg.minIntervalHours * 3600 * 1000) {
      return { started: false, message: `skip: last run too recent (${last.stage})` };
    }
  }

  const { randomUUID } = await import('node:crypto');
  const runId = randomUUID();

  // Resolve shopId before creating run so it's recorded in wbSyncRuns
  let shopId = overrideShopId;
  if (!shopId) {
    const shops = await db
      .select({ shopId: marketplaceShops.shopId })
      .from(marketplaceShops)
      .where(and(eq(marketplaceShops.workspaceId, workspaceId), eq(marketplaceShops.isActive, true)))
      .limit(1);
    shopId = shops[0]?.shopId;
  }

  await db.insert(wbSyncRuns).values({
    runId,
    workspaceId,
    shopId: shopId ?? null,
    stage: `finance-weekly-products:scheduled:${cfg.daysBack}d:${reason}`,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const env: Record<string, string> = {
    WORKSPACE_ID: String(workspaceId),
    DAYS_BACK: String(cfg.daysBack),
    WINDOW_DAYS: String(cfg.windowDays),
    RUN_ID: runId,
  };
  if (shopId) env.SHOP_ID = String(shopId);

  // Run with proper tracking — await so pg-boss detects failures
  const result = await spawnAndWait(runId, workspaceId, 'finance-weekly-products', {
    command: 'npx',
    args: ['tsx', 'src/integrations/wb/financeWeeklyProducts.toDb.ts'],
    env,
    logPrefix: 'wb-finance-weekly-products',
    timeoutMs: 45 * 60 * 1000, // 45 minutes
  });

  if (!result.success) {
    throw new Error(`finance-weekly-products sync failed (code=${result.code})`);
  }

  return { started: true, message: `completed runId=${runId}, ${result.durationMs}ms` };
}

export async function maybeStartFinanceWeeklyProductsSync(reason: string): Promise<Map<number, { started: boolean; message: string } | Error>> {
  const cfg = getFinanceDailySyncConfig();
  if (!cfg.enabled) {
    return new Map([[0, { started: false, message: 'disabled' }]]);
  }

  // Multi-shop: iterate all active shops per workspace
  return forEachWorkspace(
    { overrideEnvVar: 'FINANCE_SYNC_WORKSPACE_ID' },
    async (workspaceId) => {
      const shops = await db
        .select({ shopId: marketplaceShops.shopId })
        .from(marketplaceShops)
        .where(and(eq(marketplaceShops.workspaceId, workspaceId), eq(marketplaceShops.isActive, true)));

      if (shops.length === 0) {
        return { started: false, message: 'no active shops' };
      }

      const results: string[] = [];
      for (const shop of shops) {
        try {
          const r = await startFinanceSyncForWorkspace(workspaceId, reason, cfg, shop.shopId);
          results.push(`shop ${shop.shopId}: ${r.message}`);
        } catch (err: any) {
          results.push(`shop ${shop.shopId}: error: ${err.message}`);
        }
      }
      return { started: true, message: results.join('; ') };
    }
  );
}

/**
 * Daily finance aggregation (wb_finance_daily).
 *
 * Uses WB `reportDetailByPeriod` — same endpoint as weekly-products, but the
 * per-row script (`src/integrations/wb/finance.toDb.ts`) groups by `rr_dt`
 * (recognized-revenue date) so we get one row per day with penalty / storage /
 * commission / payout totals. This is what ДДС and the financial-report view
 * read from.
 *
 * Runs every 4 hours so the UI stays in sync with WB's intra-week updates
 * without waiting for a manual "Обновить" click.
 */
async function startFinanceDailyForShop(
  workspaceId: number,
  reason: string,
  cfg: Config,
  shopId: number,
): Promise<{ started: boolean; message: string }> {
  if (!cfg.enabled) return { started: false, message: 'disabled' };

  const { randomUUID } = await import('node:crypto');
  const runId = randomUUID();
  await db.insert(wbSyncRuns).values({
    runId,
    workspaceId,
    shopId,
    stage: `finance-daily:scheduled:${cfg.daysBack}d:${reason}`,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const env: Record<string, string> = {
    WORKSPACE_ID: String(workspaceId),
    DAYS_BACK: String(cfg.daysBack),
    WINDOW_DAYS: String(cfg.windowDays),
    RUN_ID: runId,
    SHOP_ID: String(shopId),
  };

  const result = await spawnAndWait(runId, workspaceId, 'finance-daily', {
    command: 'npx',
    args: ['tsx', 'src/integrations/wb/finance.toDb.ts'],
    env,
    logPrefix: 'wb-finance-daily',
    timeoutMs: 30 * 60 * 1000,
  });

  if (!result.success) {
    throw new Error(`finance-daily sync failed (code=${result.code})`);
  }

  return { started: true, message: `completed runId=${runId}, ${result.durationMs}ms` };
}

export async function maybeStartFinanceDailySync(
  reason: string,
): Promise<Map<number, { started: boolean; message: string } | Error>> {
  const cfg = getFinanceDailySyncConfig();
  if (!cfg.enabled) {
    return new Map([[0, { started: false, message: 'disabled' }]]);
  }

  return forEachWorkspace(
    { overrideEnvVar: 'FINANCE_SYNC_WORKSPACE_ID' },
    async (workspaceId) => {
      const shops = await db
        .select({ shopId: marketplaceShops.shopId })
        .from(marketplaceShops)
        .where(and(eq(marketplaceShops.workspaceId, workspaceId), eq(marketplaceShops.isActive, true)));

      if (shops.length === 0) {
        return { started: false, message: 'no active shops' };
      }

      const results: string[] = [];
      for (const shop of shops) {
        try {
          const r = await startFinanceDailyForShop(workspaceId, reason, cfg, shop.shopId);
          results.push(`shop ${shop.shopId}: ${r.message}`);
        } catch (err: any) {
          results.push(`shop ${shop.shopId}: error: ${err.message}`);
        }
      }
      return { started: true, message: results.join('; ') };
    }
  );
}

/* ─── pg-boss scheduler ─── */

export async function registerFinanceDailySyncJob(): Promise<void> {
  const cfg = getFinanceDailySyncConfig();
  if (!cfg.enabled) {
    logger.info('Disabled, skipping pg-boss registration');
    return;
  }

  const boss = await getQueue();
  await boss.createQueue(JOB_FINANCE_WEEKLY_PRODUCTS);

  // Schedule: run once every 24 hours
  await boss.schedule(JOB_FINANCE_WEEKLY_PRODUCTS, '0 3 * * *', {}, {
    tz: 'Europe/Moscow',
  });

  await boss.work(JOB_FINANCE_WEEKLY_PRODUCTS, { localConcurrency: 1 }, async () => {
    try {
      logger.info('pg-boss triggered');
      const results = await maybeStartFinanceWeeklyProductsSync('pg-boss');
      for (const [wsId, result] of results) {
        if (result instanceof Error) {
          logger.error({ err: result, workspaceId: wsId }, 'Workspace error');
        } else {
          logger.info({ workspaceId: wsId, message: result.message }, 'Workspace result');
        }
      }
    } catch (err) {
      logger.error({ err }, 'Work handler error');
    }
  });

  logger.info('Registered via pg-boss (cron 0 3 * * * MSK) all workspaces');
}
