/**
 * AI Agents API — управление специализированными агентами (Supply, SEO).
 *
 * Endpoints:
 *   POST  /agents/:ws/supply/run                      — запустить анализ
 *   GET   /agents/:ws/supply/recommendations          — список рекомендаций
 *   POST  /agents/:ws/seo/run                         — запустить анализ позиций
 *   GET   /agents/:ws/activity                        — история запусков
 *   POST  /agents/:ws/supply-slip/:supplyRowId/generate
 *                                                     — сгенерировать PDF листа приёмки
 *   GET   /agents/:ws/supply-slip/:supplyRowId/file   — скачать последний PDF
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentRunResults, agentSupplyRecommendations, supplies, supplyDocuments, wbSupplies } from '../db/schema.js';
import { requireRole } from '../plugins/roleCheck.js';
import { runSupplyAgentPersisted } from '../agents/specialized/runners/supplyRunner.js';
import { runSeoAgentPersisted } from '../agents/specialized/runners/seoRunner.js';
import { runSeoKeywordSuggest } from '../agents/specialized/seoAgentKeywordSuggest.js';
import { actionAddSeoKeywords } from '../agents/tools/actionAddSeoKeywords.js';
import { generateSupplySlipPdf } from '../services/supplySlipPdf.js';

export const agentsRoutes: FastifyPluginAsync = async (app) => {
  // ─────────────────────────────────────────────
  // POST /agents/:ws/supply/run
  // ─────────────────────────────────────────────
  app.post('/agents/:ws/supply/run', { preHandler: requireRole('manager') }, async (req, reply) => {
    const { ws } = z.object({ ws: z.coerce.number().int().positive() }).parse(req.params);
    const { shopId, targetDays } = z
      .object({
        shopId: z.coerce.number().int().positive().optional(),
        targetDays: z.coerce.number().int().min(7).max(180).optional(),
      })
      .parse(req.query);

    const result = await runSupplyAgentPersisted({
      workspaceId: ws,
      shopId: shopId ?? null,
      trigger: 'api',
      targetDays,
    });
    return reply.send({ ok: true, ...result });
  });

  // ─────────────────────────────────────────────
  // GET /agents/:ws/supply/recommendations
  // ─────────────────────────────────────────────
  app.get('/agents/:ws/supply/recommendations', { preHandler: requireRole('viewer') }, async (req) => {
    const { ws } = z.object({ ws: z.coerce.number().int().positive() }).parse(req.params);
    const { shopId, limit, urgency } = z
      .object({
        shopId: z.coerce.number().int().positive().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        urgency: z.enum(['critical', 'high', 'medium', 'low']).optional(),
      })
      .parse(req.query);

    // Берём последнюю завершённую run-запись и её рекомендации
    const [lastRun] = await db
      .select({ runId: agentRunResults.runId, finishedAt: agentRunResults.finishedAt })
      .from(agentRunResults)
      .where(and(
        eq(agentRunResults.workspaceId, ws),
        eq(agentRunResults.agentName, 'supply'),
        eq(agentRunResults.status, 'done'),
        ...(shopId != null ? [eq(agentRunResults.shopId, shopId)] : []),
      ))
      .orderBy(desc(agentRunResults.startedAt))
      .limit(1);

    if (!lastRun) {
      return { runId: null, finishedAt: null, recommendations: [] };
    }

    const conds = [eq(agentSupplyRecommendations.runId, lastRun.runId)];
    if (urgency) conds.push(eq(agentSupplyRecommendations.urgency, urgency));

    const rows = await db
      .select()
      .from(agentSupplyRecommendations)
      .where(and(...conds))
      .orderBy(desc(agentSupplyRecommendations.urgency), desc(agentSupplyRecommendations.recommendedQty))
      .limit(limit);

    return {
      runId: lastRun.runId,
      finishedAt: lastRun.finishedAt,
      recommendations: rows,
    };
  });

  // ─────────────────────────────────────────────
  // POST /agents/:ws/seo/run
  // ─────────────────────────────────────────────
  app.post('/agents/:ws/seo/run', { preHandler: requireRole('manager') }, async (req, reply) => {
    const { ws } = z.object({ ws: z.coerce.number().int().positive() }).parse(req.params);
    const { shopId } = z
      .object({ shopId: z.coerce.number().int().positive().optional() })
      .parse(req.query);

    const result = await runSeoAgentPersisted({
      workspaceId: ws,
      shopId: shopId ?? null,
      trigger: 'api',
    });
    return reply.send({ ok: true, ...result });
  });

  // ─────────────────────────────────────────────
  // GET /agents/:ws/seo/keyword-suggestions
  //   Анализирует wb_search_queries за 14 дней, предлагает слова
  //   для отслеживания (не трогает БД, только чтение).
  // ─────────────────────────────────────────────
  app.get('/agents/:ws/seo/keyword-suggestions', { preHandler: requireRole('viewer') }, async (req) => {
    const { ws } = z.object({ ws: z.coerce.number().int().positive() }).parse(req.params);
    const { shopId, limit, includeTracked } = z
      .object({
        shopId: z.coerce.number().int().positive().optional(),
        limit: z.coerce.number().int().min(5).max(100).default(30),
        includeTracked: z.coerce.boolean().default(false),
      })
      .parse(req.query);

    const result = await runSeoKeywordSuggest(ws, shopId ?? null, { limit, includeTracked });
    return result;
  });

  // ─────────────────────────────────────────────
  // POST /agents/:ws/seo/keywords/add
  //   Batch-добавление выбранных пользователем слов.
  // ─────────────────────────────────────────────
  app.post('/agents/:ws/seo/keywords/add', { preHandler: requireRole('manager') }, async (req, reply) => {
    const { ws } = z.object({ ws: z.coerce.number().int().positive() }).parse(req.params);
    const body = z
      .object({
        shopId: z.number().int().positive().nullable().optional(),
        keywords: z.array(z.object({
          keyword: z.string().min(2).max(200),
          nmIds: z.array(z.number()).optional(),
        })).min(1).max(50),
      })
      .parse(req.body);

    const resultJson = await actionAddSeoKeywords({
      keywords: body.keywords,
      _workspaceId: ws,
      _shopId: body.shopId ?? null,
    });
    return reply.type('application/json').send(resultJson);
  });

  // ─────────────────────────────────────────────
  // GET /agents/:ws/activity
  // ─────────────────────────────────────────────
  app.get('/agents/:ws/activity', { preHandler: requireRole('viewer') }, async (req) => {
    const { ws } = z.object({ ws: z.coerce.number().int().positive() }).parse(req.params);
    const { limit, agent } = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        agent: z.enum(['supply', 'seo', 'pricing']).optional(),
      })
      .parse(req.query);

    const conds = [eq(agentRunResults.workspaceId, ws)];
    if (agent) conds.push(eq(agentRunResults.agentName, agent));

    const rows = await db
      .select()
      .from(agentRunResults)
      .where(and(...conds))
      .orderBy(desc(agentRunResults.startedAt))
      .limit(limit);

    return { activity: rows };
  });

  // ─────────────────────────────────────────────
  // POST /agents/:ws/supply-slip/:supplyRowId/generate
  // Генерирует PDF (EAN-128 штрих-коды) и сохраняет в supply_documents.
  // ─────────────────────────────────────────────
  app.post('/agents/:ws/supply-slip/:supplyRowId/generate', { preHandler: requireRole('manager') }, async (req, reply) => {
    const { ws, supplyRowId } = z
      .object({
        ws: z.coerce.number().int().positive(),
        supplyRowId: z.coerce.number().int().positive(),
      })
      .parse(req.params);

    const [supply] = await db
      .select({ id: wbSupplies.id, workspaceId: wbSupplies.workspaceId })
      .from(wbSupplies)
      .where(eq(wbSupplies.id, supplyRowId))
      .limit(1);
    if (!supply || supply.workspaceId !== ws) {
      return reply.status(404).send({ error: 'supply-not-found' });
    }

    const result = await generateSupplySlipPdf({ supplyRowId });

    // supply_documents.supplyId ссылается на supplies.supplyId, а не wbSupplies.id.
    // Сохраняем base64 PDF в fileData — простое хранилище без FS.
    // TODO: когда свяжем supplies ↔ wb_supplies, заменим supplyId на корректный FK.
    const saved = await db.insert(supplyDocuments).values({
      supplyId: supplyRowId as number,
      docType: 'slip',
      fileName: result.fileName,
      fileData: result.pdfBuffer.toString('base64'),
      fileSize: result.sizeBytes,
    }).returning({ docId: supplyDocuments.docId });

    return reply.send({
      ok: true,
      docId: saved[0]?.docId,
      fileName: result.fileName,
      sizeBytes: result.sizeBytes,
      mime: result.mime,
      summary: result.summary,
      fileUrl: `/agents/${ws}/supply-slip/${supplyRowId}/file`,
    });
  });

  // ─────────────────────────────────────────────
  // GET /agents/:ws/supply-slip/:supplyRowId/file
  // Отдаёт последний сгенерированный PDF как application/pdf.
  // ─────────────────────────────────────────────
  app.get('/agents/:ws/supply-slip/:supplyRowId/file', { preHandler: requireRole('viewer') }, async (req, reply) => {
    const { ws, supplyRowId } = z
      .object({
        ws: z.coerce.number().int().positive(),
        supplyRowId: z.coerce.number().int().positive(),
      })
      .parse(req.params);

    const [supply] = await db
      .select({ workspaceId: wbSupplies.workspaceId })
      .from(wbSupplies)
      .where(eq(wbSupplies.id, supplyRowId))
      .limit(1);
    if (!supply || supply.workspaceId !== ws) {
      return reply.status(404).send({ error: 'supply-not-found' });
    }

    const [doc] = await db
      .select()
      .from(supplyDocuments)
      .where(and(eq(supplyDocuments.supplyId, supplyRowId as number), eq(supplyDocuments.docType, 'slip')))
      .orderBy(desc(supplyDocuments.createdAt))
      .limit(1);

    if (!doc) {
      return reply.status(404).send({ error: 'no-document-generate-first' });
    }

    const pdf = Buffer.from(doc.fileData, 'base64');
    reply.header('Content-Type', 'application/pdf');
    reply.header('Content-Disposition', `inline; filename="${doc.fileName}"`);
    return reply.send(pdf);
  });

  // ─────────────────────────────────────────────
  // GET /agents/:ws/box-stickers/:supplyRowId/file
  // Отдаёт последний сгенерированный PDF стикеров коробов.
  // ─────────────────────────────────────────────
  app.get('/agents/:ws/box-stickers/:supplyRowId/file', { preHandler: requireRole('viewer') }, async (req, reply) => {
    const { ws, supplyRowId } = z
      .object({
        ws: z.coerce.number().int().positive(),
        supplyRowId: z.coerce.number().int().positive(),
      })
      .parse(req.params);

    const [supply] = await db
      .select({ workspaceId: supplies.workspaceId })
      .from(supplies)
      .where(eq(supplies.supplyId, supplyRowId))
      .limit(1);
    if (!supply || supply.workspaceId !== ws) {
      return reply.status(404).send({ error: 'supply-not-found' });
    }

    const [doc] = await db
      .select()
      .from(supplyDocuments)
      .where(and(eq(supplyDocuments.supplyId, supplyRowId), eq(supplyDocuments.docType, 'box_stickers')))
      .orderBy(desc(supplyDocuments.createdAt))
      .limit(1);

    if (!doc) {
      return reply.status(404).send({ error: 'no-stickers-generate-first' });
    }

    const pdf = Buffer.from(doc.fileData, 'base64');
    reply.header('Content-Type', 'application/pdf');
    reply.header('Content-Disposition', `inline; filename="${doc.fileName}"`);
    return reply.send(pdf);
  });
};
