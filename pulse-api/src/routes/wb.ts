import type { FastifyPluginAsync } from 'fastify';
import { eq, and, gte, lte, desc, asc, or, sql, inArray, isNull, isNotNull, ne, gt, lt, ilike, between, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { wbCards, wbFunnelDaily, workspaces, wbSyncRuns, wbFinanceWeeklyProducts, marketplaceShops } from '../db/schema.js';
import { getWbApiKey, getWbSellerId, kopecks, wbGetJson } from '../integrations/wb/wbClient.js';
import { inspectEndpoint } from '../integrations/wb/wbEndpointBucket.js';
import { NotFoundError, ConflictError } from '../lib/errors.js';
import { requireRole } from '../plugins/roleCheck.js';
import { log as logger } from '../lib/logger.js';

export const wbRoutes: FastifyPluginAsync = async (app) => {
  app.post('/wb/:workspaceId/sync/start', { preHandler: requireRole('manager') },async (req) => {
    const params = z
      .object({ workspaceId: z.coerce.number().int().positive() })
      .parse(req.params);

    // Ensure workspace exists
    const ws = await db
      .select({ workspaceId: workspaces.workspaceId })
      .from(workspaces)
      .where(eq(workspaces.workspaceId, params.workspaceId));
    if (ws.length === 0) throw new NotFoundError('Workspace not found');

    // Enqueue initial-sync via pg-boss (replaces guardedSpawn which opened terminal windows)
    try {
      const { getQueue, JOB_INITIAL_SYNC } = await import('../jobs/queue.js');
      const boss = await getQueue();
      const jobId = await boss.send(JOB_INITIAL_SYNC, { workspaceId: params.workspaceId }, {
        singletonKey: `ws-${params.workspaceId}`,
        retryLimit: 1,
        expireInSeconds: 3600,
      });

      if (!jobId) {
        throw new ConflictError(`Sync already in progress for workspace ${params.workspaceId}`);
      }

      logger.info({ workspaceId: params.workspaceId, jobId }, 'Enqueued on-login sync via pg-boss');
      return { ok: true, jobId };
    } catch (e: any) {
      if (e instanceof ConflictError) throw e;
      logger.error({ err: e, workspaceId: params.workspaceId }, 'Failed to enqueue on-login sync');
      throw e;
    }
  });

  /* ─── Manual cards re-sync ─── */
  app.post('/wb/:workspaceId/sync/cards', { preHandler: requireRole('manager') },async (req) => {
    const params = z
      .object({ workspaceId: z.coerce.number().int().positive() })
      .parse(req.params);

    const ws = await db
      .select({ workspaceId: workspaces.workspaceId })
      .from(workspaces)
      .where(eq(workspaces.workspaceId, params.workspaceId));
    if (ws.length === 0) throw new NotFoundError('Workspace not found');

    const { syncWbCardsToDb } = await import('../integrations/wb/cards.sync.js');
    // Run in background, return immediately
    syncWbCardsToDb({ workspaceId: params.workspaceId }).then((result) => {
      logger.info({ workspaceId: params.workspaceId }, 'Cards sync completed');
    }).catch((err) => {
      logger.error({ err, workspaceId: params.workspaceId }, 'Cards sync failed');
    });

    return { ok: true, message: `Cards sync started for workspace ${params.workspaceId}` };
  });

  /* ─── Manual data refresh (bypasses cooldowns, runs for specific workspace) ─── */
  // Known task names — used both to validate the `streams` filter and to
  // document the contract the frontend relies on.
  const ALL_REFRESH_TASKS = [
    'orders-sales',
    'campaigns',
    'funnel',
    'stocks',
    'stocks-history',
    'paid-storage',
    'spp',
    'supplies',
    'adv',
    'finance',
  ] as const;

  app.post('/wb/:workspaceId/sync/refresh', { preHandler: requireRole('manager') }, async (req) => {
    const params = z
      .object({ workspaceId: z.coerce.number().int().positive() })
      .parse(req.params);

    const body = z.object({
      shopId: z.coerce.number().int().positive().optional(),
      allShops: z.boolean().optional(),
      // Manual override (plan v2 block A2):
      //   force=true  → ignore gap detection, sync the full daysBack window.
      //   daysBack    → [1..120], overrides recommendedDaysBack for ALL streams.
      //   streams     → subset to run; omitted = run all. Names must be in
      //                 ALL_REFRESH_TASKS or the request is rejected.
      force: z.boolean().optional(),
      daysBack: z.coerce.number().int().min(1).max(120).optional(),
      streams: z.array(z.enum(ALL_REFRESH_TASKS)).nonempty().optional(),
    }).optional().parse(req.body);

    const ws = await db
      .select({ workspaceId: workspaces.workspaceId })
      .from(workspaces)
      .where(eq(workspaces.workspaceId, params.workspaceId));
    if (ws.length === 0) throw new NotFoundError('Workspace not found');

    // allShops=true → resolve all active shops, run refresh for each in parallel
    let shopIdsToSync: number[];
    if (body?.allShops) {
      const shops = await db
        .select({ shopId: marketplaceShops.shopId })
        .from(marketplaceShops)
        .where(and(eq(marketplaceShops.workspaceId, params.workspaceId), eq(marketplaceShops.isActive, true)));
      if (shops.length === 0) throw new NotFoundError('No active shops');
      shopIdsToSync = shops.map(s => s.shopId);
    } else {
      shopIdsToSync = body?.shopId ? [body.shopId] : [0]; // 0 = no shop filter
    }

    const REFRESH_LOCK_MS = 2 * 60 * 1000; // 2 min window

    // Run sync pipeline for one shop (all 6 steps sequentially)
    const runRefreshForShop = async (targetShopId: number | undefined) => {
      // Per-shop dedup: prevent double refresh for the same shop
      const existingRefresh = await db
        .select({ runId: wbSyncRuns.runId, stage: wbSyncRuns.stage, createdAt: wbSyncRuns.createdAt })
        .from(wbSyncRuns)
        .where(and(
          eq(wbSyncRuns.workspaceId, params.workspaceId),
          eq(wbSyncRuns.status, 'running'),
          sql`stage LIKE 'refresh:%'`,
          ...(targetShopId != null ? [eq(wbSyncRuns.shopId, targetShopId)] : []),
        ))
        .orderBy(desc(wbSyncRuns.createdAt))
        .limit(1);

      if (existingRefresh.length > 0) {
        const age = Date.now() - new Date(existingRefresh[0].createdAt).getTime();
        if (age < REFRESH_LOCK_MS) {
          logger.warn({ workspaceId: params.workspaceId, shopId: targetShopId, existingRunId: existingRefresh[0].runId }, 'Skipping refresh: already in progress');
          return;
        }
      }

      // F4: skip when a cron-driven sync is mid-flight for this shop — otherwise both fight for the same endpoint buckets.
      // Only applies to per-shop refresh (workspace-wide refresh stays opportunistic).
      // updated_at > 5min filter ignores stale "running" rows from dead workers (sweeper handles those at 6h).
      if (targetShopId != null) {
        const activeCron = await db
          .select({ runId: wbSyncRuns.runId, stage: wbSyncRuns.stage })
          .from(wbSyncRuns)
          .where(and(
            eq(wbSyncRuns.workspaceId, params.workspaceId),
            eq(wbSyncRuns.shopId, targetShopId),
            eq(wbSyncRuns.status, 'running'),
            sql`stage NOT LIKE 'refresh:%'`,
            sql`${wbSyncRuns.updatedAt} > NOW() - INTERVAL '5 minutes'`,
          ))
          .orderBy(desc(wbSyncRuns.updatedAt))
          .limit(1);
        if (activeCron.length > 0) {
          logger.warn({ workspaceId: params.workspaceId, shopId: targetShopId, blockingStage: activeCron[0].stage, blockingRunId: activeCron[0].runId }, 'Skipping refresh: cron sync active for this shop');
          return;
        }
      }

      const { randomUUID } = await import('node:crypto');
      const runId = randomUUID();
      await db.insert(wbSyncRuns).values({
        runId,
        workspaceId: params.workspaceId,
        shopId: targetShopId ?? null,
        stage: 'refresh:starting',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Gap detection unless the caller forced a specific window.
      //
      //   force=true       → every time-series stream uses `daysBack ?? 30`,
      //                      bypassing the freshness heuristic entirely.
      //                      Intended for "data looks wrong, nuke and reload".
      //                      C5 2026-05-07: cut default from 120 → 30 days
      //                      to stop chronic 429 chains on Statistics API.
      //                      Caller can still pass daysBack=120 explicitly.
      //   daysBack given   → every stream uses that value, even without
      //                      `force`. Useful to cap a suspected runaway
      //                      backfill (e.g. "I only need last 7 days").
      //   neither          → smart per-stream gap detection (default).
      const { detectDataGaps: detectGaps } = await import('../lib/detectDataGaps.js');
      const shopGapMap: Record<string, { recommendedDaysBack: number }> = {};
      if (body?.force) {
        const forced = body.daysBack ?? 30;
        // Seed every time-series stream with the forced window. Streams
        // not listed here (campaigns, supplies) don't consult the map.
        for (const t of ['orders-sales', 'funnel', 'adv', 'finance', 'stocks-history', 'paid-storage', 'spp']) {
          shopGapMap[t] = { recommendedDaysBack: forced };
        }
      } else {
        const { gaps: shopGaps } = await detectGaps(params.workspaceId, targetShopId);
        for (const g of shopGaps) shopGapMap[g.dataType] = g;
        if (body?.daysBack) {
          // Explicit daysBack narrows the detected window but does NOT widen
          // streams whose detector asked for a bigger backfill (e.g. empty
          // tables recommending 120). `force` is required to widen past the
          // detector's own recommendation.
          const cap = body.daysBack;
          for (const key of Object.keys(shopGapMap)) {
            if (shopGapMap[key].recommendedDaysBack > cap) {
              shopGapMap[key] = { ...shopGapMap[key], recommendedDaysBack: cap };
            }
          }
        }
      }

      // Build shop-specific sync tasks
      const shopTasks: Array<{ name: string; run: () => Promise<any> }> = [
        {
          name: 'orders-sales',
          run: async () => {
            const daysBack = Math.max(5, shopGapMap['orders-sales']?.recommendedDaysBack ?? 5);
            const { startOrdersSalesSyncForWorkspace, getOrdersSalesSyncConfig } = await import('../jobs/ordersSalesDailySync.js');
            return startOrdersSalesSyncForWorkspace(params.workspaceId, 'manual-refresh', { ...getOrdersSalesSyncConfig(), minIntervalHours: 0, daysBack }, targetShopId);
          },
        },
        {
          name: 'campaigns',
          run: async () => {
            const { syncCampaigns } = await import('../integrations/wb/campaigns.js');
            return syncCampaigns(params.workspaceId, targetShopId);
          },
        },
        {
          name: 'funnel',
          run: async () => {
            const daysBack = shopGapMap['funnel']?.recommendedDaysBack ?? 1;
            const { startFunnelSyncForWorkspace, getFunnelDailySyncConfig } = await import('../jobs/funnelDailySync.js');
            return startFunnelSyncForWorkspace(params.workspaceId, 'manual-refresh', { ...getFunnelDailySyncConfig(), minIntervalHours: 0, daysBack }, targetShopId);
          },
        },
        {
          name: 'stocks',
          run: async () => {
            const { runStocksSnapshotForWorkspace } = await import('../jobs/stocksDailySnapshot.js');
            return runStocksSnapshotForWorkspace(params.workspaceId, 'manual-refresh', 0, targetShopId);
          },
        },
        {
          name: 'stocks-history',
          run: async () => {
            if (!targetShopId) return;
            const daysBack = shopGapMap['stocks-history']?.recommendedDaysBack ?? 90;
            const { runStocksHistorySyncForShop } = await import('../jobs/stocksHistorySync.js');
            return runStocksHistorySyncForShop(params.workspaceId, targetShopId, daysBack);
          },
        },
        {
          name: 'paid-storage',
          run: async () => {
            if (!targetShopId) return;
            const daysBack = shopGapMap['paid-storage']?.recommendedDaysBack ?? 8;
            const { runPaidStorageSyncForShop } = await import('../jobs/paidStorageSync.js');
            return runPaidStorageSyncForShop(params.workspaceId, targetShopId, daysBack);
          },
        },
        {
          name: 'spp',
          run: async () => {
            const daysBack = shopGapMap['spp']?.recommendedDaysBack ?? 30;
            const { startSppSyncForWorkspace, getSppDailySyncConfig } = await import('../jobs/sppDailySync.js');
            return startSppSyncForWorkspace(
              params.workspaceId,
              'manual-refresh',
              { ...getSppDailySyncConfig(), enabled: true, minIntervalHours: 0, daysBack },
              targetShopId,
            );
          },
        },
        {
          name: 'supplies',
          run: async () => {
            const { runSuppliesSyncForWorkspace } = await import('../jobs/suppliesSync.js');
            return runSuppliesSyncForWorkspace(params.workspaceId);
          },
        },
        {
          name: 'adv',
          run: async () => {
            const daysBack = shopGapMap['adv']?.recommendedDaysBack ?? 2;
            const { startAdvSyncForWorkspace, getAdvDailySyncConfig } = await import('../jobs/advDailySync.js');
            return startAdvSyncForWorkspace(params.workspaceId, 'manual-refresh', { ...getAdvDailySyncConfig(), minIntervalHours: 0, daysBack }, targetShopId);
          },
        },
        {
          name: 'finance',
          run: async () => {
            const daysBack = shopGapMap['finance']?.recommendedDaysBack ?? 14;
            const { spawnAndWait } = await import('../lib/spawnWithTracking.js');
            const { randomUUID: uuid } = await import('node:crypto');
            let finShopId = targetShopId;
            if (!finShopId) {
              const s = await db.select({ shopId: marketplaceShops.shopId }).from(marketplaceShops)
                .where(and(eq(marketplaceShops.workspaceId, params.workspaceId), eq(marketplaceShops.isActive, true))).limit(1);
              finShopId = s[0]?.shopId;
            }
            const finRunId = uuid();
            await db.insert(wbSyncRuns).values({ runId: finRunId, workspaceId: params.workspaceId, shopId: finShopId ?? null, stage: `finance-daily:manual-refresh:${daysBack}d`, createdAt: new Date(), updatedAt: new Date() });
            const result = await spawnAndWait(finRunId, params.workspaceId, 'finance-daily', {
              command: 'npx', args: ['tsx', 'src/integrations/wb/finance.toDb.ts'],
              env: { WORKSPACE_ID: String(params.workspaceId), DAYS_BACK: String(daysBack), WINDOW_DAYS: '30', RUN_ID: finRunId, ...(finShopId ? { SHOP_ID: String(finShopId) } : {}) },
              logPrefix: 'wb-finance-daily', timeoutMs: 30 * 60 * 1000,
            });
            if (!result.success) throw new Error(`finance-daily sync failed (code=${result.code})`);
          },
        },
      ];

      // `streams` filter (plan v2 A2): if the caller passed a subset, run
      // only those. Empty/undefined => run all. Unknown names were already
      // rejected by Zod at the body-parse step.
      const streamFilter = body?.streams ? new Set<string>(body.streams) : null;
      const tasksToRun = streamFilter
        ? shopTasks.filter((t) => streamFilter.has(t.name))
        : shopTasks;

      // Lazy-loaded so we don't drag these imports into hot paths that
      // never hit the refresh route (e.g. sync/status).
      const { isTokenExpiredError, isScopeMissingError } = await import('../integrations/wb/wbClient.js');
      const { notifyTokenExpired } = await import('../services/wb/notifyTokenExpired.js');

      // Plan v2 E3 — group tasks by WB API domain so the three groups
      // can run in parallel. Inside each group we stay sequential so
      // we don't trip the per-domain rate limiter (statistics-api has
      // a 1 rpm cap; parallelism there would just queue the second
      // request inside wbRateLimiter).
      //
      // Historical duration (last 7d, from wb_sync_runs):
      //   statistics group: orders 114s + funnel 126s + spp 127s +
      //                     stocks 45s + stocks-history ~60s +
      //                     paid-storage ~60s + finance 32s  ≈ 9 min
      //   advert group:     campaigns + adv                  ≈ 2 min
      //   supplies group:   supplies                         ≈ 30 sec
      // Running the three groups in parallel caps total at ~9 min
      // instead of ~12 min sequential — a realistic ~25% win.
      const STREAM_DOMAIN: Record<string, 'statistics' | 'advert' | 'supplies'> = {
        'orders-sales':   'statistics',
        'funnel':         'statistics',
        'stocks':         'statistics',
        'stocks-history': 'statistics',
        'paid-storage':   'statistics',
        'spp':            'statistics',
        'finance':        'statistics',
        'campaigns':      'advert',
        'adv':            'advert',
        'supplies':       'supplies',
      };

      // F3: probe URL per stage for read-only bucket inspection before launching.
      // Stages without a registered per-endpoint limit (funnel, stocks) are omitted — they only have per-domain RPM, not a precise bucket.
      const STAGE_PROBE_URL: Record<string, string> = {
        'orders-sales':   'https://statistics-api.wildberries.ru/api/v1/supplier/orders',
        'stocks-history': 'https://seller-analytics-api.wildberries.ru/api/v2/nm-report/downloads',
        'paid-storage':   'https://seller-analytics-api.wildberries.ru/api/v1/paid_storage',
        'spp':            'https://statistics-api.wildberries.ru/api/v5/supplier/reportDetailByPeriod',
        'finance':        'https://statistics-api.wildberries.ru/api/v5/supplier/reportDetailByPeriod',
        'supplies':       'https://supplies-api.wildberries.ru/api/v1/supplies/1/goods',
        'campaigns':      'https://advert-api.wildberries.ru/adv/v1/promotion/count',
        'adv':            'https://advert-api.wildberries.ru/adv/v3/fullstats',
      };

      // Resolve seller id once for precheck (per-shop refresh only — workspace-wide refresh has multiple keys).
      let refreshSellerId: string | undefined = undefined;
      if (targetShopId) {
        try {
          const probeKey = await getWbApiKey(params.workspaceId, targetShopId);
          refreshSellerId = getWbSellerId(probeKey);
        } catch (e) {
          logger.warn({ workspaceId: params.workspaceId, shopId: targetShopId, err: String((e as any)?.message ?? e).slice(0, 200) }, 'F3 precheck: seller id unresolved, skipping precheck');
        }
      }
      const groups = new Map<string, typeof shopTasks>();
      for (const task of tasksToRun) {
        const g = STREAM_DOMAIN[task.name] ?? 'statistics';
        const arr = groups.get(g) ?? [];
        arr.push(task);
        groups.set(g, arr);
      }

      const bg_triggered: string[] = [];
      const bg_errors: string[] = [];
      // Once any group catches a WbTokenExpiredError, flip this flag and
      // stop spawning further work in the remaining groups too — the
      // token is per-shop, it won't magically recover between domains.
      let tokenExpired = false;
      // Per-stream diagnostic context for token-expired event.
      // Without this we used to write only the generic "rotate the key"
      // string to wb_sync_runs.error and could not tell *which* endpoint
      // actually returned 401 — see plan woolly-nibbling-snowflake Phase 1.
      let tokenExpiredCtx: { stream: string; endpoint?: string; shopId?: number } | null = null;
      // Scope-missing errors (HTTP 403 / 401 with scope-shaped body) are
      // recorded per-stream but do NOT halt the whole refresh — other
      // streams may still have permission. Reported back to the caller
      // so UI can disable the corresponding feature.
      const scopeMissing: Array<{ stream: string; endpoint?: string; status?: number }> = [];

      async function runGroup(groupName: string, tasks: typeof shopTasks) {
        for (const task of tasks) {
          if (tokenExpired) return;

          // F3 precheck: if the stage's primary endpoint bucket is empty, skip — saves a wasted 429 round-trip and surfaces an actionable ETA.
          if (targetShopId && refreshSellerId !== undefined) {
            const probeUrl = STAGE_PROBE_URL[task.name];
            if (probeUrl) {
              try {
                const st = await inspectEndpoint(probeUrl, params.workspaceId, refreshSellerId);
                if (st && st.remaining === 0) {
                  const etaMin = Math.max(1, Math.ceil(st.ttlSec / 60));
                  bg_errors.push(`${task.name}: quota_exhausted (${st.label}, ~${etaMin}m)`);
                  continue;
                }
              } catch (e) {
                logger.warn({ stage: task.name, err: String((e as any)?.message ?? e).slice(0, 200) }, 'F3 precheck: inspection failed, proceeding');
              }
            }
          }

          try {
            // Stage updates are per-group: the first running task in a
            // group is what external observers see as "current". Good
            // enough for progress display without bookkeeping overhead.
            await db
              .update(wbSyncRuns)
              .set({ stage: `refresh:${task.name}:running`, updatedAt: new Date() })
              .where(eq(wbSyncRuns.runId, runId));
            await task.run();
            bg_triggered.push(task.name);
          } catch (err: any) {
            if (isTokenExpiredError(err)) {
              tokenExpired = true;
              tokenExpiredCtx = {
                stream: task.name,
                endpoint: (err as any)?.endpoint,
                shopId: targetShopId,
              };
              bg_errors.push(`${task.name}: WB token expired (endpoint: ${(err as any)?.endpoint ?? 'unknown'})`);
              return;
            }
            if (isScopeMissingError(err)) {
              scopeMissing.push({
                stream: task.name,
                endpoint: (err as any)?.endpoint,
                status: (err as any)?.statusCode,
              });
              bg_errors.push(`${task.name}: scope_missing (${(err as any)?.endpoint ?? 'unknown'})`);
              continue;
            }
            bg_errors.push(`${task.name}: ${String(err?.message ?? err).slice(0, 200)}`);
          }
        }
      }

      await Promise.all(
        [...groups.entries()].map(([name, tasks]) => runGroup(name, tasks)),
      );

      if (tokenExpired) {
        // Write the specialised status so the VIEW + sync-status
        // endpoint can colour this shop as 'broken' rather than the
        // generic 'failed' bucket. `shop_id` must be known to find the
        // owner; if this is a workspace-level run with no target shop,
        // we fall back to 'failed'.
        const ctxJson = tokenExpiredCtx ? JSON.stringify(tokenExpiredCtx) : '{}';
        await db
          .update(wbSyncRuns)
          .set({
            stage: 'refresh:token-expired',
            status: targetShopId ? 'token_expired' : 'failed',
            finishedAt: new Date(),
            updatedAt: new Date(),
            // Structured context: stream + endpoint that actually 401'd,
            // not just the generic "rotate the key" string. Lets us
            // diagnose scope-vs-rotation incidents without re-running.
            error: `WB token expired ${ctxJson}`,
          })
          .where(eq(wbSyncRuns.runId, runId));

        if (targetShopId) {
          // Resolve shop name for a nicer Telegram message. Best-effort.
          let shopName: string | null = null;
          try {
            const [row] = await db
              .select({ name: marketplaceShops.name })
              .from(marketplaceShops)
              .where(eq(marketplaceShops.shopId, targetShopId))
              .limit(1);
            shopName = (row as any)?.name ?? null;
          } catch { /* non-fatal */ }

          // Fire-and-forget — the notifier handles its own dedup and
          // swallows Telegram errors.
          notifyTokenExpired({
            workspaceId: params.workspaceId,
            shopId: targetShopId,
            shopName,
          }).catch(() => {});
        }

        logger.warn({ workspaceId: params.workspaceId, runId, shopId: targetShopId }, 'Shop refresh halted: WB token expired');
        return;
      }

      await db.update(wbSyncRuns).set({
        stage: bg_errors.length > 0 ? 'refresh:done-with-errors' : 'refresh:done',
        status: 'done', finishedAt: new Date(), updatedAt: new Date(),
        error: bg_errors.length > 0 ? bg_errors.join('; ').slice(0, 500) : null,
      }).where(eq(wbSyncRuns.runId, runId));

      logger.info({ workspaceId: params.workspaceId, runId, shopId: targetShopId, triggered: bg_triggered, errors: bg_errors }, 'Shop refresh completed');
    };

    // Launch refresh(es) in background — respond immediately.
    // Shops СЕРИАЛИЗУЕМ: WB имеет global rate-limit per sellerId, а не per-shop.
    // Параллельный запуск 3 shops сразу бьёт 429 на seller-analytics-api
    // (funnel, search-report). Сериализация + пауза между shops — безопасно.
    const allTaskNames = ['orders-sales', 'campaigns', 'funnel', 'stocks', 'adv', 'finance'];
    const INTER_SHOP_DELAY_MS = 15_000; // пауза, чтобы WB global limiter «остыл»
    setImmediate(async () => {
      for (let i = 0; i < shopIdsToSync.length; i++) {
        const sid = shopIdsToSync[i];
        const targetSid = sid === 0 ? undefined : sid;
        try {
          await runRefreshForShop(targetSid);
        } catch (err) {
          logger.error({ shopId: targetSid, err }, 'Shop refresh failed');
        }
        if (i < shopIdsToSync.length - 1) {
          await new Promise((r) => setTimeout(r, INTER_SHOP_DELAY_MS));
        }
      }
    });

    const effectiveStreams = body?.streams ? [...body.streams] : [...ALL_REFRESH_TASKS];
    logger.info(
      {
        workspaceId: params.workspaceId,
        shopIds: shopIdsToSync,
        force: Boolean(body?.force),
        daysBack: body?.daysBack ?? null,
        streams: effectiveStreams,
      },
      'Manual refresh started (async)',
    );
    return {
      ok: true,
      triggered: effectiveStreams,
      errors: [],
      shopIds: shopIdsToSync,
      force: Boolean(body?.force),
      daysBack: body?.daysBack ?? null,
    };
  });

  /**
   * GET /wb/:workspaceId/shops/:shopId/sync-status
   *
   * Per-shop sync freshness. Reads the marketplace_shops_sync_status VIEW
   * (migration 0111) — for every historic stage of this shop returns:
   *   - lastSuccessAt, lastErrorAt, lastTokenExpiredAt
   *   - lastErrorMessage
   *   - ageMinutes from last success (or null if never succeeded)
   *   - slaStatus: 'fresh' | 'stale' | 'broken'
   *
   * Used by the frontend <SyncFreshnessBadge/> (plan v2 D1) to colour
   * page-level freshness indicators; polled every 60 seconds.
   *
   * Stage → SLA mapping documents the product expectation of each feed;
   * update here when the user perceives "slow sync" for a given stage
   * (don't touch the VIEW itself — it's generic).
   */
  const SYNC_SLA_MINUTES: Record<string, number> = {
    'refresh:orders-sales:running':   12 * 60,
    'refresh:funnel:running':         12 * 60,
    'refresh:adv:running':            12 * 60,
    'refresh:stocks:running':         12 * 60,
    'refresh:stocks-history:running': 24 * 60,
    'refresh:paid-storage:running':   24 * 60,
    'refresh:spp:running':            24 * 60,
    'refresh:finance:running':        2 * 24 * 60,
    'refresh:supplies:running':       6 * 60,
    'refresh:campaigns:running':      6 * 60,
    'refresh:done':                   12 * 60,
    'refresh:done-with-errors':       12 * 60,
  };
  const DEFAULT_SLA_MINUTES = 24 * 60;

  app.get('/wb/:workspaceId/shops/:shopId/sync-status', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z
      .object({
        workspaceId: z.coerce.number().int().positive(),
        shopId: z.coerce.number().int().positive(),
      })
      .parse(req.params);

    // Enforce workspace ownership — a user with access to workspace A
    // must not see shop B's sync status if B belongs to workspace C.
    const ownedShops = await db
      .select({ shopId: marketplaceShops.shopId })
      .from(marketplaceShops)
      .where(and(
        eq(marketplaceShops.workspaceId, params.workspaceId),
        eq(marketplaceShops.shopId, params.shopId),
      ))
      .limit(1);
    if (ownedShops.length === 0) {
      throw new NotFoundError('Shop not found in this workspace');
    }

    type Row = {
      stage: string;
      last_success_at: Date | string | null;
      last_error_at: Date | string | null;
      last_token_expired_at: Date | string | null;
      last_error_message: string | null;
      success_count: number | string;
      failed_count: number | string;
    };
    const res = await db.execute<Row>(sql`
      SELECT stage, last_success_at, last_error_at, last_token_expired_at,
             last_error_message, success_count, failed_count
      FROM marketplace_shops_sync_status
      WHERE shop_id = ${params.shopId}
      ORDER BY stage
    `);
    const rows = ((res as any).rows ?? res) as Row[];

    const now = Date.now();
    const stages = rows.map((r) => {
      const successAt = r.last_success_at ? new Date(r.last_success_at).getTime() : null;
      const errorAt = r.last_error_at ? new Date(r.last_error_at).getTime() : null;
      const tokenExpiredAt = r.last_token_expired_at ? new Date(r.last_token_expired_at).getTime() : null;

      const ageMinutes = successAt == null ? null : Math.floor((now - successAt) / 60_000);
      const sla = SYNC_SLA_MINUTES[r.stage] ?? DEFAULT_SLA_MINUTES;

      // Token expired is always "broken" — the user must rotate a key
      // before anything else matters.
      let slaStatus: 'fresh' | 'stale' | 'broken';
      if (tokenExpiredAt != null && (successAt == null || tokenExpiredAt > successAt)) {
        slaStatus = 'broken';
      } else if (ageMinutes == null) {
        slaStatus = 'broken'; // never succeeded → treat as broken, not stale
      } else if (ageMinutes > 2 * sla) {
        slaStatus = 'broken';
      } else if (ageMinutes > sla) {
        slaStatus = 'stale';
      } else {
        slaStatus = 'fresh';
      }

      return {
        stage: r.stage,
        lastSuccessAt: r.last_success_at ? new Date(r.last_success_at).toISOString() : null,
        lastErrorAt: r.last_error_at ? new Date(r.last_error_at).toISOString() : null,
        lastTokenExpiredAt: r.last_token_expired_at ? new Date(r.last_token_expired_at).toISOString() : null,
        lastErrorMessage: r.last_error_message,
        successCount: Number(r.success_count) || 0,
        failedCount: Number(r.failed_count) || 0,
        ageMinutes,
        slaMinutes: sla,
        slaStatus,
      };
    });

    const worst = stages.reduce<'fresh' | 'stale' | 'broken'>((acc, s) => {
      if (acc === 'broken' || s.slaStatus === 'broken') return 'broken';
      if (acc === 'stale' || s.slaStatus === 'stale') return 'stale';
      return acc;
    }, 'fresh');

    return {
      shopId: params.shopId,
      workspaceId: params.workspaceId,
      overallStatus: worst,
      stages,
    };
  });

  app.get('/wb/:workspaceId/sync/status', { preHandler: requireRole('viewer') },async (req) => {
    const params = z
      .object({ workspaceId: z.coerce.number().int().positive() })
      .parse(req.params);
    const statusQuery = z.object({ shopId: z.coerce.number().int().positive().optional() }).parse(req.query);
    const shopId = statusQuery.shopId;

    const cardsRows = await db
      .select({ nmId: wbCards.nmId })
      .from(wbCards)
      .where(eq(wbCards.workspaceId, params.workspaceId));

    const funnelRows = await db
      .select({ date: wbFunnelDaily.date, source: wbFunnelDaily.source, updatedAt: wbFunnelDaily.updatedAt })
      .from(wbFunnelDaily)
      .where(eq(wbFunnelDaily.workspaceId, params.workspaceId))
      .orderBy(desc(wbFunnelDaily.updatedAt))
      .limit(200);

    const latestBySource: Record<string, { date: string; updatedAt: string } | undefined> = {};
    const countBySource: Record<string, number> = {};
    for (const r of funnelRows) {
      countBySource[r.source] = (countBySource[r.source] ?? 0) + 1;
      if (!latestBySource[r.source]) {
        latestBySource[r.source] = { date: r.date, updatedAt: new Date(r.updatedAt).toISOString() };
      }
    }

    // full counts (cheap enough)
    const allCounts = await db
      .select({ source: wbFunnelDaily.source })
      .from(wbFunnelDaily)
      .where(eq(wbFunnelDaily.workspaceId, params.workspaceId));

    const totalsBySource: Record<string, number> = {};
    for (const r of allCounts) totalsBySource[r.source] = (totalsBySource[r.source] ?? 0) + 1;

    // Prefer master refresh runs (stage='refresh:...') over child runs, then by recency
    const runs = await db
      .select()
      .from(wbSyncRuns)
      .where(eq(wbSyncRuns.workspaceId, params.workspaceId))
      .orderBy(
        sql`CASE WHEN stage LIKE 'refresh:%' THEN 0 ELSE 1 END`,
        desc(wbSyncRuns.createdAt),
      )
      .limit(1);

    // available days for products source (contiguous from today backwards)
    const today = new Date().toISOString().slice(0, 10);
    const prodDates = await db
      .select({ date: wbFunnelDaily.date })
      .from(wbFunnelDaily)
      .where(and(eq(wbFunnelDaily.workspaceId, params.workspaceId), eq(wbFunnelDaily.source, 'products')));
    const set = new Set(prodDates.map((r) => r.date));
    let availableDays = 0;
    for (let i = 0; i <= 90; i++) {
      const d = new Date(today + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() - i);
      const key = d.toISOString().slice(0, 10);
      if (!set.has(key)) break;
      availableDays++;
    }

    // Check for active sync jobs in pg-boss
    let activeSyncJobs: Array<{ name: string; startedOn: string }> = [];
    // Raised from 15→30 min (2026-04-22 investigation): `stocks-snapshot`
    // legitimately runs 8-10 min on large catalogues (WB Stocks v2 API is
    // slow), and rate-limit waits can push `updatedAt` gaps past 15 min
    // without the job actually being stuck. Analysis in
    // _context/SYNC-FAILURES-INVESTIGATION-2026-04-22.md found that 100%
    // of "stocks-snapshot failed" markers were auto-reset, not real WB
    // errors — purely a timeout misconfiguration.
    const STALE_JOB_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
    try {
      const activeJobs = await db.execute(sql`
        SELECT name, started_on
        FROM pgboss.job
        WHERE state = 'active'
          AND name IN ('initial-full-sync', 'orders-sales-sync', 'funnel-daily-sync', 'adv-daily-sync', 'stocks-daily-snapshot')
          AND (data->>'workspaceId')::int = ${params.workspaceId}
        ORDER BY started_on DESC
      `);
      activeSyncJobs = (activeJobs.rows as any[]).map(r => ({
        name: r.name,
        startedOn: r.started_on?.toISOString?.() ?? r.started_on,
      }));
    } catch { /* pg-boss schema might not exist */ }

    // Auto-reset stale jobs (stuck >30 min) — don't let them block UI forever
    const now = Date.now();
    const freshJobs = activeSyncJobs.filter(j => {
      const elapsed = now - new Date(j.startedOn).getTime();
      return elapsed < STALE_JOB_THRESHOLD_MS;
    });
    if (freshJobs.length < activeSyncJobs.length) {
      logger.warn({ staleCount: activeSyncJobs.length - freshJobs.length, workspaceId: params.workspaceId }, 'Auto-resetting stale sync jobs');
      db.execute(sql`
        UPDATE pgboss.job SET state = 'failed', output = '{"error":"auto-reset: stuck >30min"}'::jsonb
        WHERE state = 'active'
          AND started_on < NOW() - INTERVAL '15 minutes'
          AND name IN ('initial-full-sync','orders-sales-sync','funnel-daily-sync','adv-daily-sync','stocks-daily-snapshot')
          AND (data->>'workspaceId')::int = ${params.workspaceId}
      `).catch(() => {});
    }

    // Last sync per job type from wbSyncRuns (actual data updates)
    let lastSyncByJob: Record<string, string> = {};
    try {
      // Subquery so we can GROUP BY / filter on the mapped job_type without
      // relying on HAVING-referencing-alias (not supported in all PG plans).
      const syncRuns = await db.execute(sql`
        SELECT job_type, MAX(created_at) AS last_run
        FROM (
          SELECT
            created_at,
            CASE
              WHEN stage LIKE 'orders-sales:%' THEN 'orders-sales-sync'
              WHEN stage LIKE 'funnel-daily:%' THEN 'funnel-daily-sync'
              WHEN stage LIKE 'adv-daily:%' THEN 'adv-daily-sync'
              WHEN stage LIKE 'stocks-snapshot:%' THEN 'stocks-daily-snapshot'
              WHEN stage LIKE 'finance-weekly-products:%' THEN 'finance-weekly-products-sync'
              WHEN stage LIKE 'spp-%' THEN 'spp-weekly-sync'
              WHEN stage LIKE 'reports-%' THEN 'reports-daily-sync'
            END AS job_type
          FROM wb_sync_runs
          WHERE workspace_id = ${params.workspaceId}
            AND stage NOT LIKE '%error%'
        ) t
        WHERE job_type IS NOT NULL
        GROUP BY job_type
      `);
      for (const r of syncRuns.rows as any[]) {
        if (r.job_type) {
          lastSyncByJob[r.job_type] = r.last_run?.toISOString?.() ?? r.last_run;
        }
      }
    } catch (e) {
      logger.warn({ err: e }, 'Failed to query sync runs for freshness');
    }

    // Auto-reset stale wbSyncRuns (stuck >30 min with no progress)
    if (runs[0]?.status === 'running' && !runs[0]?.finishedAt && runs[0]?.updatedAt) {
      const runAge = now - new Date(runs[0].updatedAt).getTime();
      if (runAge > STALE_JOB_THRESHOLD_MS) {
        logger.warn({ runId: runs[0].runId, runAge, workspaceId: params.workspaceId },
          'Auto-resetting stale wbSyncRun');
        const stageStr = String(runs[0].stage ?? '');
        const autoStatus = stageStr.includes('done') ? 'done' : 'failed';
        try {
          await db.update(wbSyncRuns)
            .set({
              status: autoStatus,
              error: autoStatus === 'failed' ? 'auto-reset: stuck >30min' : null,
              finishedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(wbSyncRuns.runId, runs[0].runId));
        } catch (e) {
          logger.error({ err: e, runId: runs[0].runId }, 'Auto-reset DB update failed');
        }
        // Treat this run as not active for the current response
        (runs[0] as any).status = autoStatus;
      }
    }

    // Use freshJobs (excludes stale >30min). Also check if wbSyncRuns is stale.
    const runIsActive = runs[0]?.status === 'running' && !runs[0]?.finishedAt
      && runs[0]?.updatedAt && (now - new Date(runs[0].updatedAt).getTime() < STALE_JOB_THRESHOLD_MS);
    const isSyncing = freshJobs.length > 0 || !!runIsActive;

    // Detect actual data freshness per table
    let lastDataByType: Record<string, { firstDate: string | null; lastDate: string | null; gapDays: number; totalDays: number }> = {};
    try {
      const { detectDataGaps } = await import('../lib/detectDataGaps.js');
      const { gaps } = await detectDataGaps(params.workspaceId, shopId);
      for (const g of gaps) {
        lastDataByType[g.dataType] = { firstDate: g.firstDataDate, lastDate: g.lastDataDate, gapDays: g.gapDays, totalDays: g.totalDays };
      }
    } catch (e) {
      logger.warn({ err: e }, 'Failed to detect data gaps for status');
    }

    // Average sync duration from last 5 completed refresh runs (for time estimate)
    let avgSyncDurationMs: number | null = null;
    try {
      const avgResult = await db.execute(sql`
        SELECT AVG(EXTRACT(EPOCH FROM (finished_at - created_at)))::int AS avg_sec
        FROM (
          SELECT finished_at, created_at FROM wb_sync_runs
          WHERE workspace_id = ${params.workspaceId}
            AND stage LIKE 'refresh:done%'
            AND finished_at IS NOT NULL
          ORDER BY created_at DESC LIMIT 5
        ) sub
      `);
      const avgSec = (avgResult.rows as any)[0]?.avg_sec;
      if (avgSec && Number.isFinite(avgSec) && avgSec > 0) {
        avgSyncDurationMs = avgSec * 1000;
      }
    } catch { /* best-effort */ }

    return {
      workspaceId: params.workspaceId,
      run: runs[0] ?? null,
      isSyncing,
      activeSyncJobs: freshJobs,
      lastSyncByJob,
      lastDataByType,
      avgSyncDurationMs,
      cards: {
        count: cardsRows.length,
      },
      funnelDaily: {
        totalsBySource,
        latestBySource,
        productsAvailableDaysFromToday: availableDays,
      },
    };
  });

  app.get('/wb/:workspaceId/finance/products', { preHandler: requireRole('viewer') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z
      .object({
        dateFrom: z.string(),
        dateTo: z.string(),
        period: z.enum(['weekly', 'daily']).optional(),
        taxRate: z.coerce.number().optional(),
        source: z.enum(['db', 'live']).optional(),
        shopId: z.coerce.number().int().positive().optional(),
      })
      .parse(req.query);

    const period = query.period ?? 'weekly';
    const taxRate = query.taxRate ?? 0.15; // default: USN income-minus-costs 15%
    const source = query.source ?? 'db';

    if (period === 'weekly' && source === 'db') {

      const rows = await db
        .select()
        .from(wbFinanceWeeklyProducts)
        .where(
          and(
            eq(wbFinanceWeeklyProducts.workspaceId, params.workspaceId),
            gte(wbFinanceWeeklyProducts.dateFrom, query.dateFrom),
            lte(wbFinanceWeeklyProducts.dateTo, query.dateTo)
          )
        )
        .orderBy(desc(wbFinanceWeeklyProducts.dateFrom))
        .limit(20000);

      const nmIds = [...new Set(rows.map((r) => r.nmId))];
      const cards = nmIds.length
        ? await db
            .select({ nmId: wbCards.nmId, vendorCode: wbCards.vendorCode })
            .from(wbCards)
            .where(and(eq(wbCards.workspaceId, params.workspaceId), inArray(wbCards.nmId, nmIds)))
        : [];
      const vc = new Map(cards.map((c) => [c.nmId, c.vendorCode] as const));

      const out = rows.map((r) => {
        const costsKopecks =
          r.logisticsKopecks +
          r.paidAcceptanceKopecks +
          r.storageKopecks +
          r.penaltiesKopecks +
          r.otherHoldKopecks +
          r.additionalPaymentsKopecks;
        const netTransferKopecks = r.incomeFromSalesKopecks - costsKopecks;
        const taxKopecks = Math.round(taxRate * netTransferKopecks);
        const netProfitKopecks = netTransferKopecks - taxKopecks;
        return {
          period,
          dateFrom: r.dateFrom,
          dateTo: r.dateTo,
          nmId: r.nmId,
          vendorCode: vc.get(r.nmId) ?? null,

          revenueKopecks: r.revenueKopecks,
          incomeFromSalesKopecks: r.incomeFromSalesKopecks,

          logisticsKopecks: r.logisticsKopecks,
          paidAcceptanceKopecks: r.paidAcceptanceKopecks,
          storageKopecks: r.storageKopecks,
          penaltiesKopecks: r.penaltiesKopecks,
          otherHoldKopecks: r.otherHoldKopecks,
          additionalPaymentsKopecks: r.additionalPaymentsKopecks,

          costsKopecks,
          taxKopecks,
          netTransferKopecks,
          netProfitKopecks,

          lines: r.lines,
        };
      });

      return {
        workspaceId: params.workspaceId,
        period,
        source,
        dateFrom: query.dateFrom,
        dateTo: query.dateTo,
        taxRate,
        rows: out,
      };
    }

    // fallback: live mode (also used for daily)
    const apiKey = await getWbApiKey(params.workspaceId, query.shopId);

    type Key = `${string}|${string}|${number}`;
    type Agg = {
      workspaceId: number;
      period: 'weekly' | 'daily';
      dateFrom: string;
      dateTo: string;
      nmId: number;
      vendorCode: string | null;

      revenueKopecks: number; // retail_price_withdisc_rub
      incomeFromSalesKopecks: number; // ppvz_for_pay

      logisticsKopecks: number; // delivery_rub
      paidAcceptanceKopecks: number; // acceptance
      storageKopecks: number; // storage_fee
      penaltiesKopecks: number; // penalty
      otherHoldKopecks: number; // deduction
      additionalPaymentsKopecks: number; // additional_payment

      costsKopecks: number;
      taxKopecks: number;
      netTransferKopecks: number;
      netProfitKopecks: number;

      lines: number;
    };

    const sums = new Map<Key, Agg>();

    let rrdid = 0;
    while (true) {
      const url = `https://statistics-api.wildberries.ru/api/v5/supplier/reportDetailByPeriod?dateFrom=${encodeURIComponent(
        query.dateFrom
      )}&dateTo=${encodeURIComponent(query.dateTo)}&limit=100000&rrdid=${rrdid}&period=${period}`;

      const rows = await wbGetJson(url, apiKey);
      if (!Array.isArray(rows) || rows.length === 0) break;

      for (const row of rows) {
        const nmId = Number(row?.nm_id);
        if (!Number.isFinite(nmId) || nmId <= 0) continue;

        const dateFrom = String(row?.date_from ?? '').slice(0, 10);
        const dateTo = String(row?.date_to ?? '').slice(0, 10);
        if (!dateFrom || !dateTo) continue;

        const key = `${dateFrom}|${dateTo}|${nmId}` as const;
        let agg = sums.get(key);
        if (!agg) {
          agg = {
            workspaceId: params.workspaceId,
            period,
            dateFrom,
            dateTo,
            nmId,
            vendorCode: null,

            revenueKopecks: 0,
            incomeFromSalesKopecks: 0,

            logisticsKopecks: 0,
            paidAcceptanceKopecks: 0,
            storageKopecks: 0,
            penaltiesKopecks: 0,
            otherHoldKopecks: 0,
            additionalPaymentsKopecks: 0,

            costsKopecks: 0,
            taxKopecks: 0,
            netTransferKopecks: 0,
            netProfitKopecks: 0,

            lines: 0,
          };
          sums.set(key, agg);
        }

        agg.lines += 1;

        agg.revenueKopecks += kopecks(row?.retail_price_withdisc_rub);
        agg.incomeFromSalesKopecks += kopecks(row?.ppvz_for_pay);

        agg.logisticsKopecks += kopecks(row?.delivery_rub);
        agg.paidAcceptanceKopecks += kopecks(row?.acceptance);
        agg.storageKopecks += kopecks(row?.storage_fee);
        agg.penaltiesKopecks += kopecks(row?.penalty);
        agg.otherHoldKopecks += kopecks(row?.deduction);
        agg.additionalPaymentsKopecks += kopecks(row?.additional_payment);

        const next = row?.rrd_id;
        if (typeof next === 'number' && next > rrdid) rrdid = next;
      }

      if (rows.length < 100000) break;
    }

    const out = Array.from(sums.values());

    // vendorCode enrichment (best-effort)
    const nmIds = [...new Set(out.map((r) => r.nmId))];
    if (nmIds.length > 0) {
      const cards = await db
        .select({ nmId: wbCards.nmId, vendorCode: wbCards.vendorCode })
        .from(wbCards)
        .where(and(eq(wbCards.workspaceId, params.workspaceId), inArray(wbCards.nmId, nmIds)));
      const map = new Map(cards.map((c) => [c.nmId, c.vendorCode] as const));
      for (const r of out) r.vendorCode = map.get(r.nmId) ?? null;
    }

    for (const r of out) {
      r.costsKopecks =
        r.logisticsKopecks +
        r.paidAcceptanceKopecks +
        r.storageKopecks +
        r.penaltiesKopecks +
        r.otherHoldKopecks +
        r.additionalPaymentsKopecks;

      r.netTransferKopecks = r.incomeFromSalesKopecks - r.costsKopecks;
      r.taxKopecks = Math.round(taxRate * r.netTransferKopecks);
      r.netProfitKopecks = r.netTransferKopecks - r.taxKopecks;
    }

    out.sort((a, b) => {
      if (a.dateFrom !== b.dateFrom) return a.dateFrom < b.dateFrom ? 1 : -1;
      return b.netProfitKopecks - a.netProfitKopecks;
    });

    return {
      workspaceId: params.workspaceId,
      period,
      source: 'live',
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
      taxRate,
      rows: out,
    };
  });

  // Finance weekly-products cache: health
  app.get('/wb/:workspaceId/finance/weekly-products/health', { preHandler: requireRole('viewer') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);

    const latest = await db
      .select({
        updatedAt: wbFinanceWeeklyProducts.updatedAt,
        dateFrom: wbFinanceWeeklyProducts.dateFrom,
        dateTo: wbFinanceWeeklyProducts.dateTo,
      })
      .from(wbFinanceWeeklyProducts)
      .where(eq(wbFinanceWeeklyProducts.workspaceId, params.workspaceId))
      .orderBy(desc(wbFinanceWeeklyProducts.updatedAt))
      .limit(1);

    const all = await db
      .select({ nmId: wbFinanceWeeklyProducts.nmId })
      .from(wbFinanceWeeklyProducts)
      .where(eq(wbFinanceWeeklyProducts.workspaceId, params.workspaceId));

    return {
      workspaceId: params.workspaceId,
      count: all.length,
      latest: latest[0]
        ? {
            updatedAt: new Date(latest[0].updatedAt).toISOString(),
            dateFrom: latest[0].dateFrom,
            dateTo: latest[0].dateTo,
          }
        : null,
    };
  });

  // Finance weekly-products cache: start sync (async background)
  app.post('/wb/:workspaceId/finance/weekly-products/sync/start', { preHandler: requireRole('manager') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z
      .object({
        daysBack: z.coerce.number().int().min(7).max(2000).optional(),
        windowDays: z.coerce.number().int().min(7).max(365).optional(),
      })
      .optional()
      .parse(req.body);

    const ws = await db
      .select({ workspaceId: workspaces.workspaceId })
      .from(workspaces)
      .where(eq(workspaces.workspaceId, params.workspaceId));
    if (ws.length === 0) throw new NotFoundError('Workspace not found');

    const daysBack = body?.daysBack ?? 45;
    const windowDays = body?.windowDays ?? 60;

    const { guardedSpawn } = await import('../lib/guardedSpawn.js');
    const result = await guardedSpawn(
      params.workspaceId,
      'wb:finance:weekly-products:to-db',
      'finance-weekly-products',
      {
        DAYS_BACK: String(daysBack),
        WINDOW_DAYS: String(windowDays),
      },
    );

    if (!result.ok) {
      throw new ConflictError(`Finance sync already in progress for workspace ${params.workspaceId}`, {
        activeRunId: result.activeRunId,
        activeStage: result.activeStage,
      });
    }

    return { ...result, daysBack, windowDays };
  });
};
