import { db } from '../db/client.js';
import { eq, and, gte, lte, desc, asc, or, sql, inArray, isNull, isNotNull, ne, gt, lt } from 'drizzle-orm';
import { wbSyncRuns } from '../db/schema.js';
import { getQueue, JOB_INITIAL_SYNC } from './queue.js';
import { spawnAndWait } from '../lib/guardedSpawn.js';
import { logJobs as logger } from '../lib/logger.js';

/**
 * One-shot pg-boss worker: full initial data load for a workspace.
 * Triggered when a shop is created (boss.send from shops route).
 * Runs each sync step sequentially using spawnAndWait.
 */
export async function registerInitialSyncWorker(): Promise<void> {
  const boss = await getQueue();
  await boss.createQueue(JOB_INITIAL_SYNC);

  await boss.work(JOB_INITIAL_SYNC, { localConcurrency: 1 }, async (jobs) => {
    const job = jobs[0];
    const { workspaceId, shopId } = job.data as { workspaceId: number; shopId?: number };
    logger.info({ workspaceId, shopId }, 'starting full sync');

    const { randomUUID } = await import('node:crypto');
    const runId = randomUUID();

    await db.insert(wbSyncRuns).values({
      runId,
      workspaceId,
      shopId: shopId ?? null,  // F-017e: persist so we can attribute initial-sync rows per shop
      stage: 'initial-sync:running',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Register shop in wb_backfill_progress so the overnight backfillWalker picks it up.
    // Without this row, walker silently skips the shop forever and the shop's history
    // never extends past the initial-sync 7-30 day window — observed for shop 5 (ws=8, Azat) onboarded 2026-05-20.
    if (shopId) {
      try {
        await db.execute(sql`
          INSERT INTO wb_backfill_progress (workspace_id, shop_id, sync_type, target_oldest, created_at, updated_at)
          VALUES
            (${workspaceId}, ${shopId}, 'orders_sales', current_date - 120, now(), now()),
            (${workspaceId}, ${shopId}, 'funnel',       current_date - 120, now(), now()),
            (${workspaceId}, ${shopId}, 'adv',          current_date - 120, now(), now()),
            (${workspaceId}, ${shopId}, 'finance',      current_date - 120, now(), now())
          ON CONFLICT (workspace_id, shop_id, sync_type) DO NOTHING
        `);
      } catch (e) {
        logger.warn({ workspaceId, shopId, err: String((e as any)?.message ?? e).slice(0, 200) }, 'backfill-progress seed failed (non-fatal)');
      }
    }


    async function updateStage(stage: string) {
      await db
        .update(wbSyncRuns)
        .set({ stage, updatedAt: new Date() })
        .where(eq(wbSyncRuns.runId, runId));
    }

    // 2026-05-30: с получением WB Partner-секрета (X-Client-Secret) per-seller
    // rate-лимит уходит в фон — quota уходит в общую партнёрскую корзину.
    // Поднимаем initial DAYS_BACK с 30 до 120, чтобы новый пользователь
    // получал ~4 месяца истории за один заход вместо 1 + ночной walker.
    const steps: Array<{ name: string; script: string; env?: Record<string, string> }> = [
      {
        name: 'cards',
        script: 'wb:cards:sync',
        env: { RUN_AS_SCRIPT: '1' },
      },
      {
        name: 'orders-sales',
        script: 'wb:orders-sales:to-db',
        env: { DAYS_BACK: '120' },
      },
      {
        name: 'adv-spend',
        script: 'wb:adv:to-db',
        env: { DAYS_BACK: '120', ACTIVE_WITHIN_DAYS: '120' },
      },
      {
        name: 'adv-products',
        script: 'wb:adv:products:to-db',
        env: { DAYS_BACK: '120', ACTIVE_WITHIN_DAYS: '120' },
      },
      {
        name: 'finance',
        script: 'wb:finance:weekly-products:to-db',
        env: { DAYS_BACK: '120', WINDOW_DAYS: '120' },
      },
      {
        name: 'funnel-history',
        script: 'wb:funnel:history:to-db',
      },
      {
        name: 'funnel-products',
        script: 'wb:funnel:products:to-db',
        env: { DAYS_BACK_LIST: '7,30,120', LIMIT: '100', RATE_DELAY_MS: '5000' },
      },
      {
        name: 'spp',
        script: 'wb:spp:weekly:to-db',
        env: { DAYS_BACK: '120' },
      },
    ];

    const failedSteps: string[] = [];

    try {
      for (const step of steps) {
        await updateStage(`initial-sync:${step.name}`);
        logger.info({ workspaceId, step: step.name }, 'running sync step');

        const env: Record<string, string> = { ...(step.env ?? {}) };
        if (shopId) env.SHOP_ID = String(shopId);
        let result = await spawnAndWait(workspaceId, step.script, env);

        // Retry once on failure (handles transient network errors / fetch failed)
        if (!result.ok) {
          logger.warn({ workspaceId, step: step.name, code: result.code }, 'sync step failed, retrying once...');
          await new Promise(r => setTimeout(r, 5000));
          result = await spawnAndWait(workspaceId, step.script, env);
        }

        if (!result.ok) {
          logger.error({ workspaceId, step: step.name, code: result.code }, 'sync step failed after retry — skipping');
          failedSteps.push(step.name);
          // Continue to next step instead of aborting entire sync
        }
      }

      // Final steps: stocks snapshot + stocks history (inline, no child process)
      await updateStage('initial-sync:stocks');
      try {
        const { syncWbStocksCurrentAndSnapshot } = await import(
          '../integrations/wb/stocks.js'
        );
        if (shopId) {
          await syncWbStocksCurrentAndSnapshot(workspaceId, shopId);
        }
      } catch (e) {
        logger.error({ err: e }, 'stocks snapshot failed');
        failedSteps.push('stocks');
      }

      await updateStage('initial-sync:stocks-history');
      // Bounded: WB csv-create endpoint is 1/hour — if the bucket is exhausted (often, due to cross-seller throttle on in-memory limiter), the call would hang.
      // Onboarding shouldn't block on this; daily cron at 06:30 MSK backfills history.
      try {
        const { runStocksHistorySyncForShop } = await import('./stocksHistorySync.js');
        if (shopId) {
          await Promise.race([
            runStocksHistorySyncForShop(workspaceId, shopId, 90),
            new Promise((_, reject) => setTimeout(() => reject(new Error('stocks-history timeout: csv-create quota exhausted, will pick up on next cron tick')), 60_000)),
          ]);
        }
      } catch (e) {
        logger.warn({ err: String((e as any)?.message ?? e).slice(0, 200) }, 'stocks history sync skipped during initial sync');
        failedSteps.push('stocks-history');
      }

      // Прогон мониторинга сразу после первичной синхронизации — чтобы юзер
      // НЕ видел пустую страницу /task-monitor в первый день. До этого алёрты
      // появлялись только при следующем cron-тике (часы / следующее утро),
      // что было главной причиной оттока новых юзеров (см. анализ Кеворка).
      await updateStage('initial-sync:task-monitor');
      try {
        const { runTaskMonitor } = await import('../services/taskMonitor/index.js');
        const monitorResult = await runTaskMonitor(workspaceId);
        logger.info({ workspaceId, eventsCreated: monitorResult.eventsCreated }, 'task monitor seeded after initial sync');
      } catch (e) {
        logger.error({ err: e }, 'task monitor seeding failed (non-fatal — next cron tick will catch up)');
        failedSteps.push('task-monitor');
      }

      const finalStatus = failedSteps.length === 0 ? 'done' : 'error';
      const finalStage = failedSteps.length === 0 ? 'done' : `done:partial`;
      const finalError = failedSteps.length > 0 ? `Steps skipped: ${failedSteps.join(', ')}` : null;

      await db
        .update(wbSyncRuns)
        .set({ stage: finalStage, status: finalStatus, error: finalError, finishedAt: new Date(), updatedAt: new Date() })
        .where(eq(wbSyncRuns.runId, runId));

      logger.info({ workspaceId, failedSteps }, 'completed full sync');
    } catch (e: any) {
      logger.error({ err: e }, 'initialSync failed');
      try {
        await db
          .update(wbSyncRuns)
          .set({ stage: 'failed', status: 'failed', error: String(e?.message ?? e), finishedAt: new Date(), updatedAt: new Date() })
          .where(eq(wbSyncRuns.runId, runId));
      } catch { /* best-effort stage update */ }
      // Do NOT re-throw — it would crash the entire server process
    }
  });

  logger.info('initialSync worker registered (one-shot, triggered on shop creation)');
}
