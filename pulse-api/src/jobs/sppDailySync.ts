import { db } from '../db/client.js';
import { eq, and, desc, like } from 'drizzle-orm';
import { wbSyncRuns, marketplaceShops } from '../db/schema.js';
import { getQueue, JOB_SPP_WEEKLY } from './queue.js';
import { forEachWorkspace } from './workspaceIterator.js';
import { spawnAndWait } from '../lib/spawnWithTracking.js';
import { logJobs as logger } from '../lib/logger.js';

type Config = {
  enabled: boolean;
  daysBack: number;
  minIntervalHours: number;
};

export function getSppDailySyncConfig(): Config {
  const enabled = (process.env.ENABLE_SPP_DAILY_SYNC ?? '') === '1';
  const daysBack = Number.parseInt(process.env.SPP_SYNC_DAYS_BACK || '2', 10);
  const minIntervalHours = Number.parseInt(process.env.SPP_SYNC_MIN_INTERVAL_HOURS || '20', 10);
  return { enabled, daysBack, minIntervalHours };
}

export async function startSppSyncForWorkspace(
  workspaceId: number,
  reason: string,
  cfg: Config,
  overrideShopId?: number,
): Promise<{ started: boolean; message: string }> {
  const runs = await db
    .select({ createdAt: wbSyncRuns.createdAt, stage: wbSyncRuns.stage })
    .from(wbSyncRuns)
    // F-017b: dedup only on completed runs.
    .where(and(eq(wbSyncRuns.workspaceId, workspaceId), like(wbSyncRuns.stage, 'spp-weekly:%'), eq(wbSyncRuns.status, 'completed')))
    .orderBy(desc(wbSyncRuns.createdAt))
    .limit(1);

  const last = runs[0];
  if (last?.createdAt) {
    const ageMs = Date.now() - new Date(last.createdAt).getTime();
    if (ageMs < cfg.minIntervalHours * 3600 * 1000) {
      return { started: false, message: `skip: last run too recent (${last.stage})` };
    }
  }

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

  const { randomUUID } = await import('node:crypto');
  const runId = randomUUID();

  await db.insert(wbSyncRuns).values({
    runId,
    workspaceId,
    shopId: shopId ?? null,
    stage: `spp-weekly:scheduled:${cfg.daysBack}d:${reason}`,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const env: Record<string, string> = {
    WORKSPACE_ID: String(workspaceId),
    DAYS_BACK: String(cfg.daysBack),
    WB_REPORT_PERIOD: 'daily',
    RUN_ID: runId,
  };
  if (shopId) env.SHOP_ID = String(shopId);

  // Run with tracking — await so pg-boss detects failures
  const result = await spawnAndWait(runId, workspaceId, 'spp-weekly', {
    command: 'npx',
    args: ['tsx', 'src/integrations/wb/sppWeekly.toDb.ts'],
    env,
    logPrefix: 'wb-spp-weekly',
    timeoutMs: 30 * 60 * 1000, // 30 minutes
  });

  if (!result.success) {
    throw new Error(`spp-weekly sync failed (code=${result.code})`);
  }

  return { started: true, message: `completed runId=${runId}, ${result.durationMs}ms` };
}

export async function maybeStartSppWeeklySync(reason: string): Promise<Map<number, { started: boolean; message: string } | Error>> {
  const cfg = getSppDailySyncConfig();
  if (!cfg.enabled) {
    return new Map([[0, { started: false, message: 'disabled' }]]);
  }

  // Multi-shop: iterate all active shops per workspace
  return forEachWorkspace(
    { overrideEnvVar: 'SPP_SYNC_WORKSPACE_ID' },
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
          const r = await startSppSyncForWorkspace(workspaceId, reason, cfg, shop.shopId);
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

export async function registerSppDailySyncJob(): Promise<void> {
  const cfg = getSppDailySyncConfig();
  if (!cfg.enabled) {
    logger.info('sppDailySync disabled, skipping pg-boss registration');
    return;
  }

  const boss = await getQueue();
  await boss.createQueue(JOB_SPP_WEEKLY);

  // Schedule: run once every 24 hours at 4:00 MSK
  await boss.schedule(JOB_SPP_WEEKLY, '0 4 * * *', {}, {
    tz: 'Europe/Moscow',
  });

  await boss.work(JOB_SPP_WEEKLY, { localConcurrency: 1 }, async () => {
    try {
      logger.info('sppDailySync pg-boss triggered');
      const results = await maybeStartSppWeeklySync('pg-boss');
      for (const [wsId, result] of results) {
        if (result instanceof Error) {
          logger.error({ err: result, workspaceId: wsId }, 'sppDailySync workspace error');
        } else {
          logger.info({ workspaceId: wsId, message: result.message }, 'sppDailySync workspace result');
        }
      }
    } catch (err) {
      logger.error({ err }, 'sppDailySync work handler error');
    }
  });

  logger.info('sppDailySync registered via pg-boss (cron 0 4 * * * MSK) all workspaces');
}
