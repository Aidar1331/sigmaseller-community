import { requireSellerAiKey } from '../services/sellerAiCredentials.js';
import type { FastifyPluginAsync } from 'fastify';
import { eq, and, gte, lte, desc, asc, or, sql, inArray, isNull, isNotNull, ne, gt, lt, ilike, between, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { creativeAuditRuns, creativeAuditRunsFinal, creativeCardAuditRuns, creativePhotoAuditRuns, creativeCardSnapshots, wbCards, workspaces } from '../db/schema.js';
import { claudeChatJson as llmChatJson } from '../integrations/ai/anthropic.js';
import { requireRole } from '../plugins/roleCheck.js';
import { aiSingleRateLimit } from '../lib/expensiveRouteLimits.js';
import { extractShopId } from '../plugins/shopFilter.js';
import { runFullAuditV3, extractPhotosFromStage2, extractSeoFromStage1, runQuickAudit, type QuickAuditResult, type BulkAuditResult } from '../services/creativeAuditV3.js';
import { runFullV5CouncilAudit } from '../services/auditCouncil/index.js';
import { getBalance } from '../services/aiTokens.js';

// Минимальный «прайс-сейф» для запуска полного аудита. Реальная стоимость
// (5–15k токенов через 4–5 агентов) даёт ~5–15 ₽ в Anthropic × markup ×2
// → ~10–30 ₽ с юзера. 30 ₽ = 3000 копеек — это запас для самой дорогой
// V5 Council ветки. Если на балансе меньше — отказываем сразу, чтобы не
// уйти в минус (deductUsage всё равно бросит Insufficient balance, но
// тогда мы уже потратили деньги в Anthropic).
const CREATIVE_AUDIT_MIN_BALANCE_KOPECKS = 3000;

type CreativeAuditResult = {
  score: number;
  summary: string;
  strengths: string[];
  issues: string[];
  quickFixes: string[];
  contentSuggestions: string[];
  photoSuggestions: string[];
  seoSuggestions: string[];
  checklist: string[];
};

function toArray(v: any): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x)).filter((x) => x.trim().length > 0);
}

export const creativeAuditRoutes: FastifyPluginAsync = async (app) => {
  // -----------------------------------------------------------------------
  // Limits
  // -----------------------------------------------------------------------
  app.get('/creative-audit/:workspaceId/limits', { preHandler: requireRole('viewer') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);

    const [row] = await db
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(creativeAuditRuns)
      .where(sql`workspace_id = ${params.workspaceId}`);

    const used = Number(row?.count ?? 0);
    return {
      workspaceId: params.workspaceId,
      freeTotal: 1,
      freeUsed: used > 0,
      freeLeft: Math.max(0, 1 - used),
      totalRuns: used,
    };
  });

  // -----------------------------------------------------------------------
  // List runs
  // -----------------------------------------------------------------------
  app.get('/creative-audit/:workspaceId', { preHandler: requireRole('viewer') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(50).optional(),
      // Optional per-shop scope — workspace plugin already validates that
      // shopId belongs to workspaceId.
      shopId: z.coerce.number().int().positive().optional(),
    }).parse(req.query);
    const shopId = query.shopId;

    const rows = await db
      .select({
        auditId: creativeAuditRuns.auditId,
        nmId: creativeAuditRuns.nmId,
        score: creativeAuditRuns.score,
        summary: creativeAuditRuns.summary,
        isFree: creativeAuditRuns.isFree,
        createdAt: creativeAuditRuns.createdAt,
      })
      .from(creativeAuditRuns)
      .where(and(
        eq(creativeAuditRuns.workspaceId, params.workspaceId),
        ...(shopId != null ? [eq(creativeAuditRuns.shopId, shopId)] : []),
      ))
      .orderBy(desc(creativeAuditRuns.createdAt))
      .limit(query.limit ?? 10);

    // Also fetch v3 audits (same per-shop scope)
    const v3Rows = await db
      .select({
        id: creativeAuditRunsFinal.id,
        nmId: creativeAuditRunsFinal.nmId,
        overallScore: creativeAuditRunsFinal.overallScore,
        confidence: creativeAuditRunsFinal.confidence,
        createdAt: creativeAuditRunsFinal.createdAt,
      })
      .from(creativeAuditRunsFinal)
      .where(and(
        eq(creativeAuditRunsFinal.workspaceId, params.workspaceId),
        ...(shopId != null ? [eq(creativeAuditRunsFinal.shopId, shopId)] : []),
      ))
      .orderBy(desc(creativeAuditRunsFinal.createdAt))
      .limit(50);

    // Merge and sort by date
    const merged = [
      ...rows.map(r => ({ ...r, version: 'v1' as const })),
      ...v3Rows.map(r => ({ ...r, auditId: r.id, score: r.overallScore, version: 'v3' as const, summary: null })),
    ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return { ok: true, workspaceId: params.workspaceId, rows: merged };
  });

  // -----------------------------------------------------------------------
  // Get audit details
  // -----------------------------------------------------------------------
  app.get('/creative-audit/:workspaceId/:auditId', { preHandler: requireRole('viewer') },async (req, reply) => {
    const params = z
      .object({
        workspaceId: z.coerce.number().int().positive(),
        auditId: z.coerce.number().int().positive(),
      })
      .parse(req.params);

    const [row] = await db
      .select({
        auditId: creativeAuditRuns.auditId,
        nmId: creativeAuditRuns.nmId,
        score: creativeAuditRuns.score,
        summary: creativeAuditRuns.summary,
        strengths: creativeAuditRuns.strengths,
        issues: creativeAuditRuns.issues,
        quickFixes: creativeAuditRuns.quickFixes,
        contentSuggestions: creativeAuditRuns.contentSuggestions,
        photoSuggestions: creativeAuditRuns.photoSuggestions,
        seoSuggestions: creativeAuditRuns.seoSuggestions,
        checklist: creativeAuditRuns.checklist,
        createdAt: creativeAuditRuns.createdAt,
      })
      .from(creativeAuditRuns)
      .where(and(eq(creativeAuditRuns.workspaceId, params.workspaceId), eq(creativeAuditRuns.auditId, params.auditId)))
      .limit(1);

    if (!row) {
      // Try v3 table if not found in v1
      const [v3Row] = await db
        .select()
        .from(creativeAuditRunsFinal)
        .where(and(
          eq(creativeAuditRunsFinal.id, params.auditId),
          eq(creativeAuditRunsFinal.workspaceId, params.workspaceId)
        ));
      if (v3Row) {
        // Fetch Stage 1 (card), Stage 2 (photo) and the snapshot's photoUrls.
        // Photo URLs are zipped into detailedPhotos[].imageUrl so the UI can
        // render each shot next to its score.
        const photoAuditId = v3Row.photoAuditId;
        const photoAuditWithSnapshot = photoAuditId
          ? await db
              .select({
                auditJson: creativePhotoAuditRuns.auditJson,
                photoUrls: creativeCardSnapshots.photoUrls,
              })
              .from(creativePhotoAuditRuns)
              .leftJoin(creativeCardSnapshots, eq(creativePhotoAuditRuns.snapshotId, creativeCardSnapshots.snapshotId))
              .where(eq(creativePhotoAuditRuns.id, photoAuditId))
              .limit(1)
          : [];
        const [cardAuditRows] = await Promise.all([
          v3Row.cardAuditId ? db.select({ auditJson: creativeCardAuditRuns.auditJson }).from(creativeCardAuditRuns).where(eq(creativeCardAuditRuns.id, v3Row.cardAuditId)).limit(1) : [],
        ]);
        const photoUrls = (photoAuditWithSnapshot[0]?.photoUrls as string[] | null) ?? [];

        return {
          ...(typeof v3Row.finalJson === 'object' && v3Row.finalJson !== null ? v3Row.finalJson : {}),
          photos: extractPhotosFromStage2(photoAuditWithSnapshot[0]?.auditJson, photoUrls),
          seo: extractSeoFromStage1(cardAuditRows[0]?.auditJson),
          auditId: v3Row.id,
          nmId: v3Row.nmId,
          version: 'v3',
          createdAt: v3Row.createdAt,
          overallScore: v3Row.overallScore,
          cardScore: v3Row.cardScore,
          photoScore: v3Row.photoScore,
        };
      }
      return reply.status(404).send({ error: 'not_found', message: 'Аудит не найден' });
    }

    return { ok: true, audit: row };
  });

  // -----------------------------------------------------------------------
  // Photo brief enrichment — дозапрашивает УТП + текстовое наполнение для
  // каждого кадра + видео-скрипт + prohibited list. Используется фронтом при
  // генерации «ТЗ для дизайнера» PDF. Результат кешируется в Redis 30 мин.
  // -----------------------------------------------------------------------
  app.post('/creative-audit/:workspaceId/:auditId/photo-brief-enrich', {
    preHandler: requireRole('viewer'),
  }, async (req, reply) => {
    const params = z.object({
      workspaceId: z.coerce.number().int().positive(),
      auditId: z.coerce.number().int().positive(),
    }).parse(req.params);

    try {
      const { enrichPhotoBrief } = await import('../services/photoBriefEnricher.js');
      const enrichment = await enrichPhotoBrief(params.workspaceId, params.auditId);
      return { ok: true, enrichment };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'enrichment failed';
      req.log.error({ err, auditId: params.auditId }, 'photo-brief-enrich failed');
      return reply.code(500).send({ ok: false, error: message });
    }
  });

  // -----------------------------------------------------------------------
  // Run audit (free 1)
  // -----------------------------------------------------------------------
  app.post('/creative-audit/:workspaceId/run', { preHandler: requireRole('manager') },async (req, reply) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const bodyParsed = z.object({
      nmId: z.coerce.number().int().positive(),
      // Optional scope — prevents auditing another shop's card with the same nmId.
      shopId: z.coerce.number().int().positive().optional(),
    }).parse((req as any).body ?? {});
    const body = { nmId: bodyParsed.nmId };
    const shopId = bodyParsed.shopId;


    const [limitRow] = await db
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(creativeAuditRuns)
      .where(and(
        eq(creativeAuditRuns.workspaceId, params.workspaceId),
        ...(shopId != null ? [eq(creativeAuditRuns.shopId, shopId)] : []),
      ));

    // Limits disabled for development
    // if ((limitRow?.count ?? 0) >= 1) {
    //   return reply.status(402).send({
    //     error: 'free_limit_reached',
    //     message: 'Бесплатный аудит уже использован',
    //   });
    // }

    // Card lookup scoped to shop when provided — the same nmId can exist in
    // multiple shops of the same workspace.
    const [card] = await db
      .select({
        nmId: wbCards.nmId,
        vendorCode: wbCards.vendorCode,
        title: wbCards.title,
        brandName: wbCards.brandName,
        subjectName: wbCards.subjectName,
        mainPhotoUrl: wbCards.mainPhotoUrl,
        photos: wbCards.photos,
        raw: wbCards.raw,
      })
      .from(wbCards)
      .where(and(
        eq(wbCards.workspaceId, params.workspaceId),
        eq(wbCards.nmId, body.nmId),
        ...(shopId != null ? [eq(wbCards.shopId, shopId)] : []),
      ))
      .limit(1);

    if (!card) {
      return reply.status(404).send({ error: 'card_not_found', message: 'Карточка не найдена. Проверьте nmId или синхронизацию.' });
    }

    const raw: any = card.raw ?? {};
    const snapshot = {
      nmId: card.nmId,
      vendorCode: card.vendorCode,
      title: card.title,
      brandName: card.brandName,
      subjectName: card.subjectName,
      mainPhotoUrl: card.mainPhotoUrl,
      photosCount: Array.isArray(card.photos) ? card.photos.length : 0,
      description: raw?.description ?? raw?.descriptionRu ?? raw?.descriptionEn ?? null,
      characteristics: raw?.characteristics ?? raw?.characteristicsFull ?? raw?.props ?? null,
    };

    const { data, model } = await llmChatJson<CreativeAuditResult>(
      [
        {
          role: 'system',
          content:
            'Ты эксперт по креативу и контенту карточек Wildberries. ' +
            'Пиши на русском. ВАЖНО: верни ТОЛЬКО валидный JSON объект. ' +
            'Без markdown, без ```json```, без пояснений до или после JSON. Только { ... }.',
        },
        {
          role: 'user',
          content:
            'Сделай креативный аудит карточки и дай конкретные улучшения. ' +
            'Верни JSON: ' +
            '{"score":0-100,"summary":"...","strengths":["..."],"issues":["..."],"quickFixes":["..."],"contentSuggestions":["..."],"photoSuggestions":["..."],"seoSuggestions":["..."],"checklist":["..."]}.',
        },
        {
          role: 'user',
          content: `Карточка (JSON):\n${JSON.stringify(snapshot, null, 2)}`,
        },
      ],
      {
        temperature: 0.2,
        meta: {
          workspaceId: params.workspaceId,
          feature: 'creative_audit',
          itemType: 'wb_card',
          itemId: String(body.nmId),
        },
      }
    );

    const row = await db
      .insert(creativeAuditRuns)
      .values({
        workspaceId: params.workspaceId,
        shopId: extractShopId(req) ?? null,
        nmId: body.nmId,
        status: 'completed',
        isFree: true,
        model: model ?? null,
        score: Number.isFinite(data.score) ? Math.max(0, Math.min(100, Number(data.score))) : null,
        summary: data.summary ?? null,
        strengths: toArray(data.strengths),
        issues: toArray(data.issues),
        quickFixes: toArray(data.quickFixes),
        contentSuggestions: toArray(data.contentSuggestions),
        photoSuggestions: toArray(data.photoSuggestions),
        seoSuggestions: toArray(data.seoSuggestions),
        checklist: toArray(data.checklist),
        inputSnapshot: snapshot,
        raw: data as any,
        createdAt: new Date(),
      })
      .returning({
        auditId: creativeAuditRuns.auditId,
        nmId: creativeAuditRuns.nmId,
        score: creativeAuditRuns.score,
        summary: creativeAuditRuns.summary,
        strengths: creativeAuditRuns.strengths,
        issues: creativeAuditRuns.issues,
        quickFixes: creativeAuditRuns.quickFixes,
        contentSuggestions: creativeAuditRuns.contentSuggestions,
        photoSuggestions: creativeAuditRuns.photoSuggestions,
        seoSuggestions: creativeAuditRuns.seoSuggestions,
        checklist: creativeAuditRuns.checklist,
        createdAt: creativeAuditRuns.createdAt,
      });

    return { ok: true, audit: row[0] };
  });

  // -----------------------------------------------------------------------
  // V3: 3-stage audit (text + photo + synthesis)
  // -----------------------------------------------------------------------
  app.post<{ Params: { workspaceId: string }; Body: { nmId: number; premium?: boolean } }>(
    '/creative-audit/:workspaceId/run-v3',
    { preHandler: [requireRole('manager')] },
    async (req, reply) => {
      const workspaceId = Number(req.params.workspaceId);
      const { nmId: rawNmId, premium } = req.body as { nmId?: number; premium?: boolean };
      const nmId = Number(rawNmId);
      if (!nmId || !Number.isFinite(nmId) || nmId <= 0) {
        return reply.code(400).send({ error: 'nmId обязателен и должен быть положительным числом' });
      }

      // Check limits (same as v1)
      const existingRuns = await db
        .select({ id: creativeAuditRunsFinal.id })
        .from(creativeAuditRunsFinal)
        .where(and(
          eq(creativeAuditRunsFinal.workspaceId, workspaceId),
          eq(creativeAuditRunsFinal.isFree, true)
        ));

      const freeUsed = existingRuns.length;
      // Limits disabled for development
      const FREE_LIMIT = 999999;
      // if (freeUsed >= FREE_LIMIT && !premium) {
      //   return reply.code(402).send({ error: 'Free audit limit reached', freeUsed, freeLimit: FREE_LIMIT });
      // }

      // Balance gate. Без него юзер с пустым кошельком может бесконечно
      // запускать V5 Council (5+ Claude-вызовов, vision на 7 фото) — токены
      // уходят в Anthropic, а deductUsage потом упадёт с Insufficient balance.
      const { balanceKopecks } = await getBalance(workspaceId);
      

      // Async-job pattern. Creating a DB row + detaching the heavy work with
      // setImmediate() lets the HTTP response return in < 1 s; the client
      // polls GET /creative-audit/:ws/jobs/:job_id for progress. Previously
      // the endpoint held the connection for 2-5 min while the 3 LLM stages
      // ran, which collided with every transport timeout on the path
      // (Next.js proxy, undici, browser fetch, user's NAT).
      const { creativeAuditJobs } = await import('../db/schema.js');
      const shopId = extractShopId(req);
      const [job] = await db
        .insert(creativeAuditJobs)
        .values({
          workspaceId,
          shopId: shopId ?? null,
          nmId,
          status: 'running',
          stage: 'queued',
        })
        .returning({ jobId: creativeAuditJobs.jobId });

      // Fire-and-forget: the handler can finish; this promise keeps running
      // in the Node event loop until resolved. Any error inside is caught
      // here so an unhandled rejection never crashes the process.
      setImmediate(async () => {
        const updateJob = async (patch: Record<string, any>) =>
          db.update(creativeAuditJobs).set({ ...patch, updatedAt: new Date() }).where(eq(creativeAuditJobs.jobId, job.jobId));
        try {
          await updateJob({ stage: 'running' });
          // Pipeline resolver. Precedence: workspaces.audit_version (set per
          // workspace via SQL UPDATE) → env AUDIT_VERSION → 'v3'. This lets
          // operator shadow-test v5 on his own workspace while everyone else
          // stays on v3 — without flipping a global env flag.
          const [ws] = await db
            .select({ auditVersion: workspaces.auditVersion })
            .from(workspaces)
            .where(eq(workspaces.workspaceId, workspaceId))
            .limit(1);
          const resolvedVersion = (ws?.auditVersion ?? process.env.AUDIT_VERSION ?? 'v3').toLowerCase();
          const useCouncil = resolvedVersion === 'v5_council';
          req.log.info({ workspaceId, nmId, resolvedVersion, source: ws?.auditVersion ? 'workspace' : (process.env.AUDIT_VERSION ? 'env' : 'default') }, 'creative-audit: pipeline resolved');
          const result = useCouncil
            ? await runFullV5CouncilAudit(workspaceId, nmId, { isFree: freeUsed < FREE_LIMIT, shopId: shopId ?? null })
            : await runFullAuditV3(workspaceId, nmId, { isFree: freeUsed < FREE_LIMIT, shopId: shopId ?? null });
          await updateJob({
            status: 'done',
            stage: 'done',
            finalAuditId: (result.meta as any)?.finalAuditId ?? null,
            snapshotId: (result.meta as any)?.snapshotId ?? null,
            resultJson: result as any,
            completedAt: new Date(),
          });
        } catch (err: any) {
          req.log.error({ err, nmId, jobId: job.jobId }, 'V3 audit background job failed');
          await updateJob({
            status: 'failed',
            stage: 'failed',
            errorMessage: String(err?.message ?? err).slice(0, 2000),
            completedAt: new Date(),
          }).catch(() => {});
        }
      });

      return { jobId: job.jobId, status: 'running' as const };
    }
  );

  // -----------------------------------------------------------------------
  // V3: Check status of an async audit job
  // GET /creative-audit/:workspaceId/jobs/:jobId
  //
  // Returns the current row from creative_audit_jobs. When `status === 'done'`
  // the `result` field holds the full audit payload the UI would have
  // received from a synchronous call. While running, `stage` carries a hint
  // ("running" / "queued") so the UI can show progress.
  // -----------------------------------------------------------------------
  app.get<{ Params: { workspaceId: string; jobId: string } }>(
    '/creative-audit/:workspaceId/jobs/:jobId',
    { preHandler: [requireRole('viewer')] },
    async (req, reply) => {
      const workspaceId = Number(req.params.workspaceId);
      const jobId = Number(req.params.jobId);
      if (!Number.isFinite(jobId) || jobId <= 0) {
        return reply.code(400).send({ error: 'Invalid jobId' });
      }
      const { creativeAuditJobs } = await import('../db/schema.js');
      const [row] = await db
        .select()
        .from(creativeAuditJobs)
        .where(and(eq(creativeAuditJobs.jobId, jobId), eq(creativeAuditJobs.workspaceId, workspaceId)))
        .limit(1);
      if (!row) return reply.code(404).send({ error: 'Job not found' });
      return {
        jobId: row.jobId,
        status: row.status,
        stage: row.stage,
        nmId: row.nmId,
        error: row.errorMessage,
        startedAt: row.startedAt,
        completedAt: row.completedAt,
        result: row.status === 'done' ? row.resultJson : null,
      };
    }
  );

  // -----------------------------------------------------------------------
  // Bulk Audit (Quick Audit for multiple cards)
  // -----------------------------------------------------------------------
  app.post<{ Params: { workspaceId: string }; Body: { nmIds: number[]; concurrency?: number } }>(
    '/creative-audit/:workspaceId/bulk-audit',
    { preHandler: [requireRole('manager')] },
    async (req, reply) => {
      const workspaceId = Number(req.params.workspaceId);
      const { nmIds } = req.body;
      // Жёстко зажимаем concurrency сервером: даже если клиент попросит 50,
      // получит максимум 5 — иначе при 50 одновременных AI-вызовах ловим
      // rate-limit провайдера и счёт за токены растёт нелинейно.
      const concurrency = Math.max(1, Math.min(5, Number(req.body.concurrency ?? 3)));

      if (!Array.isArray(nmIds) || nmIds.length === 0) {
        return reply.code(400).send({ error: 'nmIds array is required' });
      }

      if (nmIds.length > 50) {
        return reply.code(400).send({ error: 'Maximum 50 cards per bulk audit' });
      }

      const results: QuickAuditResult[] = [];
      const failedNmIds: number[] = [];
      let totalTokens = 0;
      let totalCost = 0;

      // Process in batches with concurrency limit
      const chunks: number[][] = [];
      for (let i = 0; i < nmIds.length; i += concurrency) {
        chunks.push(nmIds.slice(i, i + concurrency));
      }

      for (const chunk of chunks) {
        const promises = chunk.map(async (nmId) => {
          try {
            const result = await runQuickAudit(workspaceId, nmId);
            return { success: true as const, result };
          } catch (err: any) {
            req.log.warn({ err, nmId }, 'Quick audit failed for card');
            return { success: false as const, nmId };
          }
        });

        const settled = await Promise.all(promises);

        for (const item of settled) {
          if (item.success) {
            results.push(item.result);
            totalTokens += item.result.tokenUsage;
            totalCost += parseFloat(item.result.costUsd);
          } else {
            failedNmIds.push(item.nmId);
          }
        }
      }

      // Sort by improvement potential (high first) then by score (low first)
      const potentialOrder = { high: 0, medium: 1, low: 2 };
      results.sort((a, b) => {
        const potentialDiff = potentialOrder[a.estimatedImprovementPotential] - potentialOrder[b.estimatedImprovementPotential];
        if (potentialDiff !== 0) return potentialDiff;
        return a.score - b.score; // Lower score = needs more work = higher priority
      });

      const response: BulkAuditResult = {
        results,
        totalTokens,
        totalCostUsd: totalCost.toFixed(6),
        processedCount: results.length,
        failedCount: failedNmIds.length,
        failedNmIds,
      };

      return { ok: true, ...response };
    }
  );

  // -----------------------------------------------------------------------
  // Quick Audit (single card, lightweight)
  // -----------------------------------------------------------------------
  app.post<{ Params: { workspaceId: string }; Body: { nmId: number } }>(
    '/creative-audit/:workspaceId/quick-audit',
    { preHandler: [requireRole('manager')] },
    async (req, reply) => {
      const workspaceId = Number(req.params.workspaceId);
      const { nmId } = req.body;

      try {
        const result = await runQuickAudit(workspaceId, nmId);
        return { ok: true, ...result };
      } catch (err: any) {
        req.log.error({ err, nmId }, 'Quick audit failed');
        return reply.code(500).send({ error: err.message || 'Quick audit failed' });
      }
    }
  );

  // -----------------------------------------------------------------------
  // Test Claude connectivity
  // -----------------------------------------------------------------------
  app.get('/creative-audit/:workspaceId/test-claude', async (req, reply) => {
    const https = await import('https');
    const fs = await import('fs');
    const key = await requireSellerAiKey('anthropic');
    if (!key) return reply.code(500).send({ error: 'No API key' });

    // Test with a ~18KB body to match actual audit size
    const bigSystem = 'You are a WB card auditor. Analyze the following product card thoroughly. ' + 'X'.repeat(14000);
    const body = JSON.stringify({
      model: 'claude-sonnet-4-6', max_tokens: 100,
      system: bigSystem,
      messages: [{ role: 'user', content: 'Title: Органайзер для хранения коробки в кухню, ванную, гардероб. Brand: ELEGAN ZEN. Description: Создавайте уют и порядок в своем доме! ' + 'Описание '.repeat(200) + ' Return JSON: {score: number}' }]
    });
    const bodyBuf = Buffer.from(body);
    console.log('[test-claude] Body size:', bodyBuf.length);

    return new Promise((resolve) => {
      const r = https.request({
        hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'content-length': String(bodyBuf.length) },
        timeout: 30000,
      }, (res) => {
        let data = '';
        res.on('data', (c: Buffer) => { data += c.toString(); });
        res.on('end', () => {
          resolve(reply.send({ status: res.statusCode, body: JSON.parse(data) }));
        });
      });
      r.on('error', (e: Error) => resolve(reply.code(500).send({ error: e.message })));
      r.write(bodyBuf);
      r.end();
    });
  });

  // -----------------------------------------------------------------------
  // AI Fix — preview improved content for a checklist item
  // -----------------------------------------------------------------------
  const fixTypes = ['title', 'description', 'remove_irrelevant_chars', 'seo_keywords', 'fix_quotes'] as const;
  type FixType = (typeof fixTypes)[number];

  app.post('/creative-audit/:workspaceId/fix', { preHandler: requireRole('manager') }, async (req, reply) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z.object({
      nmId: z.coerce.number().int().positive(),
      fixType: z.enum(fixTypes),
      auditContext: z.string().optional().default(''),
    }).parse((req as any).body ?? {});

    // Load the card
    const [card] = await db
      .select({
        nmId: wbCards.nmId,
        title: wbCards.title,
        raw: wbCards.raw,
      })
      .from(wbCards)
      .where(and(eq(wbCards.workspaceId, params.workspaceId), eq(wbCards.nmId, body.nmId)))
      .limit(1);

    if (!card) {
      return reply.status(404).send({ error: 'card_not_found', message: 'Карточка не найдена' });
    }

    const raw: any = card.raw ?? {};
    const title = card.title ?? '';
    const description = raw?.description ?? raw?.descriptionRu ?? raw?.descriptionEn ?? '';
    const characteristics = JSON.stringify(raw?.characteristics ?? raw?.characteristicsFull ?? raw?.props ?? []);

    // fix_quotes doesn't need AI
    if (body.fixType === 'fix_quotes') {
      const original = title;
      const improved = original.replace(/^["«»"']+/, '').replace(/["«»"']+$/, '');
      return { ok: true, original, improved, fixType: body.fixType };
    }

    // Build prompt based on fixType
    const prompts: Record<Exclude<FixType, 'fix_quotes'>, { current: string; prompt: string }> = {
      title: {
        current: title,
        prompt: `Улучши название товара WB. Добавь размер, материал, количество секций. Текущее: ${title}. Контекст аудита: ${body.auditContext}. Верни JSON: {"improved": "улучшенное название"}`,
      },
      description: {
        current: description,
        prompt: `Перепиши описание товара WB. Убери воду, добавь конкретные цифры и характеристики. Текущее: ${description}. Контекст аудита: ${body.auditContext}. Верни JSON: {"improved": "улучшенное описание"}`,
      },
      remove_irrelevant_chars: {
        current: characteristics,
        prompt: `Проанализируй характеристики товара WB и укажи какие нерелевантны. Текущие: ${characteristics}. Контекст: ${body.auditContext}. Верни JSON: {"improved": "список характеристик для удаления через запятую"}`,
      },
      seo_keywords: {
        current: description,
        prompt: `Добавь ключевые слова в описание товара WB органично. Текущее описание: ${description}. Контекст аудита: ${body.auditContext}. Верни JSON: {"improved": "улучшенное описание с ключевыми словами"}`,
      },
    };

    const chosen = prompts[body.fixType as Exclude<FixType, 'fix_quotes'>];

    const { data } = await llmChatJson<{ improved: string }>(
      [
        {
          role: 'system',
          content: 'Ты эксперт по контенту карточек Wildberries. Пиши на русском. ВАЖНО: верни ТОЛЬКО валидный JSON объект. Без markdown, без ```json```, без пояснений. Только { ... }.',
        },
        {
          role: 'user',
          content: chosen.prompt,
        },
      ],
      {
        temperature: 0.3,
        meta: {
          workspaceId: params.workspaceId,
          feature: 'creative_audit_fix',
          itemType: 'wb_card',
          itemId: String(body.nmId),
        },
      }
    );

    return { ok: true, original: chosen.current, improved: data.improved ?? '', fixType: body.fixType };
  });

  // -----------------------------------------------------------------------
  // Apply fix — пушит улучшенный title/description на WB через action queue.
  // Раньше тут был placeholder (return ok без реального вызова) → UI говорил
  // «Изменение применено», но на WB ничего не уходило. Теперь — реальный
  // enqueue. Для fixType='characteristics' и подобных где улучшение — не
  // строка title/description, продолжаем возвращать ok без действия (нужна
  // отдельная UI-конструкция).
  // -----------------------------------------------------------------------
  app.post('/creative-audit/:workspaceId/apply-fix', { preHandler: requireRole('manager') }, async (req, reply) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z.object({
      nmId: z.coerce.number().int().positive(),
      fixType: z.enum(fixTypes),
      improved: z.string(),
      shopId: z.coerce.number().int().positive().optional(),
    }).parse((req as any).body ?? {});

    const userId = (req as any).user?.userId ?? null;

    // update_card executor принимает title/description. Маппим:
    //   title / fix_quotes → title
    //   description / remove_irrelevant_chars / seo_keywords → description
    const isTitle = body.fixType === 'title' || (body.fixType === 'fix_quotes');
    const isDescription = body.fixType === 'description'
      || body.fixType === 'remove_irrelevant_chars'
      || body.fixType === 'seo_keywords';

    if (!isTitle && !isDescription) {
      return reply.code(400).send({ ok: false, error: 'Неизвестный тип исправления' });
    }

    const { enqueueAction } = await import('../agents/tools/actionQueue.js');
    const toolArgs: Record<string, unknown> = { nmId: body.nmId };
    if (isTitle) toolArgs.title = body.improved;
    if (isDescription) toolArgs.description = body.improved;

    const enq = await enqueueAction({
      workspaceId: params.workspaceId,
      shopId: body.shopId ?? null,
      userId,
      conversationId: null,
      actionType: 'update_card',
      toolArgs,
      rationale: `creative-audit apply-fix: ${body.fixType}`,
    });

    return { ok: true, applied: true, nmId: body.nmId, fixType: body.fixType, actionId: enq.actionId, status: enq.status };
  });

  // -----------------------------------------------------------------------
  // Apply audit recommendations to WB card
  // -----------------------------------------------------------------------
  app.post('/creative-audit/:workspaceId/:auditId/apply', { preHandler: requireRole('manager') }, async (req, reply) => {
    const { applyAuditRecommendations } = await import('../services/creativeAuditApply.js');
    
    const params = z.object({
      workspaceId: z.coerce.number().int().positive(),
      auditId: z.coerce.number().int().positive(),
    }).parse(req.params);

    const body = z.object({
      applyTitle: z.boolean().optional().default(false),
      applyDescription: z.boolean().optional().default(false),
      applyCharacteristics: z.array(z.object({
        id: z.number(),
        name: z.string(),
        value: z.union([z.string(), z.array(z.string())]),
      })).optional().default([]),
      // Опциональные правки текста из диалога перед отправкой на WB.
      overrideTitle: z.string().max(100).optional(),
      overrideDescription: z.string().max(5000).optional(),
      shopId: z.number().int().positive().optional(),
    }).parse((req as any).body ?? {});

    try {
      const result = await applyAuditRecommendations({
        workspaceId: params.workspaceId,
        auditId: params.auditId,
        applyTitle: body.applyTitle,
        applyDescription: body.applyDescription,
        applyCharacteristics: body.applyCharacteristics,
        overrideTitle: body.overrideTitle,
        overrideDescription: body.overrideDescription,
        shopId: body.shopId,
      });

      return { ok: true, ...result };
    } catch (err: any) {
      const msg = err.message || 'Apply failed';
      // «Audit not found» — это 404 (UI должен подсветить stale state),
      // а не 400 (которые UI трактует как «плохой ввод»).
      const isNotFound = /^Audit not found/.test(msg);
      const status = isNotFound ? 404 : 400;
      req.log.error({ err, auditId: params.auditId }, 'Failed to apply audit');
      return reply.status(status).send({ error: msg });
    }
  });

  // -----------------------------------------------------------------------
  // Revert experiment (restore original card content)
  // -----------------------------------------------------------------------
  app.post('/creative-audit/:workspaceId/experiments/:experimentId/revert', { preHandler: requireRole('manager') }, async (req, reply) => {
    const { revertExperiment } = await import('../services/creativeAuditApply.js');

    const params = z.object({
      workspaceId: z.coerce.number().int().positive(),
      experimentId: z.coerce.number().int().positive(),
    }).parse(req.params);

    try {
      const result = await revertExperiment(params.workspaceId, params.experimentId);
      return { ok: true, ...result };
    } catch (err: any) {
      req.log.error({ err, experimentId: params.experimentId }, 'Failed to revert experiment');
      return reply.status(400).send({ error: err.message || 'Revert failed' });
    }
  });

  // -----------------------------------------------------------------------
  // Create tasks from audit roleTasks
  // -----------------------------------------------------------------------
  app.post('/creative-audit/:workspaceId/:auditId/create-tasks', { preHandler: requireRole('manager') }, async (req, reply) => {
    const { createTasksFromAudit } = await import('../services/creativeAuditApply.js');

    const params = z.object({
      workspaceId: z.coerce.number().int().positive(),
      auditId: z.coerce.number().int().positive(),
    }).parse(req.params);

    const body = z.object({
      tasks: z.array(z.object({
        role: z.string(),
        taskIndex: z.number().int().min(0),
        assigneeId: z.number().int().optional(),
        dueInDays: z.number().int().min(1).max(365).optional(),
      })).min(1),
    }).parse((req as any).body ?? {});

    try {
      const createdTasks = await createTasksFromAudit(
        params.workspaceId,
        params.auditId,
        body.tasks
      );

      return { ok: true, createdTasks };
    } catch (err: any) {
      req.log.error({ err, auditId: params.auditId }, 'Failed to create tasks from audit');
      return reply.status(400).send({ error: err.message || 'Task creation failed' });
    }
  });

  // -----------------------------------------------------------------------
  // List experiments
  // -----------------------------------------------------------------------
  app.get('/creative-audit/:workspaceId/experiments', { preHandler: requireRole('viewer') }, async (req) => {
    const { listExperiments } = await import('../services/creativeAuditApply.js');

    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z.object({
      status: z.enum(['running', 'completed', 'reverted']).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }).parse(req.query);

    try {
      const rows = await listExperiments(params.workspaceId, query.status, query.limit ?? 50);
      return { ok: true, experiments: rows };
    } catch (e: any) {
      // Table may not exist yet — return empty gracefully
      if (e?.message?.includes('does not exist') || e?.message?.includes('relation')) {
        return { ok: true, experiments: [] };
      }
      throw e;
    }
  });

  // -----------------------------------------------------------------------
  // Generate image from audit brief
  // -----------------------------------------------------------------------
  app.post('/creative-audit/:workspaceId/generate-image', {
    preHandler: requireRole('manager'),
    config: aiSingleRateLimit,
  }, async (req, reply) => {
    const { generateImageFromBrief } = await import('../services/creativeImageGen.js');

    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z.object({
      auditId: z.coerce.number().int().optional(),
      nmId: z.coerce.number().int().positive(),
      briefIndex: z.number().int().min(0).optional(),
      customPrompt: z.string().max(2000).optional(),
      generationType: z.enum(['infographic', 'lifestyle', 'product_shot', 'animation']),
      numberOfImages: z.number().int().min(1).max(4).optional(),
    }).parse((req as any).body ?? {});

    if (!body.auditId && !body.customPrompt) {
      return reply.status(400).send({ error: 'Either auditId or customPrompt is required' });
    }

    try {
      const result = await generateImageFromBrief({
        workspaceId: params.workspaceId,
        auditId: body.auditId,
        nmId: body.nmId,
        briefIndex: body.briefIndex,
        customPrompt: body.customPrompt,
        generationType: body.generationType,
        numberOfImages: body.numberOfImages,
      });

      return { ok: true, ...result };
    } catch (err: any) {
      req.log.error({ err }, 'Image generation failed');
      return reply.status(500).send({ error: err.message || 'Generation failed' });
    }
  });

  // -----------------------------------------------------------------------
  // List image generations
  // -----------------------------------------------------------------------
  app.get('/creative-audit/:workspaceId/generations', { preHandler: requireRole('viewer') }, async (req) => {
    const { listGenerations } = await import('../services/creativeImageGen.js');

    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z.object({
      status: z.enum(['pending', 'generating', 'completed', 'uploaded', 'failed']).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }).parse(req.query);

    const rows = await listGenerations(params.workspaceId, query.status, query.limit ?? 50);

    return { ok: true, generations: rows };
  });

  // -----------------------------------------------------------------------
  // Get single generation (with full images)
  // -----------------------------------------------------------------------
  app.get('/creative-audit/:workspaceId/generations/:generationId', { preHandler: requireRole('viewer') }, async (req, reply) => {
    const { getGeneration } = await import('../services/creativeImageGen.js');

    const params = z.object({
      workspaceId: z.coerce.number().int().positive(),
      generationId: z.coerce.number().int().positive(),
    }).parse(req.params);

    const gen = await getGeneration(params.workspaceId, params.generationId);

    if (!gen) {
      return reply.status(404).send({ error: 'Generation not found' });
    }

    return { ok: true, generation: gen };
  });

  // -----------------------------------------------------------------------
  // Select image from generation
  // -----------------------------------------------------------------------
  app.post('/creative-audit/:workspaceId/generations/:generationId/select', { preHandler: requireRole('manager') }, async (req, reply) => {
    const { selectImage } = await import('../services/creativeImageGen.js');

    const params = z.object({
      workspaceId: z.coerce.number().int().positive(),
      generationId: z.coerce.number().int().positive(),
    }).parse(req.params);

    const body = z.object({
      imageIndex: z.number().int().min(0),
    }).parse((req as any).body ?? {});

    try {
      const result = await selectImage({
        workspaceId: params.workspaceId,
        generationId: params.generationId,
        imageIndex: body.imageIndex,
      });

      return { ...result, ok: true };
    } catch (err: any) {
      req.log.error({ err }, 'Image selection failed');
      return reply.status(400).send({ error: err.message || 'Selection failed' });
    }
  });

  // -----------------------------------------------------------------------
  // Upload selected image to WB
  // -----------------------------------------------------------------------
  app.post('/creative-audit/:workspaceId/generations/:generationId/upload', { preHandler: requireRole('manager') }, async (req, reply) => {
    const { uploadToWb } = await import('../services/creativeImageGen.js');

    const params = z.object({
      workspaceId: z.coerce.number().int().positive(),
      generationId: z.coerce.number().int().positive(),
    }).parse(req.params);

    const body = z.object({
      photoNumber: z.number().int().min(1).max(30),
    }).parse((req as any).body ?? {});

    try {
      const { extractShopId: extractSid } = await import('../plugins/shopFilter.js');
      const result = await uploadToWb({
        workspaceId: params.workspaceId,
        shopId: extractSid(req),
        generationId: params.generationId,
        photoNumber: body.photoNumber,
      });

      return { ...result, ok: true };
    } catch (err: any) {
      req.log.error({ err }, 'Upload to WB failed');
      return reply.status(400).send({ error: err.message || 'Upload failed' });
    }
  });

  // -----------------------------------------------------------------------
  // Create A/B test from generated image
  // -----------------------------------------------------------------------
  app.post('/creative-audit/:workspaceId/generations/:generationId/to-ab-test', { preHandler: requireRole('manager') }, async (req, reply) => {
    const { createABTestFromGeneration } = await import('../services/creativeImageGen.js');

    const params = z.object({
      workspaceId: z.coerce.number().int().positive(),
      generationId: z.coerce.number().int().positive(),
    }).parse(req.params);

    const body = z.object({
      periodDays: z.number().int().min(3).max(30).optional(),
    }).parse((req as any).body ?? {});

    try {
      const result = await createABTestFromGeneration({
        workspaceId: params.workspaceId,
        generationId: params.generationId,
        periodDays: body.periodDays,
      });

      return { ok: true, ...result };
    } catch (err: any) {
      req.log.error({ err }, 'A/B test creation failed');
      return reply.status(400).send({ error: err.message || 'A/B test creation failed' });
    }
  });

  // -----------------------------------------------------------------------
  // Delete all audits for workspace (MUST be before /:auditId to avoid conflict)
  // -----------------------------------------------------------------------
  app.delete('/creative-audit/:workspaceId/all', { preHandler: requireRole('manager') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);

    await Promise.all([
      db.delete(creativeAuditRuns).where(eq(creativeAuditRuns.workspaceId, params.workspaceId)),
      db.delete(creativeAuditRunsFinal).where(eq(creativeAuditRunsFinal.workspaceId, params.workspaceId)),
    ]);

    return { ok: true, message: 'Все аудиты удалены' };
  });

  // -----------------------------------------------------------------------
  // Delete single audit
  // -----------------------------------------------------------------------
  app.delete('/creative-audit/:workspaceId/:auditId', { preHandler: requireRole('manager') }, async (req) => {
    const params = z.object({
      workspaceId: z.coerce.number().int().positive(),
      auditId: z.coerce.number().int().positive(),
    }).parse(req.params);
    const query = z.object({ version: z.enum(['v1', 'v3']).optional() }).parse(req.query);

    if (query.version === 'v3') {
      await db.delete(creativeAuditRunsFinal).where(and(eq(creativeAuditRunsFinal.id, params.auditId), eq(creativeAuditRunsFinal.workspaceId, params.workspaceId)));
    } else {
      await db.delete(creativeAuditRuns).where(and(eq(creativeAuditRuns.auditId, params.auditId), eq(creativeAuditRuns.workspaceId, params.workspaceId)));
    }

    return { ok: true };
  });

  // -----------------------------------------------------------------------
  // AI-аудит товара по МЕТРИКАМ и СОБЫТИЯМ (2026-05-31, запрос оператора).
  // Отдельно от content-аудита: здесь не разбираем фото/title/desc, а
  // анализируем динамику заказов, конверсию, ДРР, остатки, цены, события.
  //
  // 2026-05-31: ВРЕМЕННО за owner-gate (userId == 1). оператор попросил не
  // деплоить наружу пока обкатываем. Не-владельцы получают 404, как будто
  // endpoint'а не существует. Уберём gate когда оператор скажет «открыть».
  // -----------------------------------------------------------------------
  app.post('/creative-audit/:workspaceId/metrics-audit', { preHandler: requireRole('viewer') }, async (req, reply) => {
    if (req.user?.userId !== 1) {
      return reply.code(404).send({ error: 'not found' });
    }
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z.object({
      nmId: z.coerce.number().int().positive(),
      periodDays: z.coerce.number().int().min(7).max(90).optional(),
    }).parse((req as any).body ?? {});
    const { runProductMetricsAudit } = await import('../services/productMetricsAudit.js');
    return runProductMetricsAudit(params.workspaceId, body.nmId, body.periodDays ?? 30);
  });
};
