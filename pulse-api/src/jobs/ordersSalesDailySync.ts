import { db } from '../db/client.js';
import { eq, and, desc, like } from 'drizzle-orm';
import { wbSyncRuns, marketplaceShops } from '../db/schema.js';
import { getQueue, JOB_ORDERS_SALES_SYNC } from './queue.js';
import { forEachWorkspace } from './workspaceIterator.js';
import { spawnAndWait } from '../lib/spawnWithTracking.js';
import { logJobs as logger } from '../lib/logger.js';

type Config = {
  enabled: boolean;
  daysBack: number;
  minIntervalHours: number;
};

export function getOrdersSalesSyncConfig(): Config {
  const enabled = (process.env.ENABLE_ORDERS_SALES_SYNC ?? '') === '1';
  const daysBack = Number.parseInt(process.env.ORDERS_SALES_SYNC_DAYS_BACK || '2', 10);
  const minIntervalHours = Number.parseInt(process.env.ORDERS_SALES_SYNC_MIN_INTERVAL_HOURS || '3', 10);
  return { enabled, daysBack, minIntervalHours };
}

export async function startOrdersSalesSyncForWorkspace(
  workspaceId: number,
  reason: string,
  cfg: Config,
  overrideShopId?: number,
): Promise<{ started: boolean; message: string }> {
  const runs = await db
    .select({ createdAt: wbSyncRuns.createdAt, stage: wbSyncRuns.stage })
    .from(wbSyncRuns)
    .where(and(
      eq(wbSyncRuns.workspaceId, workspaceId),
      like(wbSyncRuns.stage, 'orders-sales:%'),
      // F-017b: dedup only on completed runs.
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
    stage: `orders-sales:scheduled:${cfg.daysBack}d:${reason}`,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // Run with tracking — await so pg-boss detects failures
  const env: Record<string, string> = {
    WORKSPACE_ID: String(workspaceId),
    DAYS_BACK: String(cfg.daysBack),
    RUN_ID: runId,
  };
  if (shopId) env.SHOP_ID = String(shopId);

  const result = await spawnAndWait(runId, workspaceId, 'orders-sales', {
    command: 'npx',
    args: ['tsx', 'src/integrations/wb/ordersSales.toDb.ts'],
    env,
    logPrefix: 'wb-orders-sales',
    timeoutMs: 30 * 60 * 1000, // 30 minutes
  });

  if (!result.success) {
    throw new Error(`orders-sales sync failed (code=${result.code})`);
  }

  return { started: true, message: `completed runId=${runId}, ${result.durationMs}ms` };
}

export async function maybeStartOrdersSalesSync(reason: string): Promise<Map<number, { started: boolean; message: string } | Error>> {
  const cfg = getOrdersSalesSyncConfig();
  if (!cfg.enabled) {
    return new Map([[0, { started: false, message: 'disabled' }]]);
  }

  // Multi-shop: iterate all active shops per workspace
  return forEachWorkspace(
    { overrideEnvVar: 'ORDERS_SALES_SYNC_WORKSPACE_ID' },
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
          const r = await startOrdersSalesSyncForWorkspace(workspaceId, reason, cfg, shop.shopId);
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

export async function registerOrdersSalesSyncJob(): Promise<void> {
  const cfg = getOrdersSalesSyncConfig();
  if (!cfg.enabled) {
    logger.info('Disabled, skipping pg-boss registration');
    return;
  }

  const boss = await getQueue();
  await boss.createQueue(JOB_ORDERS_SALES_SYNC);

  await boss.schedule(JOB_ORDERS_SALES_SYNC, '0 */3 * * *', {}, {
    tz: 'Europe/Moscow',
  });

  await boss.work(JOB_ORDERS_SALES_SYNC, { localConcurrency: 1 }, async () => {
    try {
      logger.info('pg-boss triggered');
      const results = await maybeStartOrdersSalesSync('pg-boss');
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

  logger.info('Registered via pg-boss (cron 0 */3 * * * MSK) all workspaces');
}
