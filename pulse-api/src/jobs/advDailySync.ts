import { db } from '../db/client.js';
import { eq, and, desc, like } from 'drizzle-orm';
import { wbSyncRuns, marketplaceShops } from '../db/schema.js';
import { getQueue, JOB_ADV_DAILY_SYNC } from './queue.js';
import { forEachWorkspace } from './workspaceIterator.js';
import { spawnSequence } from '../lib/spawnWithTracking.js';
import { logJobs as logger } from '../lib/logger.js';

type Config = {
  enabled: boolean;
  daysBack: number;
  activeWithinDays: number;
  minIntervalHours: number;
};

export function getAdvDailySyncConfig(): Config {
  const enabled = (process.env.ENABLE_ADV_DAILY_SYNC ?? '') === '1';
  const daysBack = Number.parseInt(process.env.ADV_SYNC_DAYS_BACK || '2', 10);
  const activeWithinDays = Number.parseInt(process.env.ADV_SYNC_ACTIVE_WITHIN_DAYS || '90', 10);
  const minIntervalHours = Number.parseInt(process.env.ADV_SYNC_MIN_INTERVAL_HOURS || '20', 10);
  return { enabled, daysBack, activeWithinDays, minIntervalHours };
}

export async function startAdvSyncForWorkspace(
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
      like(wbSyncRuns.stage, 'adv-daily:%'),
      // F-017b: dedup only on completed runs — failed/orphan must not block retry.
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
    stage: `adv-daily:scheduled:${cfg.daysBack}d:${reason}`,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // Run sync steps with proper tracking (no more fire-and-forget)
  const baseEnv: Record<string, string> = {
    WORKSPACE_ID: String(workspaceId),
    DAYS_BACK: String(cfg.daysBack),
    ACTIVE_WITHIN_DAYS: String(cfg.activeWithinDays),
    RUN_ID: runId,
  };
  if (shopId) baseEnv.SHOP_ID = String(shopId);

  // Run with tracking and await completion so pg-boss can detect failures
  const result = await spawnSequence(runId, workspaceId, 'adv-daily', [
    {
      name: 'spend',
      config: {
        command: 'npx',
        args: ['tsx', 'src/integrations/wb/advSpend.toDb.ts'],
        env: baseEnv,
        logPrefix: 'wb-adv-spend',
        timeoutMs: 20 * 60 * 1000, // 20 minutes
      },
    },
    {
      name: 'products',
      config: {
        command: 'npx',
        args: ['tsx', 'src/integrations/wb/advSpendProducts.toDb.ts'],
        env: baseEnv,
        logPrefix: 'wb-adv-products',
        timeoutMs: 20 * 60 * 1000, // 20 minutes
      },
    },
  ]);

  if (!result.success) {
    throw new Error(`adv-daily sync failed at step: ${result.failedStep}`);
  }

  return { started: true, message: `completed runId=${runId}` };
}

export async function maybeStartAdvDailySync(reason: string): Promise<Map<number, { started: boolean; message: string } | Error>> {
  const cfg = getAdvDailySyncConfig();
  if (!cfg.enabled) {
    return new Map([[0, { started: false, message: 'disabled' }]]);
  }

  // Multi-shop: iterate all active shops per workspace
  return forEachWorkspace(
    { overrideEnvVar: 'ADV_SYNC_WORKSPACE_ID' },
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
          const r = await startAdvSyncForWorkspace(workspaceId, reason, cfg, shop.shopId);
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

export async function registerAdvDailySyncJob(): Promise<void> {
  const cfg = getAdvDailySyncConfig();
  if (!cfg.enabled) {
    logger.info('Disabled, skipping pg-boss registration');
    return;
  }

  const boss = await getQueue();
  await boss.createQueue(JOB_ADV_DAILY_SYNC);

  await boss.schedule(JOB_ADV_DAILY_SYNC, '0 2 * * *', {}, {
    tz: 'Europe/Moscow',
  });

  await boss.work(JOB_ADV_DAILY_SYNC, { localConcurrency: 1 }, async () => {
    try {
      logger.info('pg-boss triggered');
      const results = await maybeStartAdvDailySync('pg-boss');
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

  logger.info('Registered via pg-boss (cron 0 2 * * * MSK) all workspaces');
}
