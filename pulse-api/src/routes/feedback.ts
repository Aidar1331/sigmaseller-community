import type { FastifyPluginAsync } from 'fastify';
import { eq, and, gte, lte, desc, asc, or, sql, inArray, isNull, isNotNull, ne, gt, lt, ilike, between, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import {
  knowledgeEntries,
  marketplaceFeedbackAnalysis,
  marketplaceFeedbackItems,
  marketplaceReplyDrafts,
  marketplaceReplySettings,
  wbCards,
  wbTagProducts,
  workspacePayments,
  workspaceSubscriptions,
} from '../db/schema.js';
import { analyzeFeedback, generateReplyDraft } from '../integrations/ai/feedbacks.js';
import { processWorkspace as runAutoReplyForWorkspace } from '../jobs/feedbackAutoReply.js';
import { extractShopId } from '../plugins/shopFilter.js';
import { getWbApiKey } from '../integrations/wb/wbClient.js';
import { searchWeb } from '../integrations/webSearch.js';
import {
  fetchWbFeedbacks,
  fetchWbQuestions,
  sendWbFeedbackAnswer,
  editWbFeedbackAnswer,
  sendWbQuestionAnswer,
  rejectWbQuestion,
  markWbQuestionAsViewed,
  getPinnedFeedbacks,
  pinFeedback,
  unpinFeedback,
  getNewFeedbacksCount,
  markFeedbacksRead,
  getUnansweredFeedbacksCount,
  getUnansweredQuestionsCount,
} from '../integrations/wb/feedbacks.js';
import { answerTelegramPreCheckout, sendTelegramModeration, verifyTelegramWebhookSecret } from '../integrations/telegram.js';
import {
  addDays,
  parseTelegramPaymentPayload,
  resolvePlan,
  subscriptionCurrency,
} from '../services/subscriptions.js';
import { requireRole } from '../plugins/roleCheck.js';
import { aiBatchRateLimit } from '../lib/expensiveRouteLimits.js';
import { getBalance, estimateCostKopecks } from '../services/aiTokens.js';
import { buildShopFilter } from './pulse/helpers.js';

const marketplaceEnum = z.enum(['wb', 'ozon']);
const itemTypeEnum = z.enum(['review', 'question']);

function escapeIlike(input: string): string {
  return input.replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function toDate(value: any): Date | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function pickString(obj: any, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return null;
}

function pickNumber(obj: any, keys: string[]): number | null {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim().length > 0) {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function extractList(payload: any, path: string[]): any[] {
  let cur: any = payload;
  for (const key of path) {
    cur = cur?.[key];
  }
  return Array.isArray(cur) ? cur : [];
}

function normalizeWbFeedback(item: any, workspaceId: number, shopId: number | null = null) {
  const itemId = String(
    item?.id ?? item?.feedbackId ?? item?.reviewId ?? item?.uid ?? item?.uuid ?? item?.answerId ?? ''
  ).trim();
  if (!itemId) return null;

  // WB API returns nmId inside productDetails
  const nmId = pickNumber(item, ['nmId', 'nm_id', 'nmid', 'nmID']) 
    ?? pickNumber(item?.productDetails, ['nmId', 'nm_id', 'nmid', 'nmID']);
  const productTitle =
    pickString(item, ['productTitle', 'productName', 'subjectName', 'nmName']) ??
    pickString(item?.productDetails, ['productName', 'name', 'title']) ??
    pickString(item?.product, ['name', 'title']);
  const brandName = pickString(item, ['brandName', 'brand']) 
    ?? pickString(item?.productDetails, ['brandName', 'brand'])
    ?? pickString(item?.product, ['brand']);
  const vendorCode = pickString(item, ['vendorCode', 'vendor_code', 'supplierArticle'])
    ?? pickString(item?.productDetails, ['supplierArticle']);
  const rating = pickNumber(item, ['rating', 'rank', 'score', 'productValuation']);
  const userName = pickString(item, ['userName', 'user_name', 'authorName', 'author']);

  const text = pickString(item, ['text', 'reviewText', 'comment', 'body']) ?? '';
  const pros = pickString(item, ['pros', 'advantages']);
  const cons = pickString(item, ['cons', 'disadvantages']);

  // Photos and video
  const photoLinks = Array.isArray(item?.photoLinks) ? item.photoLinks : [];
  const photosCount = photoLinks.length;
  const hasVideo = Boolean(item?.video);

  const answerText = pickString(item, ['answerText', 'answer', 'responseText']) ?? pickString(item?.answer, ['text']);
  const answerState = pickString(item, ['answerState', 'status']) ?? pickString(item?.answer, ['state']);
  const isAnswered = Boolean(item?.isAnswered ?? item?.answered ?? answerText);

  return {
    workspaceId,
    shopId,
    marketplace: 'wb',
    itemType: 'review',
    itemId,
    nmId: nmId ?? null,
    vendorCode,
    productTitle,
    brandName,
    userName,
    rating,
    text,
    pros,
    cons,
    photosCount,
    hasVideo,
    answerText,
    answerState,
    isAnswered,
    status: isAnswered ? 'answered' : 'new',
    createdAt: toDate(item?.createdDate ?? item?.createdAt ?? item?.dateCreated ?? item?.createdTime),
    updatedAt: toDate(item?.updatedDate ?? item?.updatedAt),
    answeredAt: toDate(item?.answeredAt ?? item?.answerDate),
    syncedAt: new Date(),
    raw: item ?? {},
  };
}

function normalizeWbQuestion(item: any, workspaceId: number, shopId: number | null = null) {
  const itemId = String(
    item?.id ?? item?.questionId ?? item?.questionID ?? item?.uid ?? item?.uuid ?? item?.answerId ?? ''
  ).trim();
  if (!itemId) return null;

  // WB API returns nmId inside productDetails
  const nmId = pickNumber(item, ['nmId', 'nm_id', 'nmid', 'nmID'])
    ?? pickNumber(item?.productDetails, ['nmId', 'nm_id', 'nmid', 'nmID']);
  const productTitle =
    pickString(item, ['productTitle', 'productName', 'subjectName', 'nmName']) ??
    pickString(item?.productDetails, ['productName', 'name', 'title']) ??
    pickString(item?.product, ['name', 'title']);
  const brandName = pickString(item, ['brandName', 'brand']) 
    ?? pickString(item?.productDetails, ['brandName', 'brand'])
    ?? pickString(item?.product, ['brand']);
  const vendorCode = pickString(item, ['vendorCode', 'vendor_code', 'supplierArticle'])
    ?? pickString(item?.productDetails, ['supplierArticle']);

  const text = pickString(item, ['text', 'question', 'body', 'comment']) ?? '';
  const answerText = pickString(item, ['answerText', 'answer', 'responseText']) ?? pickString(item?.answer, ['text']);
  const answerState = pickString(item, ['answerState', 'status']) ?? pickString(item?.answer, ['state']);
  const isAnswered = Boolean(item?.isAnswered ?? item?.answered ?? answerText);

  return {
    workspaceId,
    shopId,
    marketplace: 'wb',
    itemType: 'question',
    itemId,
    nmId: nmId ?? null,
    vendorCode,
    productTitle,
    brandName,
    rating: null,
    text,
    pros: null,
    cons: null,
    answerText,
    answerState,
    isAnswered,
    status: isAnswered ? 'answered' : 'new',
    createdAt: toDate(item?.createdDate ?? item?.createdAt ?? item?.dateCreated ?? item?.createdTime),
    updatedAt: toDate(item?.updatedDate ?? item?.updatedAt),
    answeredAt: toDate(item?.answeredAt ?? item?.answerDate),
    syncedAt: new Date(),
    raw: item ?? {},
  };
}

async function ensureSettings(workspaceId: number, marketplace: string, itemType: string) {
  await db
    .insert(marketplaceReplySettings)
    .values({ workspaceId, marketplace, itemType })
    .onConflictDoNothing();

  const rows = await db
    .select()
    .from(marketplaceReplySettings)
    .where(and(eq(marketplaceReplySettings.workspaceId, workspaceId), eq(marketplaceReplySettings.marketplace, marketplace), eq(marketplaceReplySettings.itemType, itemType)))
    .limit(1);

  return rows[0];
}

async function loadKnowledgeContext(input: {
  workspaceId: number;
  nmId?: number | null;
  tagIds?: number[];
  subjectId?: number | null;
  subjectName?: string | null;
}): Promise<{ context: string; entries: Array<{ title: string; content: string; scope: string }> }> {
  const entries: Array<{ title: string; content: string; scope: string }> = [];

  if (input.nmId) {
    const rows = await db
      .select({ title: knowledgeEntries.title, content: knowledgeEntries.content })
      .from(knowledgeEntries)
      .where(and(eq(knowledgeEntries.workspaceId, input.workspaceId), eq(knowledgeEntries.scopeType, 'product'), eq(knowledgeEntries.scopeKey, String(input.nmId))))
      .limit(20);
    rows.forEach((r) => entries.push({ title: r.title, content: r.content, scope: 'product' }));
  }

  const tagIds = input.tagIds ?? [];
  if (tagIds.length) {
    const rows = await db
      .select({ title: knowledgeEntries.title, content: knowledgeEntries.content, scopeKey: knowledgeEntries.scopeKey })
      .from(knowledgeEntries)
      .where(and(eq(knowledgeEntries.workspaceId, input.workspaceId), eq(knowledgeEntries.scopeType, 'tag'), inArray(knowledgeEntries.scopeKey, tagIds.map(String) as any)))
      .limit(50);
    rows.forEach((r) => entries.push({ title: r.title, content: r.content, scope: `tag:${r.scopeKey}` }));
  }

  if (input.subjectId != null) {
    const rows = await db
      .select({ title: knowledgeEntries.title, content: knowledgeEntries.content })
      .from(knowledgeEntries)
      .where(and(eq(knowledgeEntries.workspaceId, input.workspaceId), eq(knowledgeEntries.scopeType, 'category'), eq(knowledgeEntries.scopeKey, String(input.subjectId))))
      .limit(20);
    rows.forEach((r) => entries.push({ title: r.title, content: r.content, scope: 'category' }));
  } else if (input.subjectName) {
    const rows = await db
      .select({ title: knowledgeEntries.title, content: knowledgeEntries.content })
      .from(knowledgeEntries)
      .where(and(eq(knowledgeEntries.workspaceId, input.workspaceId), eq(knowledgeEntries.scopeType, 'category'), eq(knowledgeEntries.scopeKey, input.subjectName)))
      .limit(20);
    rows.forEach((r) => entries.push({ title: r.title, content: r.content, scope: 'category' }));
  }

  const companyRows = await db
    .select({ title: knowledgeEntries.title, content: knowledgeEntries.content })
    .from(knowledgeEntries)
    .where(and(eq(knowledgeEntries.workspaceId, input.workspaceId), eq(knowledgeEntries.scopeType, 'company'), eq(knowledgeEntries.scopeKey, 'global')))
    .limit(20);
  companyRows.forEach((r) => entries.push({ title: r.title, content: r.content, scope: 'company' }));

  const context = entries
    .map((e) => `• [${e.scope}] ${e.title}\n${e.content}`)
    .join('\n\n');

  return { context, entries };
}

async function sendAnswer(params: { workspaceId: number; shopId?: number | null; marketplace: string; itemType: string; itemId: string; text: string }) {
  if (params.marketplace === 'wb') {
    if (params.itemType === 'review') {
      await sendWbFeedbackAnswer(params.workspaceId, params.shopId ?? null, params.itemId, params.text);
      return;
    }
    if (params.itemType === 'question') {
      await sendWbQuestionAnswer(params.workspaceId, params.shopId ?? null, params.itemId, params.text);
      return;
    }
  }
  throw new Error(`Send answer is not supported for ${params.marketplace}/${params.itemType}`);
}

export const feedbackRoutes: FastifyPluginAsync = async (app) => {
  // Register multipart for KB instruction uploads (15 MB limit — KB-инструкции
  // обычно небольшие, не нужно 50 МБ как documentHub). Регистрация в этом же
  // scope, не пересекается с documentHub.
  const multipart = (await import('@fastify/multipart')).default;
  await app.register(multipart, { limits: { fileSize: 15 * 1024 * 1024 } });
  // Распределение отзывов по AI-категориям и sentiment за период.
  // Заполняется в feedbackAutoReply при генерации черновика; категории —
  // quality / delivery / packaging / mismatch / service / praise / other.
  app.get('/feedback/:workspaceId/categories', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z
      .object({
        days: z.coerce.number().int().min(1).max(365).default(30),
        shopId: z.coerce.number().int().positive().optional(),
      })
      .parse(req.query);

    const since = new Date(Date.now() - query.days * 24 * 60 * 60 * 1000);
    const conds: any[] = [
      eq(marketplaceFeedbackItems.workspaceId, params.workspaceId),
      eq(marketplaceFeedbackItems.marketplace, 'wb'),
      gte(marketplaceFeedbackItems.createdAt, since),
    ];
    const shopFilter = buildShopFilter(marketplaceFeedbackItems.shopId, query.shopId);
    if (shopFilter) conds.push(shopFilter);

    type Row = { category: string | null; sentiment: string | null; count: number };
    const rows = await db
      .select({
        category: marketplaceFeedbackItems.category,
        sentiment: marketplaceFeedbackItems.sentiment,
        count: sql<number>`COUNT(*)`.mapWith(Number),
      })
      .from(marketplaceFeedbackItems)
      .where(and(...conds))
      .groupBy(marketplaceFeedbackItems.category, marketplaceFeedbackItems.sentiment);

    const byCategory: Record<string, number> = {};
    const bySentiment: Record<string, number> = {};
    let categorized = 0;
    let total = 0;
    for (const r of rows as Row[]) {
      total += r.count;
      if (r.category) {
        byCategory[r.category] = (byCategory[r.category] ?? 0) + r.count;
        categorized += r.count;
      }
      if (r.sentiment) {
        bySentiment[r.sentiment] = (bySentiment[r.sentiment] ?? 0) + r.count;
      }
    }

    return {
      period: `${query.days} дней`,
      total,
      categorized,
      uncategorizedHint:
        total > categorized
          ? `${total - categorized} отзывов ещё не классифицированы (новые AI обработает в течение 2 часов)`
          : null,
      byCategory,
      bySentiment,
    };
  });

  // AI-сводка отзывов и вопросов за период — вызывает queryFeedbackSummary
  // напрямую, не через AI-чат. Кэш 30 мин внутри tool, поэтому повторный
  // клик с теми же параметрами — без LLM-вызова.
  app.post('/feedback/:workspaceId/summary', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z
      .object({
        days: z.number().int().min(1).max(120).optional(),
        nmId: z.number().int().positive().optional(),
        itemType: z.enum(['review', 'question', 'all']).optional(),
        shopId: z.number().int().positive().optional(),
      })
      .parse(req.body ?? {});

    const { queryFeedbackSummary } = await import('../agents/tools/queryFeedbackSummary.js');
    const userId = (req as any).user?.userId ?? null;
    const resultJson = await queryFeedbackSummary({
      days: body.days,
      nmId: body.nmId,
      itemType: body.itemType,
      _workspaceId: params.workspaceId,
      _shopId: body.shopId,
      _userId: userId ?? undefined,
    });
    try {
      return JSON.parse(resultJson);
    } catch {
      return { error: 'failed to parse summary result', raw: resultJson };
    }
  });

  app.get('/feedback/:workspaceId/items', { preHandler: requireRole('viewer') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z
      .object({
        marketplace: marketplaceEnum.default('wb'),
        itemType: itemTypeEnum.default('review'),
        status: z.string().optional(),
        isAnswered: z.enum(['0', '1']).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
        offset: z.coerce.number().int().min(0).optional(),
        q: z.string().optional(),
        nmId: z.coerce.number().int().positive().optional(),
        dateFrom: z.string().optional(),
        dateTo: z.string().optional(),
        rating: z.coerce.number().int().min(1).max(5).optional(),
        hasPhoto: z.enum(['0', '1']).optional(),
        shopId: z.coerce.number().int().positive().optional(),
      })
      .parse(req.query);

    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;

    const conds: any[] = [
      eq(marketplaceFeedbackItems.workspaceId, params.workspaceId),
      eq(marketplaceFeedbackItems.marketplace, query.marketplace),
      eq(marketplaceFeedbackItems.itemType, query.itemType),
    ];
    if (query.shopId != null) conds.push(eq(marketplaceFeedbackItems.shopId, query.shopId));

    if (query.status) conds.push(eq(marketplaceFeedbackItems.status, query.status));
    if (query.isAnswered) conds.push(eq(marketplaceFeedbackItems.isAnswered, query.isAnswered === '1'));
    if (query.nmId) conds.push(eq(marketplaceFeedbackItems.nmId, query.nmId));
    if (query.dateFrom) conds.push(gte(marketplaceFeedbackItems.createdAt, new Date(query.dateFrom)));
    if (query.dateTo) conds.push(lte(marketplaceFeedbackItems.createdAt, new Date(query.dateTo + 'T23:59:59Z')));
    if (query.rating) conds.push(eq(marketplaceFeedbackItems.rating, query.rating));
    if (query.hasPhoto === '1') conds.push(gt(marketplaceFeedbackItems.photosCount, 0));
    if (query.hasPhoto === '0') conds.push(eq(marketplaceFeedbackItems.photosCount, 0));

    if (query.q && query.q.trim()) {
      const like = `%${query.q.trim().replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
      conds.push(
        or(
          ilike(marketplaceFeedbackItems.text, like),
          ilike(marketplaceFeedbackItems.productTitle, like),
          ilike(marketplaceFeedbackItems.vendorCode, like),
          ilike(marketplaceFeedbackItems.brandName, like)
        )
      );
    }

    const rows = await db
      .select()
      .from(marketplaceFeedbackItems)
      .where(and(...conds))
      .orderBy(desc(marketplaceFeedbackItems.createdAt))
      .limit(limit)
      .offset(offset);

    const itemIds = rows.map((r) => r.itemId);
    if (itemIds.length === 0) return { workspaceId: params.workspaceId, rows: [] };

    const analysisRows = await db
      .select()
      .from(marketplaceFeedbackAnalysis)
      .where(
        and(
          eq(marketplaceFeedbackAnalysis.workspaceId, params.workspaceId),
          eq(marketplaceFeedbackAnalysis.marketplace, query.marketplace),
          eq(marketplaceFeedbackAnalysis.itemType, query.itemType),
          inArray(marketplaceFeedbackAnalysis.itemId, itemIds as any)
        )
      );

    const draftRows = await db
      .select()
      .from(marketplaceReplyDrafts)
      .where(
        and(
          eq(marketplaceReplyDrafts.workspaceId, params.workspaceId),
          eq(marketplaceReplyDrafts.marketplace, query.marketplace),
          eq(marketplaceReplyDrafts.itemType, query.itemType),
          inArray(marketplaceReplyDrafts.itemId, itemIds as any)
        )
      )
      .orderBy(desc(marketplaceReplyDrafts.createdAt));

    const analysisById = new Map(analysisRows.map((r) => [r.itemId, r] as const));
    const draftById = new Map<string, any>();
    for (const d of draftRows) {
      if (!draftById.has(d.itemId)) draftById.set(d.itemId, d);
    }

    return {
      workspaceId: params.workspaceId,
      rows: rows.map((r) => {
        // Извлекаем isAbleReturnProductOrders из raw — WB-флаг возможности
        // возврата товара по отзыву. UI показывает кнопку «Возврат» только
        // при true. Раньше не отдавалось наверх, добавлено 2026-05-26.
        const raw = (r as any).raw;
        const isAbleReturnProductOrders = Boolean(raw?.isAbleReturnProductOrders);
        return {
          ...r,
          isAbleReturnProductOrders,
          analysis: analysisById.get(r.itemId) ?? null,
          draft: draftById.get(r.itemId) ?? null,
        };
      }),
    };
  });

  app.post('/feedback/:workspaceId/sync', { preHandler: requireRole('manager') },async (req, reply) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z
      .object({
        marketplace: marketplaceEnum.default('wb'),
        itemType: itemTypeEnum.default('review'),
        take: z.coerce.number().int().min(1).max(1000).optional(),
        skip: z.coerce.number().int().min(0).optional(),
      })
      .parse((req as any).body ?? {});

    if (body.marketplace === 'ozon') {
      return reply.code(501).send({ ok: false, note: 'Ozon sync not implemented yet' });
    }

    const syncShopId = Number((req.query as any)?.shopId) || undefined;
    const payload =
      body.itemType === 'review'
        ? await fetchWbFeedbacks(params.workspaceId, { isAnswered: false, take: body.take ?? 100, skip: body.skip ?? 0 }, syncShopId)
        : await fetchWbQuestions(params.workspaceId, { isAnswered: false, take: body.take ?? 100, skip: body.skip ?? 0 }, syncShopId);

    const list =
      body.itemType === 'review'
        ? [
            ...extractList(payload, ['data', 'feedbacks']),
            ...extractList(payload, ['feedbacks']),
            ...extractList(payload, ['data']),
          ]
        : [
            ...extractList(payload, ['data', 'questions']),
            ...extractList(payload, ['questions']),
            ...extractList(payload, ['data']),
          ];

    let upserts = 0;
    for (const raw of list) {
      const row = body.itemType === 'review'
        ? normalizeWbFeedback(raw, params.workspaceId, syncShopId ?? null)
        : normalizeWbQuestion(raw, params.workspaceId, syncShopId ?? null);
      if (!row) continue;

      await db
        .insert(marketplaceFeedbackItems)
        .values(row)
        .onConflictDoUpdate({
          target: [
            marketplaceFeedbackItems.workspaceId,
            marketplaceFeedbackItems.marketplace,
            marketplaceFeedbackItems.itemType,
            marketplaceFeedbackItems.itemId,
          ],
          set: { ...row, syncedAt: new Date() },
        });
      upserts++;
    }

    return { ok: true, count: upserts };
  });

  app.post('/feedback/:workspaceId/items/:itemType/:itemId/analyze', { preHandler: requireRole('manager') },async (req, reply) => {
    const params = z
      .object({
        workspaceId: z.coerce.number().int().positive(),
        itemType: itemTypeEnum,
        itemId: z.string().min(1),
      })
      .parse(req.params);

    const item = await db
      .select()
      .from(marketplaceFeedbackItems)
      .where(
        and(
          eq(marketplaceFeedbackItems.workspaceId, params.workspaceId),
          eq(marketplaceFeedbackItems.itemType, params.itemType),
          eq(marketplaceFeedbackItems.itemId, params.itemId)
        )
      )
      .limit(1);

    if (!item[0]) return reply.code(404).send({ ok: false, error: 'Item not found' });

    const analysis = await analyzeFeedback({
      itemType: params.itemType,
      text: item[0].text ?? '',
      pros: item[0].pros,
      cons: item[0].cons,
      rating: item[0].rating ?? null,
      workspaceId: params.workspaceId,
      itemId: params.itemId,
    });

    const row = {
      workspaceId: params.workspaceId,
      // shopId: тянем из самого item — analysis всегда должен оставаться в
      // том же магазине что и исходный feedback/question.
      shopId: item[0].shopId ?? null,
      marketplace: item[0].marketplace,
      itemType: params.itemType,
      itemId: params.itemId,
      sentiment: analysis.sentiment,
      summary: analysis.summary,
      keyPoints: analysis.keyPoints,
      topics: analysis.topics,
      issues: analysis.issues,
      confidence: analysis.confidence,
      updatedAt: new Date(),
    };

    await db
      .insert(marketplaceFeedbackAnalysis)
      .values({ ...row, createdAt: new Date() })
      .onConflictDoUpdate({
        target: [
          marketplaceFeedbackAnalysis.workspaceId,
          marketplaceFeedbackAnalysis.marketplace,
          marketplaceFeedbackAnalysis.itemType,
          marketplaceFeedbackAnalysis.itemId,
        ],
        set: row,
      });

    return { ok: true, analysis: row };
  });

  app.post('/feedback/:workspaceId/items/:itemType/:itemId/draft', { preHandler: requireRole('manager') },async (req, reply) => {
    const params = z
      .object({
        workspaceId: z.coerce.number().int().positive(),
        itemType: itemTypeEnum,
        itemId: z.string().min(1),
      })
      .parse(req.params);

    const body = z
      .object({
        allowWebSearch: z.boolean().optional(),
      })
      .parse((req as any).body ?? {});

    const itemRows = await db
      .select()
      .from(marketplaceFeedbackItems)
      .where(
        and(
          eq(marketplaceFeedbackItems.workspaceId, params.workspaceId),
          eq(marketplaceFeedbackItems.itemType, params.itemType),
          eq(marketplaceFeedbackItems.itemId, params.itemId)
        )
      )
      .limit(1);

    const item = itemRows[0];
    if (!item) return reply.code(404).send({ ok: false, error: 'Item not found' });

    const settings = await ensureSettings(params.workspaceId, item.marketplace, params.itemType);
    const allowWebSearch = body.allowWebSearch ?? settings.allowWebSearch;

    let subjectId: number | null = null;
    let subjectName: string | null = null;
    if (item.nmId) {
      const card = await db
        .select({ subjectId: wbCards.subjectId, subjectName: wbCards.subjectName })
        .from(wbCards)
        .where(and(eq(wbCards.workspaceId, params.workspaceId), eq(wbCards.nmId, item.nmId)))
        .limit(1);
      subjectId = card[0]?.subjectId ?? null;
      subjectName = card[0]?.subjectName ?? null;
    }

    let tagIds: number[] = [];
    if (item.nmId) {
      const links = await db
        .select({ tagId: wbTagProducts.tagId })
        .from(wbTagProducts)
        .where(and(eq(wbTagProducts.workspaceId, params.workspaceId), eq(wbTagProducts.nmId, item.nmId)));
      tagIds = links.map((l) => Number(l.tagId)).filter((n) => Number.isFinite(n));
    }

    const { context: knowledgeContext } = await loadKnowledgeContext({
      workspaceId: params.workspaceId,
      nmId: item.nmId ?? null,
      tagIds,
      subjectId,
      subjectName,
    });

    let webSources: Array<{ title: string; url: string; snippet?: string }> = [];
    if (params.itemType === 'question' && allowWebSearch) {
      const query = [item.text, item.productTitle].filter(Boolean).join(' ');
      const search = await searchWeb(query);
      webSources = search.results.slice(0, 5);
    }

    const draft = await generateReplyDraft({
      itemType: params.itemType,
      text: item.text ?? '',
      pros: item.pros,
      cons: item.cons,
      rating: item.rating ?? null,
      productTitle: item.productTitle,
      brandName: item.brandName,
      knowledgeContext,
      webSources,
      tone: settings.tone,
      maxLength: settings.maxLength,
      workspaceId: params.workspaceId,
      itemId: params.itemId,
    });

    // Superseded: предыдущие draft'ы для этого item помечаем как 'superseded'
    // чтобы UI не показывал стопку конкурирующих черновиков и было видно
    // только актуальный. Не трогаем уже sent/rejected.
    await db
      .update(marketplaceReplyDrafts)
      .set({ status: 'superseded', updatedAt: new Date() })
      .where(
        and(
          eq(marketplaceReplyDrafts.workspaceId, params.workspaceId),
          eq(marketplaceReplyDrafts.itemType, params.itemType),
          eq(marketplaceReplyDrafts.itemId, params.itemId),
          eq(marketplaceReplyDrafts.status, 'draft'),
        ),
      );

    const draftRow = await db
      .insert(marketplaceReplyDrafts)
      .values({
        workspaceId: params.workspaceId,
        shopId: item.shopId ?? null,
        marketplace: item.marketplace,
        itemType: params.itemType,
        itemId: params.itemId,
        source: 'ai',
        content: draft.answer,
        confidence: draft.confidence,
        status: 'draft',
        decisionReason: draft.rationale,
        webSources,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();

    await db
      .update(marketplaceFeedbackItems)
      .set({ status: 'draft', updatedAt: new Date() })
      .where(
        and(
          eq(marketplaceFeedbackItems.workspaceId, params.workspaceId),
          eq(marketplaceFeedbackItems.itemType, params.itemType),
          eq(marketplaceFeedbackItems.itemId, params.itemId)
        )
      );

    if (settings.autoSend && !settings.requireApproval && draft.confidence >= settings.minConfidence) {
      await sendAnswer({ workspaceId: params.workspaceId, marketplace: item.marketplace, itemType: params.itemType, itemId: params.itemId, text: draft.answer });

      await db
        .update(marketplaceReplyDrafts)
        .set({ status: 'sent', sentAt: new Date(), updatedAt: new Date() })
        .where(eq(marketplaceReplyDrafts.draftId, draftRow[0].draftId));

      await db
        .update(marketplaceFeedbackItems)
        .set({
          status: 'sent',
          isAnswered: true,
          answerText: draft.answer,
          answeredAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(marketplaceFeedbackItems.workspaceId, params.workspaceId),
            eq(marketplaceFeedbackItems.itemType, params.itemType),
            eq(marketplaceFeedbackItems.itemId, params.itemId)
          )
        );

      return { ok: true, draft: { ...draftRow[0], status: 'sent' }, sent: true };
    }

    if (settings.notifyTelegram) {
      const text = `<b>${params.itemType === 'review' ? 'Новый отзыв' : 'Новый вопрос'}</b>\n${item.productTitle ?? ''}\n\n${(item.text ?? '').slice(0, 3500)}\n\n<b>AI‑ответ:</b>\n${draft.answer.slice(0, 3500)}`;
      await sendTelegramModeration({
        text,
        buttons: [
          [
            { text: '✅ Отправить', callback_data: `approve:${draftRow[0].draftId}` },
            { text: '🚫 Не отправлять', callback_data: `reject:${draftRow[0].draftId}` },
          ],
        ],
      });
    }

    return { ok: true, draft: draftRow[0] };
  });

  app.post('/feedback/:workspaceId/items/:itemType/:itemId/approve', { preHandler: requireRole('manager') },async (req, reply) => {
    const params = z
      .object({
        workspaceId: z.coerce.number().int().positive(),
        itemType: itemTypeEnum,
        itemId: z.string().min(1),
      })
      .parse(req.params);

    const body = z
      .object({
        draftId: z.coerce.number().int().optional(),
        content: z.string().optional(),
      })
      .parse((req as any).body ?? {});

    const itemRows = await db
      .select()
      .from(marketplaceFeedbackItems)
      .where(
        and(
          eq(marketplaceFeedbackItems.workspaceId, params.workspaceId),
          eq(marketplaceFeedbackItems.itemType, params.itemType),
          eq(marketplaceFeedbackItems.itemId, params.itemId)
        )
      )
      .limit(1);
    const item = itemRows[0];
    if (!item) return reply.code(404).send({ ok: false, error: 'Item not found' });

    let draft = null as any;
    if (body.draftId) {
      const rows = await db
        .select()
        .from(marketplaceReplyDrafts)
        .where(and(
          eq(marketplaceReplyDrafts.draftId, body.draftId),
          eq(marketplaceReplyDrafts.workspaceId, params.workspaceId)  // SECURITY: prevent IDOR
        ))
        .limit(1);
      draft = rows[0];
    } else {
      const rows = await db
        .select()
        .from(marketplaceReplyDrafts)
        .where(
          and(
            eq(marketplaceReplyDrafts.workspaceId, params.workspaceId),
            eq(marketplaceReplyDrafts.marketplace, item.marketplace),
            eq(marketplaceReplyDrafts.itemType, params.itemType),
            eq(marketplaceReplyDrafts.itemId, params.itemId)
          )
        )
        .orderBy(desc(marketplaceReplyDrafts.createdAt))
        .limit(1);
      draft = rows[0];
    }

    const content = (body.content ?? draft?.content ?? '').trim();
    if (!content) return reply.code(400).send({ ok: false, error: 'No content to send' });

    try {
      await sendAnswer({ workspaceId: params.workspaceId, marketplace: item.marketplace, itemType: params.itemType, itemId: params.itemId, text: content });
    } catch (err: any) {
      req.log.error({ err, itemId: params.itemId, itemType: params.itemType }, 'Failed to send answer to marketplace');
      // Surface marketplace failures as 502 (bad gateway) so the frontend's
      // apiFetch throws and the UI can display the error to the user.
      return reply.code(502).send({ ok: false, error: 'marketplace_send_failed', message: `Не удалось отправить ответ на маркетплейс: ${String(err?.message ?? err).slice(0, 200)}` });
    }

    if (draft?.draftId) {
      await db
        .update(marketplaceReplyDrafts)
        .set({ status: 'sent', sentAt: new Date(), updatedAt: new Date(), content })
        .where(eq(marketplaceReplyDrafts.draftId, draft.draftId));
    } else {
      await db
        .insert(marketplaceReplyDrafts)
        .values({
          workspaceId: params.workspaceId,
          shopId: item.shopId ?? null,
          marketplace: item.marketplace,
          itemType: params.itemType,
          itemId: params.itemId,
          source: 'manual',
          content,
          status: 'sent',
          sentAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        });
    }

    await db
      .update(marketplaceFeedbackItems)
      .set({ status: 'sent', isAnswered: true, answerText: content, answeredAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(marketplaceFeedbackItems.workspaceId, params.workspaceId),
          eq(marketplaceFeedbackItems.itemType, params.itemType),
          eq(marketplaceFeedbackItems.itemId, params.itemId)
        )
      );

    return { ok: true };
  });

  app.post('/feedback/:workspaceId/items/:itemType/:itemId/reject', { preHandler: requireRole('manager') },async (req) => {
    const params = z
      .object({
        workspaceId: z.coerce.number().int().positive(),
        itemType: itemTypeEnum,
        itemId: z.string().min(1),
      })
      .parse(req.params);

    const body = z
      .object({
        draftId: z.coerce.number().int().optional(),
        reason: z.string().optional(),
      })
      .parse((req as any).body ?? {});

    if (body.draftId) {
      await db
        .update(marketplaceReplyDrafts)
        .set({ status: 'rejected', rejectedAt: new Date(), decisionReason: body.reason ?? null, updatedAt: new Date() })
        .where(and(eq(marketplaceReplyDrafts.draftId, body.draftId), eq(marketplaceReplyDrafts.workspaceId, params.workspaceId)));
    } else {
      const rows = await db
        .select()
        .from(marketplaceReplyDrafts)
        .where(
          and(
            eq(marketplaceReplyDrafts.workspaceId, params.workspaceId),
            eq(marketplaceReplyDrafts.itemType, params.itemType),
            eq(marketplaceReplyDrafts.itemId, params.itemId)
          )
        )
        .orderBy(desc(marketplaceReplyDrafts.createdAt))
        .limit(1);
      if (rows[0]) {
        await db
          .update(marketplaceReplyDrafts)
          .set({ status: 'rejected', rejectedAt: new Date(), decisionReason: body.reason ?? null, updatedAt: new Date() })
          .where(eq(marketplaceReplyDrafts.draftId, rows[0].draftId));
      }
    }

    await db
      .update(marketplaceFeedbackItems)
      .set({ status: 'rejected', updatedAt: new Date() })
      .where(
        and(
          eq(marketplaceFeedbackItems.workspaceId, params.workspaceId),
          eq(marketplaceFeedbackItems.itemType, params.itemType),
          eq(marketplaceFeedbackItems.itemId, params.itemId)
        )
      );

    return { ok: true };
  });

  // ─── Прямые WB-действия для UI (без AI-draft-цикла). 2026-05-26 ────────
  //
  // Эти endpoints вызывают WB API напрямую (через wb/feedbacks + wb/returns)
  // и НЕ ведут через marketplaceReplyDrafts. Используются для:
  //   - Редактирования ранее отправленного ответа (60-дн окно)
  //   - Возврата товара по отзыву (продавец-инициированный)
  //   - Отклонения вопроса на WB (state=none)
  //   - Отметки вопроса просмотренным
  // ─────────────────────────────────────────────────────────────────────────

  app.post('/feedback/:workspaceId/items/feedback/:itemId/edit-reply', { preHandler: requireRole('manager') }, async (req, reply) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive(), itemId: z.string().min(1) }).parse(req.params);
    const body = z.object({ text: z.string().min(1).max(2000) }).parse((req as any).body ?? {});
    const shopId = extractShopId(req) ?? null;
    try {
      await editWbFeedbackAnswer(params.workspaceId, shopId, params.itemId, body.text);
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      const hint = /60|expired|window/i.test(msg)
        ? ' (вероятно, прошло более 60 дней — WB запрещает редактирование)'
        : '';
      return reply.status(400).send({ ok: false, error: msg + hint });
    }
  });

  app.post('/feedback/:workspaceId/items/feedback/:itemId/return-by-review', { preHandler: requireRole('manager') }, async (req, reply) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive(), itemId: z.string().min(1) }).parse(req.params);
    const shopId = extractShopId(req) ?? null;
    try {
      const apiKey = await getWbApiKey(params.workspaceId, shopId ?? undefined);
      const { returnByReview } = await import('../integrations/wb/returns.js');
      await returnByReview(apiKey, params.itemId);
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      const hint = /isAbleReturn|not.allowed|forbidden/i.test(msg)
        ? ' (отзыв не допускает возврат: WB не поставил флаг isAbleReturnProductOrders)'
        : '';
      return reply.status(400).send({ ok: false, error: msg + hint });
    }
  });

  app.post('/feedback/:workspaceId/items/question/:itemId/reject-on-wb', { preHandler: requireRole('manager') }, async (req, reply) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive(), itemId: z.string().min(1) }).parse(req.params);
    const body = z.object({ text: z.string().min(1).max(2000) }).parse((req as any).body ?? {});
    const shopId = extractShopId(req) ?? null;
    try {
      await rejectWbQuestion(params.workspaceId, shopId, params.itemId, body.text);
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return reply.status(400).send({ ok: false, error: msg });
    }
  });

  app.post('/feedback/:workspaceId/items/question/:itemId/mark-viewed', { preHandler: requireRole('manager') }, async (req, reply) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive(), itemId: z.string().min(1) }).parse(req.params);
    const shopId = extractShopId(req) ?? null;
    try {
      await markWbQuestionAsViewed(params.workspaceId, shopId, params.itemId);
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return reply.status(400).send({ ok: false, error: msg });
    }
  });

  app.get('/feedback/:workspaceId/settings', { preHandler: requireRole('viewer') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z
      .object({
        marketplace: marketplaceEnum.default('wb'),
        itemType: itemTypeEnum.default('review'),
      })
      .parse(req.query);

    const row = await ensureSettings(params.workspaceId, query.marketplace, query.itemType);
    return { ok: true, settings: row };
  });

  app.put('/feedback/:workspaceId/settings', { preHandler: requireRole('manager') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z
      .object({
        marketplace: marketplaceEnum.default('wb'),
        itemType: itemTypeEnum.default('review'),
        autoSend: z.boolean().optional(),
        minConfidence: z.coerce.number().int().optional(),
        allowWebSearch: z.boolean().optional(),
        requireApproval: z.boolean().optional(),
        notifyTelegram: z.boolean().optional(),
        tone: z.string().optional(),
        maxLength: z.coerce.number().int().optional(),
      })
      .parse((req as any).body ?? {});

    await ensureSettings(params.workspaceId, body.marketplace, body.itemType);

    await db
      .update(marketplaceReplySettings)
      .set({
        autoSend: body.autoSend ?? undefined,
        minConfidence: body.minConfidence ?? undefined,
        allowWebSearch: body.allowWebSearch ?? undefined,
        requireApproval: body.requireApproval ?? undefined,
        notifyTelegram: body.notifyTelegram ?? undefined,
        tone: body.tone ?? undefined,
        maxLength: body.maxLength ?? undefined,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(marketplaceReplySettings.workspaceId, params.workspaceId),
          eq(marketplaceReplySettings.marketplace, body.marketplace),
          eq(marketplaceReplySettings.itemType, body.itemType)
        )
      );

    const rows = await db
      .select()
      .from(marketplaceReplySettings)
      .where(
        and(
          eq(marketplaceReplySettings.workspaceId, params.workspaceId),
          eq(marketplaceReplySettings.marketplace, body.marketplace),
          eq(marketplaceReplySettings.itemType, body.itemType)
        )
      )
      .limit(1);

    return { ok: true, settings: rows[0] };
  });

  app.get('/knowledge/:workspaceId', { preHandler: requireRole('viewer') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z
      .object({
        scopeType: z.string().optional(),
        scopeKey: z.string().optional(),
        q: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      })
      .parse(req.query);

    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;

    const conds: any[] = [eq(knowledgeEntries.workspaceId, params.workspaceId)];
    if (query.scopeType) {
      conds.push(eq(knowledgeEntries.scopeType, query.scopeType));
    } else {
      // По умолчанию страница «Отзывы и вопросы» НЕ показывает документы из
      // documentHub — это другой инструмент (общая база знаний AI). Они
      // отображаются на отдельной странице. Сюда попадают только знания
      // именно для отзывов/вопросов / brand voice.
      conds.push(sql`${knowledgeEntries.scopeType} NOT LIKE 'workspace:%'`);
    }
    if (query.scopeKey) conds.push(eq(knowledgeEntries.scopeKey, query.scopeKey));
    if (query.q) conds.push(or(ilike(knowledgeEntries.title, `%${escapeIlike(query.q)}%`), ilike(knowledgeEntries.content, `%${escapeIlike(query.q)}%`)));

    const rows = await db
      .select()
      .from(knowledgeEntries)
      .where(and(...conds))
      .orderBy(knowledgeEntries.createdAt)
      .limit(limit)
      .offset(offset);

    return { workspaceId: params.workspaceId, rows };
  });

  app.post('/knowledge/:workspaceId', { preHandler: requireRole('manager') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z
      .object({
        scopeType: z.string().min(1),
        scopeKey: z.string().min(1),
        title: z.string().min(1),
        content: z.string().min(1),
        tags: z.array(z.string()).optional(),
        source: z.string().optional(),
        entryType: z.string().optional(),
        priority: z.coerce.number().int().optional(),
        // Feedback Pipeline v2: привязка к конкретным товарам. Если пусто —
        // запись workspace-wide и используется для всех отзывов/вопросов.
        nmIds: z.array(z.coerce.number().int().positive()).optional(),
      })
      .parse((req as any).body ?? {});

    const rows = await db
      .insert(knowledgeEntries)
      .values({
        workspaceId: params.workspaceId,
        scopeType: body.scopeType,
        scopeKey: body.scopeKey,
        title: body.title,
        content: body.content,
        tags: body.tags ?? [],
        source: body.source ?? 'manual',
        entryType: body.entryType ?? 'general',
        nmIds: body.nmIds ?? [],
        priority: body.priority ?? 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();

    return { ok: true, entry: rows[0] };
  });

  app.patch('/knowledge/:workspaceId/:entryId', { preHandler: requireRole('manager') },async (req) => {
    const params = z
      .object({ workspaceId: z.coerce.number().int().positive(), entryId: z.coerce.number().int().positive() })
      .parse(req.params);
    const body = z
      .object({
        title: z.string().optional(),
        content: z.string().optional(),
        tags: z.array(z.string()).optional(),
      })
      .parse((req as any).body ?? {});

    await db
      .update(knowledgeEntries)
      .set({
        title: body.title ?? undefined,
        content: body.content ?? undefined,
        tags: body.tags ?? undefined,
        updatedAt: new Date(),
      })
      .where(and(eq(knowledgeEntries.workspaceId, params.workspaceId), eq(knowledgeEntries.entryId, params.entryId)));

    return { ok: true };
  });

  app.delete('/knowledge/:workspaceId/:entryId', { preHandler: requireRole('manager') },async (req) => {
    const params = z
      .object({ workspaceId: z.coerce.number().int().positive(), entryId: z.coerce.number().int().positive() })
      .parse(req.params);

    await db
      .delete(knowledgeEntries)
      .where(and(eq(knowledgeEntries.workspaceId, params.workspaceId), eq(knowledgeEntries.entryId, params.entryId)));

    return { ok: true };
  });

  // Upload файла-инструкции для отзывов/вопросов (PDF, DOCX, TXT, MD).
  // Файл парсится, текст сохраняется как обычная запись knowledge_entries
  // c scopeType='feedback' — она доступна AI при генерации ответов на отзывы
  // и вопросы, но НЕ смешивается с documentHub (общая БЗ).
  app.post('/knowledge/:workspaceId/upload', { preHandler: requireRole('manager') }, async (req, reply) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z.object({
      scopeKey: z.string().optional(),
      entryType: z.string().optional(),
      // nmId опционально — если задан, инструкция привяжется к конкретному товару.
      nmId: z.coerce.number().int().positive().optional(),
    }).parse(req.query);

    const file = await (req as any).file();
    if (!file) {
      return reply.code(400).send({ error: 'Файл не прикреплён' });
    }

    const buffer = await file.toBuffer();
    if (buffer.length === 0) {
      return reply.code(400).send({ error: 'Пустой файл' });
    }

    const { extractTextFromBuffer } = await import('./documentHub.js');
    let text: string;
    let fileType: string;
    try {
      const parsed = await extractTextFromBuffer(buffer, file.mimetype, file.filename);
      text = parsed.text;
      fileType = parsed.fileType;
    } catch (err: any) {
      return reply.code(400).send({ error: err.message || 'Не удалось извлечь текст из файла' });
    }

    if (!text.trim()) {
      return reply.code(400).send({ error: 'Файл не содержит текста' });
    }

    const title = file.filename.replace(/\.[^.]+$/, '') || 'Инструкция';

    const rows = await db
      .insert(knowledgeEntries)
      .values({
        workspaceId: params.workspaceId,
        scopeType: 'feedback',
        scopeKey: query.scopeKey ?? (query.nmId ? `nm:${query.nmId}` : 'global'),
        title,
        content: text,
        tags: [fileType, 'instruction'],
        source: 'feedback_upload',
        entryType: query.entryType ?? 'instruction',
        nmIds: query.nmId ? [query.nmId] : [],
        priority: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();

    return {
      ok: true,
      entry: rows[0],
      fileName: file.filename,
      fileType,
      textLength: text.length,
    };
  });

  // Telegram webhook (approval)
  app.post('/telegram/webhook', { preHandler: requireRole('manager') },async (req, reply) => {
    if (!verifyTelegramWebhookSecret(req.headers as any)) {
      return reply.code(401).send({ ok: false, error: 'Invalid telegram secret' });
    }

    const body = (req as any).body ?? {};

    // Telegram Payments: pre-checkout
    if (body?.pre_checkout_query) {
      const query = body.pre_checkout_query;
      const payload = parseTelegramPaymentPayload(query.invoice_payload);

      if (!payload) {
        await answerTelegramPreCheckout({
          queryId: query.id,
          ok: false,
          errorMessage: 'Некорректный платёж',
        });
        return { ok: true };
      }

      await answerTelegramPreCheckout({ queryId: query.id, ok: true });
      return { ok: true };
    }

    // Telegram Payments: successful payment
    if (body?.message?.successful_payment) {
      const payment = body.message.successful_payment;
      const payload = parseTelegramPaymentPayload(payment.invoice_payload);
      if (!payload) return { ok: true };

      const plan = resolvePlan(payload.planCode);
      const days = plan?.days;
      if (!days || days <= 0) return { ok: true };

      const now = new Date();
      const amountKopecks = Number(payment.total_amount ?? 0);
      const providerPaymentId = payment.provider_payment_charge_id || payment.telegram_payment_charge_id || null;

      const inserted = await db
        .insert(workspacePayments)
        .values({
          workspaceId: payload.workspaceId,
          provider: 'telegram',
          providerPaymentId,
          amountKopecks,
          currency: payment.currency ?? subscriptionCurrency,
          subscriptionType: plan.code,
          daysAdded: days,
          status: 'completed',
          paidAt: now,
          createdAt: now,
        })
        .onConflictDoNothing()
        .returning();

      if (!inserted.length) {
        return { ok: true };
      }

      const existingRows = await db
        .select()
        .from(workspaceSubscriptions)
        .where(eq(workspaceSubscriptions.workspaceId, payload.workspaceId))
        .limit(1);

      const existing = existingRows[0];
      const currentEnd = existing?.currentPeriodEnd ? new Date(existing.currentPeriodEnd) : null;
      const isActive = Boolean(existing && existing.status === 'active' && currentEnd && currentEnd > now);

      const nextStart = isActive && existing?.currentPeriodStart ? new Date(existing.currentPeriodStart) : now;
      const baseEnd = isActive && currentEnd ? currentEnd : now;
      const nextEnd = addDays(baseEnd, days);

      if (existing) {
        await db
          .update(workspaceSubscriptions)
          .set({
            status: 'active',
            planCode: plan.code,
            currentPeriodStart: nextStart,
            currentPeriodEnd: nextEnd,
            cancelAtPeriodEnd: false,
            updatedAt: now,
          })
          .where(eq(workspaceSubscriptions.workspaceId, payload.workspaceId));
      } else {
        await db.insert(workspaceSubscriptions).values({
          workspaceId: payload.workspaceId,
          status: 'active',
          planCode: plan.code,
          currentPeriodStart: nextStart,
          currentPeriodEnd: nextEnd,
          autoRenew: true,
          cancelAtPeriodEnd: false,
          createdAt: now,
          updatedAt: now,
        });
      }

      return { ok: true };
    }

    // Telegram moderation callbacks
    const cb = body?.callback_query;
    if (!cb?.data) return { ok: true };

    const parts = String(cb.data).split(':');
    const action = parts[0];
    const id = parts[1];
    const extra = parts[2]; // for snooze minutes

    // ─── Event callbacks (from reminderSender) ───
    if (action === 'event_done') {
      const eventId = Number(id);
      if (Number.isFinite(eventId)) {
        const { wbEvents } = await import('../db/schema.js');
        await db
          .update(wbEvents)
          .set({
            status: 'done',
            completedAt: new Date(),
            resolvedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(wbEvents.eventId, eventId));
      }
      return { ok: true };
    }

    if (action === 'event_snooze') {
      const eventId = Number(id);
      const snoozeMinutes = Number(extra) || 60;
      if (Number.isFinite(eventId)) {
        const { wbEvents } = await import('../db/schema.js');
        const newReminderAt = new Date(Date.now() + snoozeMinutes * 60 * 1000);
        await db
          .update(wbEvents)
          .set({
            reminderAt: newReminderAt,
            reminderSent: false,
            updatedAt: new Date(),
          })
          .where(eq(wbEvents.eventId, eventId));
      }
      return { ok: true };
    }

    // ─── Feedback draft callbacks ───
    const draftId = Number(id);
    if (!Number.isFinite(draftId)) return { ok: true };

    const rows = await db
      .select()
      .from(marketplaceReplyDrafts)
      .where(eq(marketplaceReplyDrafts.draftId, draftId))
      .limit(1);

    const draft = rows[0];
    if (!draft) return { ok: true };

    if (action === 'reject') {
      await db
        .update(marketplaceReplyDrafts)
        .set({ status: 'rejected', rejectedAt: new Date(), updatedAt: new Date() })
        .where(eq(marketplaceReplyDrafts.draftId, draftId));
      return { ok: true };
    }

    if (action === 'approve') {
      await sendAnswer({ workspaceId: draft.workspaceId, marketplace: draft.marketplace, itemType: draft.itemType, itemId: draft.itemId, text: draft.content });

      await db
        .update(marketplaceReplyDrafts)
        .set({ status: 'sent', sentAt: new Date(), updatedAt: new Date() })
        .where(eq(marketplaceReplyDrafts.draftId, draftId));

      await db
        .update(marketplaceFeedbackItems)
        .set({ status: 'sent', isAnswered: true, answerText: draft.content, answeredAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(marketplaceFeedbackItems.workspaceId, draft.workspaceId),
            eq(marketplaceFeedbackItems.marketplace, draft.marketplace),
            eq(marketplaceFeedbackItems.itemType, draft.itemType),
            eq(marketplaceFeedbackItems.itemId, draft.itemId)
          )
        );

      return { ok: true };
    }

    return { ok: true };
  });

  // ─────────────────────────────────────────────
  // POST /feedback/:workspaceId/ai/generate-batch
  // Generate AI responses for multiple reviews
  // ─────────────────────────────────────────────
  app.post('/feedback/:workspaceId/ai/generate-batch', {
    preHandler: requireRole('manager'),
    config: aiBatchRateLimit,
  }, async (req, reply) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z
      .object({
        itemIds: z.array(z.string()).min(1).max(50),
        itemType: itemTypeEnum.default('review'),
        marketplace: marketplaceEnum.default('wb'),
        autoSave: z.boolean().default(true),
      })
      .parse((req as any).body ?? {});

    // Provider charges are billed to the seller; there is no service balance.
    // Get items
    const items = await db
      .select()
      .from(marketplaceFeedbackItems)
      .where(
        and(
          eq(marketplaceFeedbackItems.workspaceId, params.workspaceId),
          eq(marketplaceFeedbackItems.marketplace, body.marketplace),
          eq(marketplaceFeedbackItems.itemType, body.itemType),
          inArray(marketplaceFeedbackItems.itemId, body.itemIds)
        )
      );

    if (items.length === 0) {
      return reply.code(404).send({ ok: false, error: 'No items found' });
    }

    // Get settings
    const settings = await ensureSettings(params.workspaceId, body.marketplace, body.itemType);

    // Generate responses for each item
    const results: Array<{
      itemId: string;
      success: boolean;
      response?: string;
      error?: string;
    }> = [];

    for (const item of items) {
      try {
        // Load knowledge context
        let tagIds: number[] = [];
        if (item.nmId) {
          const links = await db
            .select({ tagId: wbTagProducts.tagId })
            .from(wbTagProducts)
            .where(and(eq(wbTagProducts.workspaceId, params.workspaceId), eq(wbTagProducts.nmId, item.nmId)));
          tagIds = links.map((l) => Number(l.tagId)).filter((n) => Number.isFinite(n));
        }

        const { context: knowledgeContext } = await loadKnowledgeContext({
          workspaceId: params.workspaceId,
          nmId: item.nmId ?? null,
          tagIds,
          subjectId: null,
          subjectName: null,
        });

        // Generate draft
        const draft = await generateReplyDraft({
          itemType: body.itemType,
          text: item.text || '',
          pros: item.pros,
          cons: item.cons,
          rating: item.rating,
          productTitle: item.productTitle,
          brandName: item.brandName,
          userName: (item as any).userName,
          photosCount: (item as any).photosCount ?? 0,
          hasVideo: (item as any).hasVideo ?? false,
          knowledgeContext,
          settings: {
            tone: settings.tone || 'friendly',
            maxLength: settings.maxLength || 500,
            praiseLevel: (settings as any).praiseLevel,
            photoBonus: (settings as any).photoBonus,
            complaintStyle: (settings as any).complaintStyle,
            signature: (settings as any).signature,
          },
          workspaceId: params.workspaceId,
          itemId: item.itemId,
        });

        // Save draft if autoSave is enabled
        if (body.autoSave && draft.answer) {
          await db.insert(marketplaceReplyDrafts).values({
            workspaceId: params.workspaceId,
            shopId: (item as any).shopId ?? null,
            marketplace: body.marketplace,
            itemType: body.itemType,
            itemId: item.itemId,
            content: draft.answer,
            confidence: draft.confidence || 80,
            status: 'pending',
            createdAt: new Date(),
            updatedAt: new Date(),
          }).onConflictDoUpdate({
            target: [
              marketplaceReplyDrafts.workspaceId,
              marketplaceReplyDrafts.marketplace,
              marketplaceReplyDrafts.itemType,
              marketplaceReplyDrafts.itemId,
            ],
            set: {
              content: draft.answer,
              confidence: draft.confidence || 80,
              status: 'pending',
              updatedAt: new Date(),
            },
          });
        }

        results.push({
          itemId: item.itemId,
          success: true,
          response: draft.answer,
        });
      } catch (error) {
        results.push({
          itemId: item.itemId,
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    return {
      ok: true,
      total: items.length,
      successful: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results,
    };
  });

  // ─────────────────────────────────────────────
  // GET /feedback/:workspaceId/ai/stats
  // Get AI response statistics
  // ─────────────────────────────────────────────
  app.get('/feedback/:workspaceId/ai/stats', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z
      .object({
        marketplace: marketplaceEnum.default('wb'),
        from: z.string().optional(),
        to: z.string().optional(),
        shopId: z.coerce.number().int().positive().optional(),
      })
      .parse(req.query);

    const fromDate = query.from ? new Date(query.from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const toDate = query.to ? new Date(query.to) : new Date();
    const itemsShopFilter = buildShopFilter(marketplaceFeedbackItems.shopId, query.shopId);
    const draftsShopFilter = buildShopFilter(marketplaceReplyDrafts.shopId, query.shopId);

    // Count total reviews
    const totalReviewsConds: any[] = [
      eq(marketplaceFeedbackItems.workspaceId, params.workspaceId),
      eq(marketplaceFeedbackItems.marketplace, query.marketplace),
      eq(marketplaceFeedbackItems.itemType, 'review'),
      gte(marketplaceFeedbackItems.createdAt, fromDate),
      lte(marketplaceFeedbackItems.createdAt, toDate),
    ];
    if (itemsShopFilter) totalReviewsConds.push(itemsShopFilter);
    const totalReviews = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(marketplaceFeedbackItems)
      .where(and(...totalReviewsConds));

    // Count AI-generated drafts
    const aiDraftsConds: any[] = [
      eq(marketplaceReplyDrafts.workspaceId, params.workspaceId),
      eq(marketplaceReplyDrafts.marketplace, query.marketplace),
      gte(marketplaceReplyDrafts.createdAt, fromDate),
      lte(marketplaceReplyDrafts.createdAt, toDate),
    ];
    if (draftsShopFilter) aiDraftsConds.push(draftsShopFilter);
    const aiDrafts = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(marketplaceReplyDrafts)
      .where(and(...aiDraftsConds));

    // Count sent responses
    const sentConds: any[] = [
      eq(marketplaceReplyDrafts.workspaceId, params.workspaceId),
      eq(marketplaceReplyDrafts.marketplace, query.marketplace),
      eq(marketplaceReplyDrafts.status, 'sent'),
      gte(marketplaceReplyDrafts.createdAt, fromDate),
      lte(marketplaceReplyDrafts.createdAt, toDate),
    ];
    if (draftsShopFilter) sentConds.push(draftsShopFilter);
    const sentResponses = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(marketplaceReplyDrafts)
      .where(and(...sentConds));

    // Count unanswered reviews
    const unansweredConds: any[] = [
      eq(marketplaceFeedbackItems.workspaceId, params.workspaceId),
      eq(marketplaceFeedbackItems.marketplace, query.marketplace),
      eq(marketplaceFeedbackItems.itemType, 'review'),
      eq(marketplaceFeedbackItems.isAnswered, false),
      gte(marketplaceFeedbackItems.createdAt, fromDate),
    ];
    if (itemsShopFilter) unansweredConds.push(itemsShopFilter);
    const unanswered = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(marketplaceFeedbackItems)
      .where(and(...unansweredConds));

    return {
      ok: true,
      period: { from: fromDate.toISOString(), to: toDate.toISOString() },
      stats: {
        totalReviews: totalReviews[0]?.count || 0,
        aiDraftsGenerated: aiDrafts[0]?.count || 0,
        responsesSent: sentResponses[0]?.count || 0,
        unansweredReviews: unanswered[0]?.count || 0,
        responseRate: totalReviews[0]?.count
          ? Math.round((sentResponses[0]?.count || 0) / totalReviews[0].count * 100)
          : 0,
      },
    };
  });

  // ─────────────────────────────────────────────
  // POST /knowledge/:workspaceId/import
  // Import knowledge from feedback history
  // ─────────────────────────────────────────────
  app.post('/knowledge/:workspaceId/import', { preHandler: requireRole('manager') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);

    const { importKnowledgeForWorkspaceManual } = await import('../jobs/knowledgeImport.js');
    const result = await importKnowledgeForWorkspaceManual(params.workspaceId);

    return {
      ok: true,
      ...result,
    };
  });

  // ─────────────────────────────────────────────
  // GET /knowledge/:workspaceId/stats
  // Knowledge base statistics
  // ─────────────────────────────────────────────
  app.get('/knowledge/:workspaceId/stats', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);

    const stats = await db
      .select({
        entryType: knowledgeEntries.entryType,
        scopeType: knowledgeEntries.scopeType,
        count: sql<number>`count(*)::int`,
      })
      .from(knowledgeEntries)
      .where(
        and(
          eq(knowledgeEntries.workspaceId, params.workspaceId),
          eq(knowledgeEntries.isActive, true)
        )
      )
      .groupBy(knowledgeEntries.entryType, knowledgeEntries.scopeType);

    const total = stats.reduce((sum, s) => sum + s.count, 0);
    const byType = stats.reduce((acc, s) => {
      acc[s.entryType ?? 'general'] = (acc[s.entryType ?? 'general'] || 0) + s.count;
      return acc;
    }, {} as Record<string, number>);

    const byScope = stats.reduce((acc, s) => {
      acc[s.scopeType] = (acc[s.scopeType] || 0) + s.count;
      return acc;
    }, {} as Record<string, number>);

    return { ok: true, total, byType, byScope };
  });

  // ─────────────────────────────────────────────
  // PUT /feedback/:workspaceId/settings (extended)
  // Update reply settings with AI tuning
  // ─────────────────────────────────────────────
  app.put('/feedback/:workspaceId/settings/extended', { preHandler: requireRole('manager') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z
      .object({
        marketplace: marketplaceEnum.default('wb'),
        itemType: itemTypeEnum.default('review'),
        // Basic settings
        autoSend: z.boolean().optional(),
        minConfidence: z.coerce.number().int().min(0).max(100).optional(),
        allowWebSearch: z.boolean().optional(),
        requireApproval: z.boolean().optional(),
        notifyTelegram: z.boolean().optional(),
        tone: z.string().max(200).optional(),
        // maxLength минимум 50 — иначе AI не успеет связать «спасибо» и решение.
        maxLength: z.coerce.number().int().min(50).max(2000).optional(),
        // AI tuning settings
        praiseLevel: z.enum(['minimal', 'moderate', 'enthusiastic']).optional(),
        photoBonus: z.boolean().optional(),
        star5Template: z.string().max(1000).optional(),
        complaintStyle: z.enum(['apologetic', 'solution_focused', 'balanced']).optional(),
        signature: z.string().max(200).optional(),
        // Чистим пустые/только-пробельные строки, иначе AI начнёт фильтровать
        // любой ответ за «запрещённое слово = пробел».
        forbiddenWords: z.array(z.string()).optional().transform((arr) =>
          arr ? Array.from(new Set(arr.map((w) => w.trim()).filter((w) => w.length > 0 && w.length <= 100))) : arr,
        ),
        autoSendPositive: z.boolean().optional(),
        autoSendMinRating: z.coerce.number().int().min(1).max(5).optional(),
      })
      .parse((req as any).body ?? {});

    await ensureSettings(params.workspaceId, body.marketplace, body.itemType);

    const updates: any = { updatedAt: new Date() };
    
    // Map all provided fields to updates
    const fields = [
      'autoSend', 'minConfidence', 'allowWebSearch', 'requireApproval', 
      'notifyTelegram', 'tone', 'maxLength', 'praiseLevel', 'photoBonus',
      'star5Template', 'complaintStyle', 'signature', 'forbiddenWords',
      'autoSendPositive', 'autoSendMinRating'
    ];
    
    for (const field of fields) {
      if ((body as any)[field] !== undefined) {
        updates[field] = (body as any)[field];
      }
    }

    await db
      .update(marketplaceReplySettings)
      .set(updates)
      .where(
        and(
          eq(marketplaceReplySettings.workspaceId, params.workspaceId),
          eq(marketplaceReplySettings.marketplace, body.marketplace),
          eq(marketplaceReplySettings.itemType, body.itemType)
        )
      );

    const [row] = await db
      .select()
      .from(marketplaceReplySettings)
      .where(
        and(
          eq(marketplaceReplySettings.workspaceId, params.workspaceId),
          eq(marketplaceReplySettings.marketplace, body.marketplace),
          eq(marketplaceReplySettings.itemType, body.itemType)
        )
      )
      .limit(1);

    return { ok: true, settings: row };
  });

  // ─────────────────────────────────────────────
  // POST /feedback/:workspaceId/sync-history
  // Sync historical answered feedbacks
  // ─────────────────────────────────────────────
  app.post('/feedback/:workspaceId/sync-history', { preHandler: requireRole('manager') }, async (req, reply) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z
      .object({
        marketplace: marketplaceEnum.default('wb'),
        take: z.coerce.number().int().min(1).max(5000).optional(),
      })
      .parse((req as any).body ?? {});

    if (body.marketplace === 'ozon') {
      return reply.code(501).send({ ok: false, note: 'Ozon sync not implemented yet' });
    }

    const syncHistShopId = Number((req.query as any)?.shopId) || undefined;
    // Sync answered feedbacks
    const answeredPayload = await fetchWbFeedbacks(params.workspaceId, { isAnswered: true, take: body.take || 1000, skip: 0 }, syncHistShopId);
    const answeredList = [
      ...extractList(answeredPayload, ['data', 'feedbacks']),
      ...extractList(answeredPayload, ['feedbacks']),
      ...extractList(answeredPayload, ['data']),
    ];

    // Sync answered questions
    const questionsPayload = await fetchWbQuestions(params.workspaceId, { isAnswered: true, take: body.take || 1000, skip: 0 });
    const questionsList = [
      ...extractList(questionsPayload, ['data', 'questions']),
      ...extractList(questionsPayload, ['questions']),
      ...extractList(questionsPayload, ['data']),
    ];

    let upserts = 0;

    for (const raw of answeredList) {
      const row = normalizeWbFeedback(raw, params.workspaceId, syncHistShopId ?? null);
      if (!row) continue;

      await db
        .insert(marketplaceFeedbackItems)
        .values(row)
        .onConflictDoUpdate({
          target: [
            marketplaceFeedbackItems.workspaceId,
            marketplaceFeedbackItems.marketplace,
            marketplaceFeedbackItems.itemType,
            marketplaceFeedbackItems.itemId,
          ],
          set: { ...row, syncedAt: new Date() },
        });
      upserts++;
    }

    for (const raw of questionsList) {
      const row = normalizeWbQuestion(raw, params.workspaceId, syncHistShopId ?? null);
      if (!row) continue;

      await db
        .insert(marketplaceFeedbackItems)
        .values(row)
        .onConflictDoUpdate({
          target: [
            marketplaceFeedbackItems.workspaceId,
            marketplaceFeedbackItems.marketplace,
            marketplaceFeedbackItems.itemType,
            marketplaceFeedbackItems.itemId,
          ],
          set: { ...row, syncedAt: new Date() },
        });
      upserts++;
    }

    return { ok: true, feedbacks: answeredList.length, questions: questionsList.length, upserts };
  });

  // =========================================================================
  // PINNED FEEDBACKS
  // =========================================================================

  /**
   * Get pinned feedbacks
   */
  app.get('/feedback/:workspaceId/pins', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z.object({
      state: z.enum(['pinned', 'unpinned']).optional(),
      pinOn: z.enum(['nm', 'imt']).optional(),
      nmId: z.coerce.number().int().optional(),
      imtId: z.coerce.number().int().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }).parse(req.query);

    const result = await getPinnedFeedbacks(params.workspaceId, query, Number((req.query as any)?.shopId) || undefined);
    return { ok: true, ...result };
  });

  /**
   * Pin feedback to product card
   * Requires subscription "Джем" or option "Закрепление отзыва"
   */
  app.post('/feedback/:workspaceId/pins', { preHandler: requireRole('manager') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z.object({
      feedbackId: z.string().min(1),
      imtId: z.coerce.number().int().positive(),
      pinOn: z.enum(['nm', 'imt']).default('imt'),
    }).parse((req as any).body ?? {});

    await pinFeedback(params.workspaceId, body.feedbackId, body.imtId, body.pinOn, Number((req.query as any)?.shopId) || undefined);
    return { ok: true, feedbackId: body.feedbackId, pinOn: body.pinOn };
  });

  /**
   * Unpin feedback
   */
  app.delete('/feedback/:workspaceId/pins/:pinId', { preHandler: requireRole('manager') }, async (req) => {
    const params = z.object({
      workspaceId: z.coerce.number().int().positive(),
      pinId: z.coerce.number().int().positive(),
    }).parse(req.params);

    await unpinFeedback(params.workspaceId, params.pinId, Number((req.query as any)?.shopId) || undefined);
    return { ok: true };
  });

  // =========================================================================
  // NEW FEEDBACKS COUNTER
  // =========================================================================

  /**
   * Get count of new (unviewed) feedbacks and questions
   */
  app.get('/feedback/:workspaceId/new-count', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);

    const result = await getNewFeedbacksCount(params.workspaceId, Number((req.query as any)?.shopId) || undefined);
    return { ok: true, ...result };
  });

  /**
   * Mark feedbacks as read
   */
  app.post('/feedback/:workspaceId/read', { preHandler: requireRole('manager') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z.object({
      feedbackIds: z.array(z.string().min(1)).min(1).max(100),
    }).parse((req as any).body ?? {});

    await markFeedbacksRead(params.workspaceId, body.feedbackIds, Number((req.query as any)?.shopId) || undefined);
    return { ok: true, count: body.feedbackIds.length };
  });

  // =========================================================================
  // UNANSWERED COUNTERS
  // =========================================================================

  /**
   * Get count of unanswered feedbacks
   */
  app.get('/feedback/:workspaceId/unanswered/feedbacks', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const shopId = Number((req.query as any)?.shopId) || undefined;
    const result = await getUnansweredFeedbacksCount(params.workspaceId, shopId);
    return { ok: true, ...result };
  });

  /**
   * Get count of unanswered questions
   */
  app.get('/feedback/:workspaceId/unanswered/questions', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const shopId = Number((req.query as any)?.shopId) || undefined;
    const result = await getUnansweredQuestionsCount(params.workspaceId, shopId);
    return { ok: true, ...result };
  });

  /**
   * Get total unanswered count (feedbacks + questions)
   */
  /**
   * Прогон автоответа «прямо сейчас» по всем неотвеченным отзывам/вопросам ws.
   * Игнорирует настройку «Полуавто» — принудительно отправляет ответы.
   * Используется кнопкой «Автоответить на N неотвеченных» в /feedback.
   */
  app.post('/feedback/:workspaceId/auto-reply-now', { preHandler: requireRole('manager') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const shopId = Number((req.query as any)?.shopId) || undefined;

    const rows = await db
      .select()
      .from(marketplaceReplySettings)
      .where(eq(marketplaceReplySettings.workspaceId, params.workspaceId));

    const filtered = shopId
      ? rows.filter((s) => s.shopId == null || s.shopId === shopId)
      : rows;
    if (filtered.length === 0) {
      return { ok: false, reason: 'no_settings', processed: 0, drafts: 0, sent: 0 };
    }

    const forced = filtered.map((s) => ({
      ...s,
      autoSend: true,
      requireApproval: false,
      minConfidence: 0,
      autoSendMinRating: 0,
      ...(shopId ? { shopId } : {}),
    }));

    const result = await runAutoReplyForWorkspace(params.workspaceId, forced as any);
    return { ok: true, ...result };
  });

  app.get('/feedback/:workspaceId/unanswered', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const shopId = Number((req.query as any)?.shopId) || undefined;

    // WB API can be flaky и иногда стоит в rate-limit очереди на 20+ секунд
    // (cron занимает бюджет). UI-бэдж не должен блокировать 15-30 сек — кладём
    // таймаут 5с и fallback на 0.
    const safe = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
      try {
        return await Promise.race([
          fn(),
          new Promise<T>((_, rej) => setTimeout(() => rej(new Error('feedback-count timeout 5s')), 5000)),
        ]);
      } catch (err: any) {
        req.log.warn({ err: err?.message }, 'unanswered count fetch failed');
        return fallback;
      }
    };

    const [feedbacks, questions] = await Promise.all([
      safe(() => getUnansweredFeedbacksCount(params.workspaceId, shopId), { count: 0 }),
      safe(() => getUnansweredQuestionsCount(params.workspaceId, shopId), { count: 0 }),
    ]);

    return {
      ok: true,
      feedbacks: feedbacks.count,
      questions: questions.count,
      total: feedbacks.count + questions.count,
    };
  });
};
