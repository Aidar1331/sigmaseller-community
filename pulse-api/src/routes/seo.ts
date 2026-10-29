import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { eq, and, desc, asc, gte, lte, sql, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { requireRole } from '../plugins/roleCheck.js';
import { extractShopId } from '../plugins/shopFilter.js';
import {
  seoKeywords,
  seoKeywordProducts,
  seoPositionSnapshots,
  seoAlerts,
  seoAddresses,
  seoSettings,
  seoCompetitors,
  seoCompetitorKeywords,
  seoCompetitorPositions,
  seoKeywordTags,
  seoKeywordTagLinks,
  marketplaceShops,
  wbSyncRuns,
} from '../db/schema.js';
import { findProductPositions, getSearchSuggestions, searchWb, getRateLimitStatus, checkPositions } from '../integrations/wb/search.js';
import log from '../lib/logger.js';

const seoLogger = log.child({ module: 'seo-refresh' });

// Schemas
const createKeywordSchema = z.object({
  keyword: z.string().min(1).max(200),
  shopId: z.number().optional(),
  nmIds: z.array(z.number()).min(1).max(50),
  alertThreshold: z.number().min(1).max(1000).optional(),
});

const updateKeywordSchema = z.object({
  keyword: z.string().min(1).max(200).optional(),
  isActive: z.boolean().optional(),
  alertThreshold: z.number().min(1).max(1000).nullable().optional(),
  nmIds: z.array(z.number()).min(1).max(50).optional(),
});

export const seoRoutes: FastifyPluginAsync = async (fastify) => {
  // ─────────────────────────────────────────────
  // POST /seo/:workspaceId/refresh
  // Kick off SEO data sync: search-queries + seo-positions.
  // Блокируется только при реально работающем предыдущем run'е.
  // Safety: зависший > 15 мин run считаем мёртвым и пускаем новый.
  // ─────────────────────────────────────────────
  const SEO_REFRESH_STAGE_PREFIX = 'seo-refresh:';
  const SEO_REFRESH_STUCK_MS = 15 * 60 * 1000;

  const STAGE_LABEL: Record<string, string> = {
    starting: 'запуск',
    'search-queries:running': 'поисковые запросы',
    'seo-positions:running': 'позиции в выдаче',
  };

  function describeStage(stage: string): string {
    const suffix = stage.replace(SEO_REFRESH_STAGE_PREFIX, '');
    return STAGE_LABEL[suffix] ?? suffix;
  }

  fastify.post<{ Params: { workspaceId: string } }>(
    '/:workspaceId/refresh',
    { preHandler: requireRole('manager') },
    async (request, reply) => {
      const workspaceId = Number(request.params.workspaceId);

      const [running] = await db
        .select({ runId: wbSyncRuns.runId, createdAt: wbSyncRuns.createdAt, stage: wbSyncRuns.stage })
        .from(wbSyncRuns)
        .where(and(
          eq(wbSyncRuns.workspaceId, workspaceId),
          sql`${wbSyncRuns.stage} LIKE ${SEO_REFRESH_STAGE_PREFIX + '%'}`,
          eq(wbSyncRuns.status, 'running'),
        ))
        .orderBy(desc(wbSyncRuns.createdAt))
        .limit(1);

      if (running?.createdAt) {
        const age = Date.now() - new Date(running.createdAt).getTime();
        if (age < SEO_REFRESH_STUCK_MS) {
          const stageLabel = describeStage(running.stage);
          const ageMin = Math.floor(age / 60_000);
          return reply.status(429).send({
            error: 'already-running',
            message: `SEO-обновление уже идёт (${stageLabel}${ageMin ? `, ~${ageMin} мин` : ''}). Дождитесь завершения.`,
            currentStage: running.stage,
            startedSecondsAgo: Math.floor(age / 1000),
          });
        }
        // Старше 15 мин — считаем зависшим, пометим failed и пустим новый
        seoLogger.warn({ workspaceId, runId: running.runId, ageMs: age }, 'marking stuck seo-refresh as failed');
        await db.update(wbSyncRuns)
          .set({ stage: `${SEO_REFRESH_STAGE_PREFIX}stuck`, status: 'failed', finishedAt: new Date(), updatedAt: new Date() })
          .where(eq(wbSyncRuns.runId, running.runId));
      }

      const { randomUUID } = await import('node:crypto');
      const runId = randomUUID();
      await db.insert(wbSyncRuns).values({
        runId,
        workspaceId,
        shopId: null,
        stage: `${SEO_REFRESH_STAGE_PREFIX}starting`,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Запускаем в фоне, не блокируем ответ — клиент увидит прогресс через
      // отдельный опрос /seo данных.
      const started = Date.now();
      seoLogger.info({ workspaceId, runId }, 'seo-refresh started');
      (async () => {
        try {
          seoLogger.info({ workspaceId, runId }, 'seo-refresh: search-queries stage');
          await db.update(wbSyncRuns)
            .set({ stage: `${SEO_REFRESH_STAGE_PREFIX}search-queries:running`, updatedAt: new Date() })
            .where(eq(wbSyncRuns.runId, runId));
          const { runSearchQueriesSync } = await import('../jobs/searchQueriesSync.js');
          await runSearchQueriesSync();

          seoLogger.info({ workspaceId, runId }, 'seo-refresh: seo-positions stage');
          await db.update(wbSyncRuns)
            .set({ stage: `${SEO_REFRESH_STAGE_PREFIX}seo-positions:running`, updatedAt: new Date() })
            .where(eq(wbSyncRuns.runId, runId));
          const { runSeoPositionsDaily } = await import('../jobs/seoPositionsDaily.js');
          await runSeoPositionsDaily();

          // NOTE (2026-04-22): SEO-agent analysis was previously chained
          // into this refresh so users "saw alerts without a second
          // click". It was removed because:
          //   - an agent run costs AI tokens on every sync;
          //   - Claude outages propagated as sync failures;
          //   - sync-runs stayed "running" 1-3 min longer than the data
          //     actually needed.
          // Users now press «Проанализировать» on /seo to trigger
          // runSeoAgentPersisted via POST /seo/:workspaceId/agent-run.

          await db.update(wbSyncRuns)
            .set({ stage: `${SEO_REFRESH_STAGE_PREFIX}done`, status: 'done', finishedAt: new Date(), updatedAt: new Date() })
            .where(eq(wbSyncRuns.runId, runId));
          seoLogger.info({ workspaceId, runId, durationMs: Date.now() - started }, 'seo-refresh done');
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          seoLogger.error({ err, workspaceId, runId, durationMs: Date.now() - started }, 'seo-refresh failed');
          await db.update(wbSyncRuns)
            .set({ stage: `${SEO_REFRESH_STAGE_PREFIX}failed`, status: 'failed', error: message.slice(0, 500), finishedAt: new Date(), updatedAt: new Date() })
            .where(eq(wbSyncRuns.runId, runId));
        }
      })().catch((err) => {
        seoLogger.error({ err, workspaceId, runId }, 'seo-refresh unhandled background error');
      });

      return reply.send({
        ok: true,
        runId,
        triggered: ['search-queries', 'seo-positions'],
        message: 'Обновление запущено в фоне. Данные появятся через 5–10 минут.',
      });
    },
  );

  // ─────────────────────────────────────────────
  // POST /seo/:workspaceId/agent-run
  // On-demand SEO-agent analysis. Decoupled from /refresh on 2026-04-22
  // so AI tokens are spent deliberately (user action), sync failures
  // don't mask agent failures, and Claude outages don't break sync.
  // Dedup: the runner itself applies a 48h dedup key per workspace.
  // ─────────────────────────────────────────────
  const SEO_AGENT_STAGE = 'seo-agent:manual';
  const SEO_AGENT_STUCK_MS = 10 * 60 * 1000; // agent runs are typically 1-3 min

  fastify.post<{ Params: { workspaceId: string } }>(
    '/:workspaceId/agent-run',
    { preHandler: requireRole('manager') },
    async (request, reply) => {
      const workspaceId = Number(request.params.workspaceId);

      // Per-workspace dedup: reject if an agent run is already active.
      // Older than SEO_AGENT_STUCK_MS → treat as zombie and start over.
      const [running] = await db
        .select({ runId: wbSyncRuns.runId, createdAt: wbSyncRuns.createdAt })
        .from(wbSyncRuns)
        .where(and(
          eq(wbSyncRuns.workspaceId, workspaceId),
          eq(wbSyncRuns.stage, SEO_AGENT_STAGE),
          eq(wbSyncRuns.status, 'running'),
        ))
        .orderBy(desc(wbSyncRuns.createdAt))
        .limit(1);

      if (running?.createdAt) {
        const age = Date.now() - new Date(running.createdAt).getTime();
        if (age < SEO_AGENT_STUCK_MS) {
          return reply.status(429).send({
            error: 'already-running',
            message: 'Анализ уже идёт. Дождитесь завершения (обычно 1-3 минуты).',
            startedSecondsAgo: Math.floor(age / 1000),
          });
        }
        await db.update(wbSyncRuns)
          .set({ status: 'failed', finishedAt: new Date(), updatedAt: new Date(), error: 'auto-reset: stuck >10min' })
          .where(eq(wbSyncRuns.runId, running.runId));
      }

      const { randomUUID } = await import('node:crypto');
      const runId = randomUUID();
      await db.insert(wbSyncRuns).values({
        runId,
        workspaceId,
        shopId: null,
        stage: SEO_AGENT_STAGE,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const started = Date.now();
      seoLogger.info({ workspaceId, runId }, 'seo-agent manual run started');

      // Fire-and-forget so the HTTP response returns immediately and
      // the frontend polls for completion via agent_events / alerts.
      (async () => {
        try {
          const { runSeoAgentPersisted } = await import('../agents/specialized/runners/seoRunner.js');
          await runSeoAgentPersisted({ workspaceId, shopId: null, trigger: 'manual' });
          await db.update(wbSyncRuns)
            .set({ status: 'done', finishedAt: new Date(), updatedAt: new Date() })
            .where(eq(wbSyncRuns.runId, runId));
          seoLogger.info({ workspaceId, runId, durationMs: Date.now() - started }, 'seo-agent manual run done');
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await db.update(wbSyncRuns)
            .set({ status: 'failed', finishedAt: new Date(), updatedAt: new Date(), error: message.slice(0, 500) })
            .where(eq(wbSyncRuns.runId, runId));
          seoLogger.error({ err, workspaceId, runId }, 'seo-agent manual run failed');
        }
      })().catch((err) => {
        seoLogger.error({ err, workspaceId, runId }, 'seo-agent unhandled background error');
      });

      return reply.send({
        ok: true,
        runId,
        message: 'Анализ запущен. Рекомендации появятся в блоке «Алерты» через 1-3 минуты.',
      });
    },
  );

  // ─────────────────────────────────────────────
  // GET /seo/:workspaceId/keywords
  // List all keywords for workspace
  // ─────────────────────────────────────────────
  fastify.get<{
    Params: { workspaceId: string };
    Querystring: { shopId?: string; includeLatest?: string };
  }>('/:workspaceId/keywords', { preHandler: requireRole('viewer') }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const shopId = request.query.shopId ? Number(request.query.shopId) : undefined;
    const includeLatest = request.query.includeLatest === 'true';

    // shopId-aware filter: keyword's shopId matches OR keyword has no shop (общий).
    // Consistent with /dashboard endpoint — иначе появляется рассинхронизация
    // между «всего N ключей» и пустой таблицей.
    let query = db
      .select()
      .from(seoKeywords)
      .where(
        shopId
          ? and(
              eq(seoKeywords.workspaceId, workspaceId),
              sql`(${seoKeywords.shopId} = ${shopId} OR ${seoKeywords.shopId} IS NULL)`,
            )
          : eq(seoKeywords.workspaceId, workspaceId)
      )
      .orderBy(desc(seoKeywords.createdAt));

    const keywords = await query;

    // Get products for each keyword
    const keywordIds = keywords.map((k) => k.keywordId);
    const products =
      keywordIds.length > 0
        ? await db.select().from(seoKeywordProducts).where(inArray(seoKeywordProducts.keywordId, keywordIds))
        : [];

    const productsByKeyword = new Map<number, number[]>();
    for (const p of products) {
      const list = productsByKeyword.get(p.keywordId) || [];
      list.push(p.nmId);
      productsByKeyword.set(p.keywordId, list);
    }

    // Optionally get latest positions
    let latestPositions = new Map<string, any>();
    // Sparkline-данные для редизайна: лучшая позиция (min среди nmId) на каждый
    // из последних 14 дней. Используется для mini-trend в строке таблицы.
    const sparklineByKw = new Map<number, Array<{ d: string; p: number | null }>>();

    if (includeLatest && keywordIds.length > 0) {
      const keywordIdsList = keywordIds.map(id => sql`${id}`);
      const snapshots = await db.execute(sql`
        SELECT DISTINCT ON (keyword_id, nm_id)
          keyword_id, nm_id, position, page, is_promo, cpm, checked_at
        FROM seo_position_snapshots
        WHERE keyword_id IN (${sql.join(keywordIdsList, sql`, `)})
        ORDER BY keyword_id, nm_id, checked_at DESC
      `);

      for (const s of snapshots.rows as any[]) {
        latestPositions.set(`${s.keyword_id}-${s.nm_id}`, s);
      }

      // Trend data: best position per (keyword, day) за 14 дней.
      const trend = await db.execute<{ keyword_id: number; d: string; best_pos: number | null }>(sql`
        SELECT
          keyword_id,
          DATE(checked_at) AS d,
          MIN(position) AS best_pos
        FROM seo_position_snapshots
        WHERE keyword_id IN (${sql.join(keywordIdsList, sql`, `)})
          AND checked_at >= NOW() - INTERVAL '14 days'
          AND position IS NOT NULL
        GROUP BY keyword_id, DATE(checked_at)
        ORDER BY keyword_id, d
      `);
      for (const t of ((trend as any).rows ?? trend) as any[]) {
        const kid = Number(t.keyword_id);
        const list = sparklineByKw.get(kid) ?? [];
        list.push({ d: String(t.d), p: t.best_pos != null ? Number(t.best_pos) : null });
        sparklineByKw.set(kid, list);
      }
    }

    return keywords.map((k) => ({
      ...k,
      nmIds: productsByKeyword.get(k.keywordId) || [],
      latestPositions: includeLatest
        ? (productsByKeyword.get(k.keywordId) || []).map((nmId) => ({
            nmId,
            ...latestPositions.get(`${k.keywordId}-${nmId}`),
          }))
        : undefined,
      sparkline: includeLatest ? sparklineByKw.get(k.keywordId) ?? [] : undefined,
    }));
  });

  // ─────────────────────────────────────────────
  // POST /seo/:workspaceId/keywords
  // Create a new keyword to track
  // ─────────────────────────────────────────────
  // Max keywords per workspace
  const MAX_KEYWORDS_PER_WORKSPACE = 500;
  
  fastify.post<{
    Params: { workspaceId: string };
    Body: z.infer<typeof createKeywordSchema>;
  }>('/:workspaceId/keywords', { preHandler: requireRole('manager') }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const body = createKeywordSchema.parse(request.body);

    // Check keywords limit
    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(seoKeywords)
      .where(eq(seoKeywords.workspaceId, workspaceId));
    
    if ((countResult?.count ?? 0) >= MAX_KEYWORDS_PER_WORKSPACE) {
      return reply.status(400).send({ 
        error: `Maximum ${MAX_KEYWORDS_PER_WORKSPACE} keywords per workspace` 
      });
    }

    // Check shop belongs to workspace if provided
    if (body.shopId) {
      const shop = await db
        .select()
        .from(marketplaceShops)
        .where(and(eq(marketplaceShops.shopId, body.shopId), eq(marketplaceShops.workspaceId, workspaceId)))
        .limit(1);

      if (shop.length === 0) {
        return reply.status(404).send({ error: 'Shop not found' });
      }
    }

    // Create keyword
    const [keyword] = await db
      .insert(seoKeywords)
      .values({
        workspaceId,
        shopId: body.shopId || null,
        keyword: body.keyword.toLowerCase().trim(),
        alertThreshold: body.alertThreshold || null,
      })
      .returning();

    // Add products
    if (body.nmIds.length > 0) {
      await db.insert(seoKeywordProducts).values(
        body.nmIds.map((nmId) => ({
          keywordId: keyword.keywordId,
          nmId,
        }))
      );
    }

    return { ...keyword, nmIds: body.nmIds };
  });

  // ─────────────────────────────────────────────
  // PATCH /seo/:workspaceId/keywords/:keywordId
  // Update keyword settings
  // ─────────────────────────────────────────────
  fastify.patch<{
    Params: { workspaceId: string; keywordId: string };
    Body: z.infer<typeof updateKeywordSchema>;
  }>('/:workspaceId/keywords/:keywordId', { preHandler: requireRole('manager') }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const keywordId = Number(request.params.keywordId);
    const body = updateKeywordSchema.parse(request.body);

    // Verify ownership
    const existing = await db
      .select()
      .from(seoKeywords)
      .where(and(eq(seoKeywords.keywordId, keywordId), eq(seoKeywords.workspaceId, workspaceId)))
      .limit(1);

    if (existing.length === 0) {
      return reply.status(404).send({ error: 'Keyword not found' });
    }

    // Update keyword
    const updates: any = { updatedAt: new Date() };
    if (body.keyword !== undefined) updates.keyword = body.keyword.toLowerCase().trim();
    if (body.isActive !== undefined) updates.isActive = body.isActive;
    if (body.alertThreshold !== undefined) updates.alertThreshold = body.alertThreshold;

    const [updated] = await db
      .update(seoKeywords)
      .set(updates)
      .where(eq(seoKeywords.keywordId, keywordId))
      .returning();

    // Update products if provided
    if (body.nmIds !== undefined) {
      await db.delete(seoKeywordProducts).where(eq(seoKeywordProducts.keywordId, keywordId));

      if (body.nmIds.length > 0) {
        await db.insert(seoKeywordProducts).values(
          body.nmIds.map((nmId) => ({
            keywordId,
            nmId,
          }))
        );
      }
    }

    return { ...updated, nmIds: body.nmIds || [] };
  });

  // ─────────────────────────────────────────────
  // DELETE /seo/:workspaceId/keywords/:keywordId
  // Delete a keyword
  // ─────────────────────────────────────────────
  fastify.delete<{
    Params: { workspaceId: string; keywordId: string };
  }>('/:workspaceId/keywords/:keywordId', { preHandler: requireRole('owner') }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const keywordId = Number(request.params.keywordId);

    const result = await db
      .delete(seoKeywords)
      .where(and(eq(seoKeywords.keywordId, keywordId), eq(seoKeywords.workspaceId, workspaceId)))
      .returning();

    if (result.length === 0) {
      return reply.status(404).send({ error: 'Keyword not found' });
    }

    return { success: true };
  });

  // ─────────────────────────────────────────────
  // GET /seo/:workspaceId/keywords/:keywordId/history
  // Get position history for a keyword
  // ─────────────────────────────────────────────
  fastify.get<{
    Params: { workspaceId: string; keywordId: string };
    Querystring: { nmId?: string; from?: string; to?: string; limit?: string };
  }>('/:workspaceId/keywords/:keywordId/history', { preHandler: requireRole('viewer') }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const keywordId = Number(request.params.keywordId);
    const nmId = request.query.nmId ? Number(request.query.nmId) : undefined;
    const from = request.query.from ? new Date(request.query.from) : undefined;
    const to = request.query.to ? new Date(request.query.to) : undefined;
    const limit = Math.min(Number(request.query.limit) || 100, 1000);

    // Verify ownership
    const keyword = await db
      .select()
      .from(seoKeywords)
      .where(and(eq(seoKeywords.keywordId, keywordId), eq(seoKeywords.workspaceId, workspaceId)))
      .limit(1);

    if (keyword.length === 0) {
      return reply.status(404).send({ error: 'Keyword not found' });
    }

    let conditions = [eq(seoPositionSnapshots.keywordId, keywordId)];
    if (nmId) conditions.push(eq(seoPositionSnapshots.nmId, nmId));
    if (from) conditions.push(gte(seoPositionSnapshots.checkedAt, from));
    if (to) conditions.push(lte(seoPositionSnapshots.checkedAt, to));

    const snapshots = await db
      .select()
      .from(seoPositionSnapshots)
      .where(and(...conditions))
      .orderBy(desc(seoPositionSnapshots.checkedAt))
      .limit(limit);

    return {
      keyword: keyword[0],
      snapshots,
    };
  });

  // ─────────────────────────────────────────────
  // GET /seo/:workspaceId/heatmap
  // Get position history for all keywords (for heatmap like Pulse)
  // ─────────────────────────────────────────────
  fastify.get<{
    Params: { workspaceId: string };
    Querystring: { nmId?: string; from?: string; to?: string };
  }>('/:workspaceId/heatmap', { preHandler: requireRole('viewer') }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const nmIdFilter = request.query.nmId ? Number(request.query.nmId) : undefined;
    
    // Default: last 14 days
    const to = request.query.to ? new Date(request.query.to) : new Date();
    const from = request.query.from ? new Date(request.query.from) : new Date(to.getTime() - 14 * 24 * 60 * 60 * 1000);

    // Get all keywords for workspace (with optional nmId filter)
    let keywordsQuery = db
      .select({
        keywordId: seoKeywords.keywordId,
        keyword: seoKeywords.keyword,
        nmId: seoKeywordProducts.nmId,
      })
      .from(seoKeywords)
      .leftJoin(seoKeywordProducts, eq(seoKeywords.keywordId, seoKeywordProducts.keywordId))
      .where(and(
        eq(seoKeywords.workspaceId, workspaceId),
        eq(seoKeywords.isActive, true),
        nmIdFilter ? eq(seoKeywordProducts.nmId, nmIdFilter) : sql`1=1`
      ))
      .orderBy(seoKeywords.keyword);

    const keywords = await keywordsQuery;

    if (keywords.length === 0) {
      return { keywords: [], dates: [], data: {} };
    }

    const keywordIds = keywords.map(k => k.keywordId);

    // Get all snapshots in date range
    const snapshots = await db
      .select({
        keywordId: seoPositionSnapshots.keywordId,
        position: seoPositionSnapshots.position,
        page: seoPositionSnapshots.page,
        checkedAt: seoPositionSnapshots.checkedAt,
      })
      .from(seoPositionSnapshots)
      .where(and(
        inArray(seoPositionSnapshots.keywordId, keywordIds),
        gte(seoPositionSnapshots.checkedAt, from),
        lte(seoPositionSnapshots.checkedAt, to)
      ))
      .orderBy(seoPositionSnapshots.checkedAt);

    // Group by date (YYYY-MM-DD)
    const dateSet = new Set<string>();
    const dataMap: Record<number, Record<string, { position: number | null; page: number | null }>> = {};

    for (const snap of snapshots) {
      const date = snap.checkedAt.toISOString().slice(0, 10);
      dateSet.add(date);
      
      if (!dataMap[snap.keywordId]) {
        dataMap[snap.keywordId] = {};
      }
      // Keep latest snapshot for each date
      dataMap[snap.keywordId][date] = {
        position: snap.position,
        page: snap.page,
      };
    }

    const dates = Array.from(dateSet).sort();

    return {
      keywords,
      dates,
      data: dataMap,
    };
  });

  // ─────────────────────────────────────────────
  // POST /seo/:workspaceId/keywords/:keywordId/check
  // Manually trigger position check for a keyword
  // ─────────────────────────────────────────────
  fastify.post<{
    Params: { workspaceId: string; keywordId: string };
  }>('/:workspaceId/keywords/:keywordId/check', { preHandler: requireRole('manager') }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const keywordId = Number(request.params.keywordId);

    // Get keyword and products
    const keyword = await db
      .select()
      .from(seoKeywords)
      .where(and(eq(seoKeywords.keywordId, keywordId), eq(seoKeywords.workspaceId, workspaceId)))
      .limit(1);

    if (keyword.length === 0) {
      return reply.status(404).send({ error: 'Keyword not found' });
    }

    const products = await db
      .select()
      .from(seoKeywordProducts)
      .where(eq(seoKeywordProducts.keywordId, keywordId));

    if (products.length === 0) {
      return reply.status(400).send({ error: 'No products to track' });
    }

    const nmIds = products.map((p) => p.nmId);

    // Find positions
    const { positions, totalProducts } = await findProductPositions(keyword[0].keyword, nmIds);

    // Get previous positions for alerting
    const previousSnapshots = await db.execute(sql`
      SELECT DISTINCT ON (nm_id) nm_id, position
      FROM seo_position_snapshots
      WHERE keyword_id = ${keywordId}
      ORDER BY nm_id, checked_at DESC
    `);
    const previousByNm = new Map((previousSnapshots.rows as any[]).map((r) => [r.nm_id, r.position]));

    // Save snapshots
    const now = new Date();
    const snapshotValues = positions.map((p) => ({
      keywordId,
      nmId: p.nmId,
      position: p.position,
      page: p.page,
      totalProducts,
      cpm: p.cpm,
      isPromo: p.isPromo,
      checkedAt: now,
    }));

    await db.insert(seoPositionSnapshots).values(snapshotValues);

    // Update lastCheckedAt
    await db
      .update(seoKeywords)
      .set({ lastCheckedAt: now, updatedAt: now })
      .where(eq(seoKeywords.keywordId, keywordId));

    // Create alerts for significant changes
    const alertThreshold = keyword[0].alertThreshold || 100;
    const alerts: any[] = [];

    for (const p of positions) {
      const prev = previousByNm.get(p.nmId);

      if (prev !== undefined && p.position !== null) {
        // Position dropped significantly
        if (p.position > prev && p.position - prev >= 10) {
          alerts.push({
            keywordId,
            nmId: p.nmId,
            previousPosition: prev,
            currentPosition: p.position,
            alertType: 'dropped',
          });
        }
        // Position recovered
        else if (p.position < prev && prev - p.position >= 10) {
          alerts.push({
            keywordId,
            nmId: p.nmId,
            previousPosition: prev,
            currentPosition: p.position,
            alertType: 'recovered',
          });
        }
      } else if (prev !== undefined && p.position === null) {
        // Lost from search
        alerts.push({
          keywordId,
          nmId: p.nmId,
          previousPosition: prev,
          currentPosition: null,
          alertType: 'lost',
        });
      }
    }

    if (alerts.length > 0) {
      await db.insert(seoAlerts).values(alerts);
    }

    return {
      keyword: keyword[0].keyword,
      totalProducts,
      positions,
      alerts: alerts.length,
    };
  });

  // ─────────────────────────────────────────────
  // GET /seo/:workspaceId/alerts
  // Get alerts for workspace
  // ─────────────────────────────────────────────
  fastify.get<{
    Params: { workspaceId: string };
    Querystring: { unreadOnly?: string; limit?: string; shopId?: string };
  }>('/:workspaceId/alerts', { preHandler: requireRole('viewer') }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const unreadOnly = request.query.unreadOnly === 'true';
    const shopId = request.query.shopId ? Number(request.query.shopId) : undefined;
    const limit = Math.min(Number(request.query.limit) || 50, 200);

    const conds = [eq(seoKeywords.workspaceId, workspaceId)];
    if (unreadOnly) conds.push(eq(seoAlerts.isRead, false));
    // shopId-aware фильтрация: включаем и keywords конкретного shop'а,
    // и keywords без привязки (shop_id IS NULL) — они общие для workspace'а.
    if (shopId) conds.push(sql`(${seoKeywords.shopId} = ${shopId} OR ${seoKeywords.shopId} IS NULL)`);

    const alerts = await db
      .select({
        alert: seoAlerts,
        keyword: seoKeywords.keyword,
      })
      .from(seoAlerts)
      .innerJoin(seoKeywords, eq(seoAlerts.keywordId, seoKeywords.keywordId))
      .where(and(...conds))
      .orderBy(desc(seoAlerts.createdAt))
      .limit(limit);

    return alerts.map((a) => ({
      ...a.alert,
      keyword: a.keyword,
    }));
  });

  // ─────────────────────────────────────────────
  // POST /seo/:workspaceId/alerts/mark-read
  // Mark alerts as read
  // ─────────────────────────────────────────────
  fastify.post<{
    Params: { workspaceId: string };
    Body: { alertIds: number[] };
  }>('/:workspaceId/alerts/mark-read', { preHandler: requireRole('manager') }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const { alertIds } = request.body;

    if (!alertIds || alertIds.length === 0) {
      return { updated: 0 };
    }

    // Verify alerts belong to workspace
    const result = await db
      .update(seoAlerts)
      .set({ isRead: true })
      .where(
        and(
          inArray(seoAlerts.alertId, alertIds),
          inArray(
            seoAlerts.keywordId,
            db.select({ id: seoKeywords.keywordId }).from(seoKeywords).where(eq(seoKeywords.workspaceId, workspaceId))
          )
        )
      )
      .returning();

    return { updated: result.length };
  });

  // ─────────────────────────────────────────────
  // GET /seo/:workspaceId/suggestions
  // Get search suggestions for autocomplete
  // ─────────────────────────────────────────────
  fastify.get<{
    Params: { workspaceId: string };
    Querystring: { q: string };
  }>('/:workspaceId/suggestions', { preHandler: requireRole('viewer') }, async (request, reply) => {
    const query = request.query.q;

    if (!query || query.length < 2) {
      return { suggestions: [] };
    }

    const suggestions = await getSearchSuggestions(query);
    return { suggestions };
  });

  // ─────────────────────────────────────────────
  // GET /seo/:workspaceId/dashboard
  // Overview dashboard with stats
  // ─────────────────────────────────────────────
  fastify.get<{
    Params: { workspaceId: string };
    Querystring: { shopId?: string };
  }>('/:workspaceId/dashboard', { preHandler: requireRole('viewer') }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const shopId = request.query.shopId ? Number(request.query.shopId) : undefined;

    // shopId-aware фильтр: keywords конкретного shop'а ИЛИ без привязки (общие).
    const shopFilter = shopId
      ? sql`(${seoKeywords.shopId} = ${shopId} OR ${seoKeywords.shopId} IS NULL)`
      : sql`TRUE`;

    const keywordCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(seoKeywords)
      .where(and(eq(seoKeywords.workspaceId, workspaceId), shopFilter));

    const activeCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(seoKeywords)
      .where(and(eq(seoKeywords.workspaceId, workspaceId), eq(seoKeywords.isActive, true), shopFilter));

    const alertCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(seoAlerts)
      .innerJoin(seoKeywords, eq(seoAlerts.keywordId, seoKeywords.keywordId))
      .where(and(eq(seoKeywords.workspaceId, workspaceId), eq(seoAlerts.isRead, false), shopFilter));

    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentSnapshots = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(seoPositionSnapshots)
      .innerJoin(seoKeywords, eq(seoPositionSnapshots.keywordId, seoKeywords.keywordId))
      .where(and(eq(seoKeywords.workspaceId, workspaceId), gte(seoPositionSnapshots.checkedAt, oneDayAgo), shopFilter));

    // ── Top-N counts + week-over-week delta + rising/falling ───────────────
    // Берём только активные ключи. Для каждого ключа считаем «лучшую позицию»
    // среди всех его nmId на момент СВЕЖАЙШЕГО snapshot (per nmId). NULL =
    // не найден в top 300 — игнорируется. Сравниваем с такой же агрегацией
    // на момент 7 дней назад.

    const counts = await db.execute<{
      in_top10_now: number;
      in_top50_now: number;
      in_top10_week_ago: number;
      in_top50_week_ago: number;
      gaining_week: number;
      dropping_week: number;
    }>(sql`
      WITH latest_pos AS (
        SELECT DISTINCT ON (sps.keyword_id, sps.nm_id)
          sps.keyword_id, sps.nm_id, sps.position
        FROM seo_position_snapshots sps
        INNER JOIN seo_keywords sk ON sk.keyword_id = sps.keyword_id
        WHERE sk.workspace_id = ${workspaceId}
          AND sk.is_active = true
          AND ${shopId ? sql`(sk.shop_id = ${shopId} OR sk.shop_id IS NULL)` : sql`TRUE`}
        ORDER BY sps.keyword_id, sps.nm_id, sps.checked_at DESC
      ),
      best_now AS (
        SELECT keyword_id, MIN(position) AS best_pos
        FROM latest_pos
        WHERE position IS NOT NULL
        GROUP BY keyword_id
      ),
      latest_pos_week_ago AS (
        SELECT DISTINCT ON (sps.keyword_id, sps.nm_id)
          sps.keyword_id, sps.nm_id, sps.position
        FROM seo_position_snapshots sps
        INNER JOIN seo_keywords sk ON sk.keyword_id = sps.keyword_id
        WHERE sk.workspace_id = ${workspaceId}
          AND sk.is_active = true
          AND ${shopId ? sql`(sk.shop_id = ${shopId} OR sk.shop_id IS NULL)` : sql`TRUE`}
          AND sps.checked_at <= NOW() - INTERVAL '7 days'
        ORDER BY sps.keyword_id, sps.nm_id, sps.checked_at DESC
      ),
      best_week_ago AS (
        SELECT keyword_id, MIN(position) AS best_pos
        FROM latest_pos_week_ago
        WHERE position IS NOT NULL
        GROUP BY keyword_id
      ),
      delta AS (
        SELECT
          n.keyword_id,
          n.best_pos AS pos_now,
          w.best_pos AS pos_week_ago
        FROM best_now n
        LEFT JOIN best_week_ago w ON w.keyword_id = n.keyword_id
        WHERE w.best_pos IS NOT NULL
      )
      SELECT
        (SELECT COUNT(*)::int FROM best_now WHERE best_pos <= 10) AS in_top10_now,
        (SELECT COUNT(*)::int FROM best_now WHERE best_pos <= 50) AS in_top50_now,
        (SELECT COUNT(*)::int FROM best_week_ago WHERE best_pos <= 10) AS in_top10_week_ago,
        (SELECT COUNT(*)::int FROM best_week_ago WHERE best_pos <= 50) AS in_top50_week_ago,
        (SELECT COUNT(*)::int FROM delta WHERE pos_now < pos_week_ago) AS gaining_week,
        (SELECT COUNT(*)::int FROM delta WHERE pos_now > pos_week_ago) AS dropping_week
    `);

    const c = ((counts as any).rows ?? counts)[0] ?? {};
    const inTop10 = Number(c.in_top10_now ?? 0);
    const inTop50 = Number(c.in_top50_now ?? 0);
    const inTop10WeekAgo = Number(c.in_top10_week_ago ?? 0);
    const inTop50WeekAgo = Number(c.in_top50_week_ago ?? 0);

    return {
      totalKeywords: keywordCount[0]?.count || 0,
      activeKeywords: activeCount[0]?.count || 0,
      unreadAlerts: alertCount[0]?.count || 0,
      checksLast24h: recentSnapshots[0]?.count || 0,
      // Новые KPI для редизайна (а-ля Helium 10)
      inTop10,
      inTop50,
      deltaTop10: inTop10 - inTop10WeekAgo,
      deltaTop50: inTop50 - inTop50WeekAgo,
      gainingThisWeek: Number(c.gaining_week ?? 0),
      droppingThisWeek: Number(c.dropping_week ?? 0),
    };
  });

  // ─────────────────────────────────────────────
  // POST /seo/:workspaceId/live-search
  // Live search for product positions (no DB storage)
  // ─────────────────────────────────────────────
  fastify.post<{
    Params: { workspaceId: string };
    Body: { keyword: string; nmIds: number[]; maxPages?: number };
  }>('/:workspaceId/live-search', { preHandler: requireRole('viewer') }, async (request, reply) => {
    const { keyword, nmIds, maxPages = 10 } = request.body;

    if (!keyword || keyword.length < 2) {
      return reply.status(400).send({ error: 'Keyword must be at least 2 characters' });
    }

    if (!nmIds || nmIds.length === 0) {
      return reply.status(400).send({ error: 'At least one nmId is required' });
    }

    if (nmIds.length > 50) {
      return reply.status(400).send({ error: 'Maximum 50 nmIds allowed' });
    }

    const { positions, totalProducts } = await findProductPositions(keyword, nmIds, maxPages);

    return {
      keyword,
      checkedAt: new Date().toISOString(),
      totalProducts,
      positions,
    };
  });

  // ─────────────────────────────────────────────
  // GET /seo/:workspaceId/ads
  // Get advertisers in search results with CPM
  // ─────────────────────────────────────────────
  fastify.get<{
    Params: { workspaceId: string };
    Querystring: { keyword: string };
  }>('/:workspaceId/ads', { preHandler: requireRole('viewer') }, async (request, reply) => {
    const { keyword } = request.query;

    if (!keyword || keyword.length < 2) {
      return reply.status(400).send({ error: 'Keyword must be at least 2 characters' });
    }

    // Import dynamically to avoid circular deps
    const { getSearchAds } = await import('../integrations/wb/seoPositions.js');
    
    const adsData = await getSearchAds(keyword);

    return {
      keyword,
      checkedAt: new Date().toISOString(),
      ...adsData,
    };
  });

  // ─────────────────────────────────────────────
  // GET /seo/:workspaceId/rate-limit
  // Get current rate limit status
  // ─────────────────────────────────────────────
  fastify.get<{
    Params: { workspaceId: string };
  }>('/:workspaceId/rate-limit', { preHandler: requireRole('viewer') }, async () => {
    const status = getRateLimitStatus();
    return {
      used: status.used,
      limit: status.limit,
      remaining: status.remaining,
      resetsInMinutes: Math.ceil(status.resetsIn / 60000),
      pagesPerKeyword: 3,
      estimatedKeywordsRemaining: Math.floor(status.remaining / 3),
    };
  });

  // ─────────────────────────────────────────────
  // POST /seo/:workspaceId/keywords/:keywordId/check-full
  // Full check: positions + all competitors with prices
  // ─────────────────────────────────────────────
  fastify.post<{
    Params: { workspaceId: string; keywordId: string };
    Body: { saveCompetitors?: boolean };
  }>('/:workspaceId/keywords/:keywordId/check-full', { preHandler: requireRole('manager') }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const keywordId = Number(request.params.keywordId);
    const saveCompetitors = request.body?.saveCompetitors !== false;

    // Get keyword and products
    const keyword = await db
      .select()
      .from(seoKeywords)
      .where(and(eq(seoKeywords.keywordId, keywordId), eq(seoKeywords.workspaceId, workspaceId)))
      .limit(1);

    if (keyword.length === 0) {
      return reply.status(404).send({ error: 'Keyword not found' });
    }

    const products = await db
      .select()
      .from(seoKeywordProducts)
      .where(eq(seoKeywordProducts.keywordId, keywordId));

    const nmIds = products.map((p) => p.nmId);

    // Search all 3 pages and get full competitor data
    const allProducts: any[] = [];
    let totalProducts = 0;

    for (let page = 1; page <= 3; page++) {
      try {
        const result = await searchWb(keyword[0].keyword, page);
        if (page === 1) totalProducts = result.total;
        
        allProducts.push(...result.products.map(p => ({
          ...p,
          page,
        })));

        if (result.products.length === 0) break;
      } catch (error: any) {
        if (error.message.includes('Rate limit')) {
          return reply.status(429).send({ 
            error: 'Rate limit exceeded',
            ...getRateLimitStatus(),
          });
        }
        throw error;
      }
    }

    const now = new Date();

    // Find our products positions
    const ourPositions = nmIds.map(nmId => {
      const found = allProducts.find(p => p.article === nmId);
      return {
        nmId,
        position: found?.position ?? null,
        page: found?.page ?? null,
        isPromo: found?.isPromo ?? false,
      };
    });

    // Save position snapshots
    if (ourPositions.length > 0) {
      await db.insert(seoPositionSnapshots).values(
        ourPositions.map(p => ({
          keywordId,
          nmId: p.nmId,
          position: p.position,
          page: p.page,
          totalProducts,
          isPromo: p.isPromo,
          checkedAt: now,
        }))
      );
    }

    // Save competitor data if enabled
    let competitorsSaved = 0;
    if (saveCompetitors) {
      // Get tracked competitors for this keyword
      const trackedCompetitors = await db
        .select({ competitorId: seoCompetitors.competitorId, nmId: seoCompetitors.nmId })
        .from(seoCompetitors)
        .innerJoin(seoCompetitorKeywords, eq(seoCompetitors.competitorId, seoCompetitorKeywords.competitorId))
        .where(and(
          eq(seoCompetitors.workspaceId, workspaceId),
          eq(seoCompetitorKeywords.keywordId, keywordId)
        ));

      // Save positions for tracked competitors
      for (const comp of trackedCompetitors) {
        const found = allProducts.find(p => p.article === comp.nmId);
        if (found) {
          await db.insert(seoCompetitorPositions).values({
            workspaceId,
            competitorId: comp.competitorId,
            keywordId,
            checkedAt: now,
            position: found.position,
            page: found.page,
            price: found.price,
            originalPrice: found.originalPrice,
            discount: found.discount,
            feedbacks: found.feedbacks,
            rating: found.rating,
            isPromo: found.isPromo,
          });
          competitorsSaved++;
        }
      }
    }

    // Update lastCheckedAt
    await db
      .update(seoKeywords)
      .set({ lastCheckedAt: now, updatedAt: now })
      .where(eq(seoKeywords.keywordId, keywordId));

    return {
      keyword: keyword[0].keyword,
      checkedAt: now.toISOString(),
      totalProducts,
      ourPositions,
      competitorsSaved,
      allProducts: allProducts.slice(0, 30), // Return first page for display
      rateLimit: getRateLimitStatus(),
    };
  });

  // ─────────────────────────────────────────────
  // GET /seo/:workspaceId/keywords/:keywordId/competitors-snapshot
  // Get latest competitor prices/positions for a keyword
  // ─────────────────────────────────────────────
  fastify.get<{
    Params: { workspaceId: string; keywordId: string };
  }>('/:workspaceId/keywords/:keywordId/competitors-snapshot', { preHandler: requireRole('viewer') }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const keywordId = Number(request.params.keywordId);

    // Get latest position for each competitor
    const latestPositions = await db.execute(sql`
      SELECT DISTINCT ON (cp.competitor_id)
        cp.*,
        c.name as competitor_name,
        c.nm_id as competitor_nm_id
      FROM seo_competitor_positions cp
      JOIN seo_competitors c ON cp.competitor_id = c.competitor_id
      WHERE cp.workspace_id = ${workspaceId}
        AND cp.keyword_id = ${keywordId}
      ORDER BY cp.competitor_id, cp.checked_at DESC
    `);

    return {
      keywordId,
      competitors: latestPositions.rows,
    };
  });

  // ═══════════════════════════════════════════════
  // ADDRESSES
  // ═══════════════════════════════════════════════

  // GET /seo/:workspaceId/addresses
  fastify.get<{
    Params: { workspaceId: string };
  }>('/:workspaceId/addresses', { preHandler: requireRole('viewer') }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    return db
      .select()
      .from(seoAddresses)
      .where(eq(seoAddresses.workspaceId, workspaceId))
      .orderBy(desc(seoAddresses.isDefault), asc(seoAddresses.name));
  });

  // POST /seo/:workspaceId/addresses
  fastify.post<{
    Params: { workspaceId: string };
    Body: { name: string; dest?: string; isDefault?: boolean };
  }>('/:workspaceId/addresses', { preHandler: requireRole('manager') }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    const { name, dest, isDefault } = request.body;

    // If setting as default, unset others
    if (isDefault) {
      await db
        .update(seoAddresses)
        .set({ isDefault: false })
        .where(eq(seoAddresses.workspaceId, workspaceId));
    }

    const [address] = await db
      .insert(seoAddresses)
      .values({ workspaceId, name, dest, isDefault: isDefault || false })
      .returning();

    return address;
  });

  // DELETE /seo/:workspaceId/addresses/:addressId
  fastify.delete<{
    Params: { workspaceId: string; addressId: string };
  }>('/:workspaceId/addresses/:addressId', { preHandler: requireRole('manager') }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const addressId = Number(request.params.addressId);

    const result = await db
      .delete(seoAddresses)
      .where(and(eq(seoAddresses.addressId, addressId), eq(seoAddresses.workspaceId, workspaceId)))
      .returning();

    if (result.length === 0) {
      return reply.status(404).send({ error: 'Address not found' });
    }
    return { deleted: true };
  });

  // ═══════════════════════════════════════════════
  // SETTINGS
  // ═══════════════════════════════════════════════

  // GET /seo/:workspaceId/settings
  fastify.get<{
    Params: { workspaceId: string };
  }>('/:workspaceId/settings', { preHandler: requireRole('viewer') }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);

    const [settings] = await db
      .select()
      .from(seoSettings)
      .where(eq(seoSettings.workspaceId, workspaceId));

    // Return defaults if not set
    return settings || {
      workspaceId,
      checkIntervalHours: 12,
      alertOnDropPositions: 5,
      alertOnExitTop: 50,
      alertOnEnterTop: 10,
      alertOnCompetitorPriceDropPct: 15,
      alertOnNewCompetitorTopN: 10,
      notifyTelegram: true,
      notifyEmail: false,
    };
  });

  // PATCH /seo/:workspaceId/settings
  fastify.patch<{
    Params: { workspaceId: string };
    Body: {
      checkIntervalHours?: number;
      alertOnDropPositions?: number;
      alertOnExitTop?: number;
      alertOnEnterTop?: number;
      alertOnCompetitorPriceDropPct?: number;
      alertOnNewCompetitorTopN?: number;
      notifyTelegram?: boolean;
      notifyEmail?: boolean;
    };
  }>('/:workspaceId/settings', { preHandler: requireRole('manager') }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    const body = request.body;

    const [settings] = await db
      .insert(seoSettings)
      .values({
        workspaceId,
        checkIntervalHours: body.checkIntervalHours ?? 12,
        alertOnDropPositions: body.alertOnDropPositions ?? 5,
        alertOnExitTop: body.alertOnExitTop ?? 50,
        alertOnEnterTop: body.alertOnEnterTop ?? 10,
        alertOnCompetitorPriceDropPct: body.alertOnCompetitorPriceDropPct ?? 15,
        alertOnNewCompetitorTopN: body.alertOnNewCompetitorTopN ?? 10,
        notifyTelegram: body.notifyTelegram ?? true,
        notifyEmail: body.notifyEmail ?? false,
      })
      .onConflictDoUpdate({
        target: seoSettings.workspaceId,
        set: {
          ...(body.checkIntervalHours !== undefined && { checkIntervalHours: body.checkIntervalHours }),
          ...(body.alertOnDropPositions !== undefined && { alertOnDropPositions: body.alertOnDropPositions }),
          ...(body.alertOnExitTop !== undefined && { alertOnExitTop: body.alertOnExitTop }),
          ...(body.alertOnEnterTop !== undefined && { alertOnEnterTop: body.alertOnEnterTop }),
          ...(body.alertOnCompetitorPriceDropPct !== undefined && { alertOnCompetitorPriceDropPct: body.alertOnCompetitorPriceDropPct }),
          ...(body.alertOnNewCompetitorTopN !== undefined && { alertOnNewCompetitorTopN: body.alertOnNewCompetitorTopN }),
          ...(body.notifyTelegram !== undefined && { notifyTelegram: body.notifyTelegram }),
          ...(body.notifyEmail !== undefined && { notifyEmail: body.notifyEmail }),
          updatedAt: new Date(),
        },
      })
      .returning();

    return settings;
  });

  // ═══════════════════════════════════════════════
  // COMPETITORS
  // ═══════════════════════════════════════════════

  // GET /seo/:workspaceId/competitors
  fastify.get<{
    Params: { workspaceId: string };
    Querystring: { keywordId?: string };
  }>('/:workspaceId/competitors', { preHandler: requireRole('viewer') }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    const keywordId = request.query.keywordId ? Number(request.query.keywordId) : undefined;

    const competitors = await db
      .select()
      .from(seoCompetitors)
      .where(eq(seoCompetitors.workspaceId, workspaceId))
      .orderBy(asc(seoCompetitors.name));

    // Get keyword links
    const competitorIds = competitors.map(c => c.competitorId);
    const keywordLinks = competitorIds.length > 0
      ? await db
          .select()
          .from(seoCompetitorKeywords)
          .where(inArray(seoCompetitorKeywords.competitorId, competitorIds))
      : [];

    const keywordsByCompetitor = new Map<number, number[]>();
    for (const link of keywordLinks) {
      const list = keywordsByCompetitor.get(link.competitorId) || [];
      list.push(link.keywordId);
      keywordsByCompetitor.set(link.competitorId, list);
    }

    let result = competitors.map(c => ({
      ...c,
      keywordIds: keywordsByCompetitor.get(c.competitorId) || [],
    }));

    // Filter by keyword if requested
    if (keywordId) {
      result = result.filter(c => c.keywordIds.includes(keywordId));
    }

    return result;
  });

  // POST /seo/:workspaceId/competitors
  fastify.post<{
    Params: { workspaceId: string };
    Body: { name: string; nmId: number; keywordIds?: number[] };
  }>('/:workspaceId/competitors', { preHandler: requireRole('manager') }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    const { name, nmId, keywordIds } = request.body;

    const [competitor] = await db
      .insert(seoCompetitors)
      .values({ workspaceId, name, nmId })
      .returning();

    // Link to keywords
    if (keywordIds && keywordIds.length > 0) {
      await db.insert(seoCompetitorKeywords).values(
        keywordIds.map(keywordId => ({
          workspaceId,
          competitorId: competitor.competitorId,
          keywordId,
        }))
      );
    }

    return { ...competitor, keywordIds: keywordIds || [] };
  });

  // DELETE /seo/:workspaceId/competitors/:competitorId
  fastify.delete<{
    Params: { workspaceId: string; competitorId: string };
  }>('/:workspaceId/competitors/:competitorId', { preHandler: requireRole('manager') }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const competitorId = Number(request.params.competitorId);

    const result = await db
      .delete(seoCompetitors)
      .where(and(eq(seoCompetitors.competitorId, competitorId), eq(seoCompetitors.workspaceId, workspaceId)))
      .returning();

    if (result.length === 0) {
      return reply.status(404).send({ error: 'Competitor not found' });
    }
    return { deleted: true };
  });

  // GET /seo/:workspaceId/competitors/:competitorId/positions
  fastify.get<{
    Params: { workspaceId: string; competitorId: string };
    Querystring: { keywordId?: string; limit?: string };
  }>('/:workspaceId/competitors/:competitorId/positions', { preHandler: requireRole('viewer') }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    const competitorId = Number(request.params.competitorId);
    const keywordId = request.query.keywordId ? Number(request.query.keywordId) : undefined;
    const limit = request.query.limit ? Number(request.query.limit) : 50;

    let query = db
      .select()
      .from(seoCompetitorPositions)
      .where(
        keywordId
          ? and(
              eq(seoCompetitorPositions.workspaceId, workspaceId),
              eq(seoCompetitorPositions.competitorId, competitorId),
              eq(seoCompetitorPositions.keywordId, keywordId)
            )
          : and(
              eq(seoCompetitorPositions.workspaceId, workspaceId),
              eq(seoCompetitorPositions.competitorId, competitorId)
            )
      )
      .orderBy(desc(seoCompetitorPositions.checkedAt))
      .limit(limit);

    return query;
  });

  // ═══════════════════════════════════════════════
  // KEYWORD TAGS
  // ═══════════════════════════════════════════════

  // GET /seo/:workspaceId/tags
  fastify.get<{
    Params: { workspaceId: string };
  }>('/:workspaceId/tags', { preHandler: requireRole('viewer') }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    return db
      .select()
      .from(seoKeywordTags)
      .where(eq(seoKeywordTags.workspaceId, workspaceId))
      .orderBy(asc(seoKeywordTags.name));
  });

  // POST /seo/:workspaceId/tags
  fastify.post<{
    Params: { workspaceId: string };
    Body: { name: string; color?: string };
  }>('/:workspaceId/tags', { preHandler: requireRole('manager') }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    const { name, color } = request.body;

    const [tag] = await db
      .insert(seoKeywordTags)
      .values({ workspaceId, name, color })
      .returning();

    return tag;
  });

  // DELETE /seo/:workspaceId/tags/:tagId
  fastify.delete<{
    Params: { workspaceId: string; tagId: string };
  }>('/:workspaceId/tags/:tagId', { preHandler: requireRole('manager') }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const tagId = Number(request.params.tagId);

    const result = await db
      .delete(seoKeywordTags)
      .where(and(eq(seoKeywordTags.tagId, tagId), eq(seoKeywordTags.workspaceId, workspaceId)))
      .returning();

    if (result.length === 0) {
      return reply.status(404).send({ error: 'Tag not found' });
    }
    return { deleted: true };
  });

  // POST /seo/:workspaceId/keywords/:keywordId/tags
  fastify.post<{
    Params: { workspaceId: string; keywordId: string };
    Body: { tagIds: number[] };
  }>('/:workspaceId/keywords/:keywordId/tags', { preHandler: requireRole('manager') }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const keywordId = Number(request.params.keywordId);
    const { tagIds } = request.body;

    if (tagIds.length === 0) {
      return { linked: 0 };
    }

    // SECURITY: Verify keyword belongs to this workspace
    const [keyword] = await db
      .select({ workspaceId: seoKeywords.workspaceId })
      .from(seoKeywords)
      .where(eq(seoKeywords.keywordId, keywordId))
      .limit(1);

    if (!keyword || keyword.workspaceId !== workspaceId) {
      return reply.status(403).send({ error: 'Keyword not found or access denied' });
    }

    // SECURITY: Verify all tags belong to this workspace
    const validTags = await db
      .select({ tagId: seoKeywordTags.tagId })
      .from(seoKeywordTags)
      .where(
        and(
          eq(seoKeywordTags.workspaceId, workspaceId),
          inArray(seoKeywordTags.tagId, tagIds)
        )
      );

    const validTagIds = validTags.map(t => t.tagId);
    if (validTagIds.length !== tagIds.length) {
      return reply.status(403).send({ 
        error: 'Some tags not found or access denied',
        validCount: validTagIds.length,
        requestedCount: tagIds.length,
      });
    }

    // Delete existing links and insert new ones
    await db.delete(seoKeywordTagLinks).where(eq(seoKeywordTagLinks.keywordId, keywordId));

    await db.insert(seoKeywordTagLinks).values(
      validTagIds.map(tagId => ({ keywordId, tagId }))
    );

    return { linked: validTagIds.length };
  });

  // GET /seo/:workspaceId/keywords/:keywordId/tags
  fastify.get<{
    Params: { workspaceId: string; keywordId: string };
  }>('/:workspaceId/keywords/:keywordId/tags', { preHandler: requireRole('viewer') }, async (request) => {
    const keywordId = Number(request.params.keywordId);

    const links = await db
      .select({ tag: seoKeywordTags })
      .from(seoKeywordTagLinks)
      .innerJoin(seoKeywordTags, eq(seoKeywordTagLinks.tagId, seoKeywordTags.tagId))
      .where(eq(seoKeywordTagLinks.keywordId, keywordId));

    return links.map(l => l.tag);
  });

  // ═══════════════════════════════════════════════
  // SEARCH QUERIES (Поисковые запросы)
  // ═══════════════════════════════════════════════

  // GET /seo/:workspaceId/search-queries
  // Get search report summary
  fastify.get<{
    Params: { workspaceId: string };
    Querystring: { from?: string; to?: string; limit?: string; offset?: string };
  }>('/:workspaceId/search-queries', { preHandler: requireRole('viewer') }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    const { from, to, limit, offset } = request.query;

    const { getWbApiKey } = await import('../integrations/wb/wbClient.js');
    const { getSearchReport } = await import('../integrations/wb/searchReport.js');

    const apiKey = await getWbApiKey(workspaceId, extractShopId(request));
    if (!apiKey) {
      return { error: 'No WB API key configured', data: [] };
    }

    const today = new Date();
    const dateTo = to || today.toISOString().slice(0, 10);
    const dateFrom = from || new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    try {
      const result = await getSearchReport(apiKey, {
        dateFrom,
        dateTo,
        limit: limit ? Number(limit) : 100,
        offset: offset ? Number(offset) : 0,
      });
      return { data: result.data, dateFrom, dateTo };
    } catch (e: any) {
      return { error: e.message, data: [] };
    }
  });

  // GET /seo/:workspaceId/search-queries/groups
  // Get grouped search report (by subject or brand)
  fastify.get<{
    Params: { workspaceId: string };
    Querystring: { 
      from?: string; 
      to?: string; 
      groupBy?: 'object' | 'brand';
      limit?: string; 
      offset?: string;
    };
  }>('/:workspaceId/search-queries/groups', { preHandler: requireRole('viewer') }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    const { from, to, groupBy, limit, offset } = request.query;

    const { getWbApiKey } = await import('../integrations/wb/wbClient.js');
    const { getSearchReportGroups } = await import('../integrations/wb/searchReport.js');

    const apiKey = await getWbApiKey(workspaceId, extractShopId(request));
    if (!apiKey) {
      return { error: 'No WB API key configured', data: [] };
    }

    const today = new Date();
    const dateTo = to || today.toISOString().slice(0, 10);
    const dateFrom = from || new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    try {
      const result = await getSearchReportGroups(apiKey, {
        dateFrom,
        dateTo,
        groupBy: groupBy || 'object',
        limit: limit ? Number(limit) : 100,
        offset: offset ? Number(offset) : 0,
      });
      return { data: result.data, total: result.total, dateFrom, dateTo };
    } catch (e: any) {
      return { error: e.message, data: [] };
    }
  });

  // GET /seo/:workspaceId/search-queries/details/:nmId
  // Get detailed search stats for a product
  fastify.get<{
    Params: { workspaceId: string; nmId: string };
    Querystring: { from?: string; to?: string };
  }>('/:workspaceId/search-queries/details/:nmId', { preHandler: requireRole('viewer') }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    const nmId = Number(request.params.nmId);
    const { from, to } = request.query;

    const { getWbApiKey } = await import('../integrations/wb/wbClient.js');
    const { getSearchReportDetails } = await import('../integrations/wb/searchReport.js');

    const apiKey = await getWbApiKey(workspaceId, extractShopId(request));
    if (!apiKey) {
      return { error: 'No WB API key configured', data: [] };
    }

    const today = new Date();
    const dateTo = to || today.toISOString().slice(0, 10);
    const dateFrom = from || new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    try {
      const result = await getSearchReportDetails(apiKey, {
        dateFrom,
        dateTo,
        nmIds: [nmId],
      });
      return { data: result.data, total: result.total, dateFrom, dateTo };
    } catch (e: any) {
      return { error: e.message, data: [] };
    }
  });

  // GET /seo/:workspaceId/search-queries/texts/:nmId
  // Get search texts for a product
  fastify.get<{
    Params: { workspaceId: string; nmId: string };
    Querystring: { from?: string; to?: string; limit?: string };
  }>('/:workspaceId/search-queries/texts/:nmId', { preHandler: requireRole('viewer') }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    const nmId = Number(request.params.nmId);
    const { from, to, limit } = request.query;

    const { getWbApiKey } = await import('../integrations/wb/wbClient.js');
    const { getProductSearchTexts } = await import('../integrations/wb/searchReport.js');

    const apiKey = await getWbApiKey(workspaceId, extractShopId(request));
    if (!apiKey) {
      return { error: 'No WB API key configured', data: [] };
    }

    const today = new Date();
    const dateTo = to || today.toISOString().slice(0, 10);
    const dateFrom = from || new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    try {
      const result = await getProductSearchTexts(apiKey, {
        dateFrom,
        dateTo,
        nmIds: [nmId],
        limit: limit ? Number(limit) : 30,
      });
      return { data: result.data, dateFrom, dateTo };
    } catch (e: any) {
      return { error: e.message, data: [] };
    }
  });
};
