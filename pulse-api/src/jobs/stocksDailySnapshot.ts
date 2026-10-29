import { db } from '../db/client.js';
import { eq, and, desc, like } from 'drizzle-orm';
import { wbSyncRuns, marketplaceShops } from '../db/schema.js';
import { syncWbStocksCurrentAndSnapshot } from '../integrations/wb/stocks.js';
import { getQueue, JOB_STOCKS_SNAPSHOT } from './queue.js';
import { forEachWorkspace } from './workspaceIterator.js';
import { logJobs as logger } from '../lib/logger.js';

type Config = {
  enabled: boolean;
  minIntervalHours: number;
};

export function getStocksDailySnapshotConfig(): Config {
  const enabled = (process.env.ENABLE_STOCKS_DAILY_SNAPSHOT ?? '') === '1';
  const minIntervalHours = Number.parseInt(process.env.STOCKS_SYNC_MIN_INTERVAL_HOURS || '6', 10);
  return { enabled, minIntervalHours };
}

export async function runStocksSnapshotForWorkspace(
  workspaceId: number,
  reason: string,
  minIntervalHours: number,
  overrideShopId?: number,
): Promise<{ ran: boolean; message: string }> {
  const runs = await db
    .select({ createdAt: wbSyncRuns.createdAt, stage: wbSyncRuns.stage })
    .from(wbSyncRuns)
    .where(and(
      eq(wbSyncRuns.workspaceId, workspaceId),
      like(wbSyncRuns.stage, 'stocks-snapshot:%'),
      // F-017b: dedup only on completed runs.
      eq(wbSyncRuns.status, 'completed'),
      ...(overrideShopId ? [eq(wbSyncRuns.shopId, overrideShopId)] : []),
    ))
    .orderBy(desc(wbSyncRuns.createdAt))
    .limit(1);

  const last = runs[0];
  if (last?.createdAt) {
    const ageMs = Date.now() - new Date(last.createdAt).getTime();
    if (ageMs < minIntervalHours * 3600 * 1000) {
      return { ran: false, message: `skip: last run too recent (${last.stage})` };
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
    stage: `stocks-snapshot:${reason}`,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  try {
    if (!shopId) throw new Error('no active shop for workspace');
    const res = await syncWbStocksCurrentAndSnapshot(workspaceId, shopId);
    await db.update(wbSyncRuns)
      .set({ status: 'done', finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(wbSyncRuns.runId, runId));
    return { ran: true, message: `ok rows=${res.rows}` };
  } catch (err: any) {
    const errorMsg = err?.message ?? String(err);
    await db.update(wbSyncRuns)
      .set({ status: 'failed', finishedAt: new Date(), updatedAt: new Date(), error: errorMsg })
      .where(eq(wbSyncRuns.runId, runId));
    throw err;
  }
}

export async function maybeRunStocksSnapshot(reason: string): Promise<Map<number, { ran: boolean; message: string } | Error>> {
  const cfg = getStocksDailySnapshotConfig();
  if (!cfg.enabled) {
    return new Map([[0, { ran: false, message: 'disabled' }]]);
  }

  // Multi-shop: iterate all active shops per workspace
  return forEachWorkspace(
    { overrideEnvVar: 'STOCKS_SYNC_WORKSPACE_ID' },
    async (workspaceId) => {
      const shops = await db
        .select({ shopId: marketplaceShops.shopId })
        .from(marketplaceShops)
        .where(and(eq(marketplaceShops.workspaceId, workspaceId), eq(marketplaceShops.isActive, true)));

      if (shops.length === 0) {
        return { ran: false, message: 'no active shops' };
      }

      const results: string[] = [];
      for (const shop of shops) {
        try {
          const r = await runStocksSnapshotForWorkspace(workspaceId, reason, cfg.minIntervalHours, shop.shopId);
          results.push(`shop ${shop.shopId}: ${r.message}`);
        } catch (err: any) {
          results.push(`shop ${shop.shopId}: error: ${err.message}`);
        }
      }
      return { ran: true, message: results.join('; ') };
    }
  );
}

/* ─── pg-boss scheduler ─── */

export async function registerStocksDailySnapshotJob(): Promise<void> {
  const cfg = getStocksDailySnapshotConfig();
  if (!cfg.enabled) {
    logger.info('Disabled, skipping pg-boss registration');
    return;
  }

  const boss = await getQueue();
  await boss.createQueue(JOB_STOCKS_SNAPSHOT);

  const cronHours = cfg.minIntervalHours;
  const cron = `0 */${cronHours} * * *`;

  await boss.schedule(JOB_STOCKS_SNAPSHOT, cron, {}, {
    tz: 'Europe/Moscow',
  });

  await boss.work(JOB_STOCKS_SNAPSHOT, { localConcurrency: 1 }, async () => {
    try {
      logger.info('pg-boss triggered');
      const results = await maybeRunStocksSnapshot('pg-boss');
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

  logger.info({ cron }, 'Registered via pg-boss, all workspaces');
}

/** Simple wrapper for scheduler */
export async function runStocksDailySnapshot(): Promise<void> {
  await maybeRunStocksSnapshot("scheduler");
}
