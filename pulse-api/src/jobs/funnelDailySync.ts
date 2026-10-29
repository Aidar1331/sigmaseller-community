import { db } from '../db/client.js';
import { eq, and, desc, like } from 'drizzle-orm';
import { wbSyncRuns, marketplaceShops } from '../db/schema.js';
import { getQueue, JOB_FUNNEL_DAILY_SYNC } from './queue.js';
import { forEachWorkspace } from './workspaceIterator.js';
import { spawnSequence } from '../lib/spawnWithTracking.js';
import { logJobs as logger } from '../lib/logger.js';

type Config = {
  enabled: boolean;
  daysBack?: number;
  minIntervalHours: number;
};

export function getFunnelDailySyncConfig(): Config {
  const enabled = (process.env.ENABLE_FUNNEL_DAILY_SYNC ?? '') === '1';
  const minIntervalHours = Number.parseInt(process.env.FUNNEL_SYNC_MIN_INTERVAL_HOURS || '20', 10);
  return { enabled, minIntervalHours };
}

export async function startFunnelSyncForWorkspace(
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
      like(wbSyncRuns.stage, 'funnel-daily:%'),
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
    stage: `funnel-daily:scheduled:${reason}`,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // Run multi-step sync with proper tracking
  const baseEnv: Record<string, string> = {
    WORKSPACE_ID: String(workspaceId),
    RUN_ID: runId,
  };
  if (shopId) baseEnv.SHOP_ID = String(shopId);

  const result = await spawnSequence(runId, workspaceId, 'funnel-daily', [
    {
      name: 'history',
      config: {
        command: 'npx',
        args: ['tsx', 'src/integrations/wb/funnelHistory7d.toDb.ts'],
        env: baseEnv,
        logPrefix: 'wb-funnel-history',
        // 3h: history backfill iterates many days × multiple shops × WB
        // rate limit. Old 15m killed it mid-backfill (SIGTERM in logs),
        // so the table stayed empty. Checkpoint-resume is supported, but
        // a longer timeout lets us finish the initial fill in fewer
        // restart cycles.
        timeoutMs: 3 * 60 * 60 * 1000,
      },
    },
    {
      name: 'products',
      config: {
        command: 'npx',
        args: ['tsx', 'src/integrations/wb/funnelProductsDaily.toDb.ts'],
        env: {
          ...baseEnv,
          DAYS_BACK_LIST: String(cfg.daysBack ?? 1),
          LIMIT: '1000',
          RATE_DELAY_MS: '21000',
        },
        logPrefix: 'wb-funnel-products',
        // 2h: per-day fan-out of products × many days. WB rate-limiter
        // also stretches the call time during full-history backfill.
        timeoutMs: 2 * 60 * 60 * 1000,
      },
    },
  ]);

  if (!result.success) {
    throw new Error(`funnel-daily sync failed at step: ${result.failedStep}`);
  }

  return { started: true, message: `completed runId=${runId}` };
}

export async function maybeStartFunnelDailySync(reason: string): Promise<Map<number, { started: boolean; message: string } | Error>> {
  const cfg = getFunnelDailySyncConfig();
  if (!cfg.enabled) {
    return new Map([[0, { started: false, message: 'disabled' }]]);
  }

  // Multi-shop: iterate all active shops per workspace
  return forEachWorkspace(
    { overrideEnvVar: 'FUNNEL_SYNC_WORKSPACE_ID' },
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
          const r = await startFunnelSyncForWorkspace(workspaceId, reason, cfg, shop.shopId);
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

export async function registerFunnelDailySyncJob(): Promise<void> {
  const cfg = getFunnelDailySyncConfig();
  if (!cfg.enabled) {
    logger.info('funnelDailySync disabled, skipping pg-boss registration');
    return;
  }

  const boss = await getQueue();
  await boss.createQueue(JOB_FUNNEL_DAILY_SYNC);

  await boss.schedule(JOB_FUNNEL_DAILY_SYNC, '0 5 * * *', {}, {
    tz: 'Europe/Moscow',
  });

  await boss.work(JOB_FUNNEL_DAILY_SYNC, { localConcurrency: 1 }, async () => {
    try {
      logger.info('funnelDailySync pg-boss triggered');
      const results = await maybeStartFunnelDailySync('pg-boss');
      for (const [wsId, result] of results) {
        if (result instanceof Error) {
          logger.error({ err: result, workspaceId: wsId }, 'funnelDailySync workspace error');
        } else {
          logger.info({ workspaceId: wsId, message: result.message }, 'funnelDailySync workspace result');
        }
      }
    } catch (err) {
      logger.error({ err }, 'funnelDailySync work handler error');
    }
  });

  logger.info('funnelDailySync registered via pg-boss (cron 0 5 * * * MSK) all workspaces');
}
