import type { FastifyPluginAsync } from 'fastify';
import { eq, and, desc, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { priceAbTests, priceAbPhases, wbCards, wbOrdersSalesDailyProducts, wbFunnelDailyProducts } from '../db/schema.js';
import { getWbApiKey, wbGetJson, wbPostJson } from '../integrations/wb/wbClient.js';
import { requireRole } from '../plugins/roleCheck.js';
import { extractShopId } from '../plugins/shopFilter.js';
import log from '../lib/logger.js';

const logger = log.child({ module: 'priceAb' });

const PRICES_BASE = 'https://discounts-prices-api.wildberries.ru/api/v2';

async function resolveShopId(workspaceId: number, nmId: number, testShopId: number | null | undefined, reqShopId?: number): Promise<number | undefined> {
  if (reqShopId) return reqShopId;
  if (testShopId) return testShopId;
  const [row] = await db
    .select({ shopId: wbCards.shopId })
    .from(wbCards)
    .where(and(eq(wbCards.workspaceId, workspaceId), eq(wbCards.nmId, nmId)))
    .limit(1);
  return row?.shopId ?? undefined;
}

/**
 * Прочитать текущую цену товара из WB. Возвращает priceKop (с учётом client_discount,
 * как и в кабинете). Если не нашлось — undefined.
 */
export async function getCurrentWbPrice(apiKey: string, nmId: number): Promise<number | undefined> {
  const qs = new URLSearchParams({ limit: '1', offset: '0', filterNmID: String(nmId) });
  const url = `${PRICES_BASE}/list/goods/filter?${qs.toString()}`;
  try {
    const data: any = await wbGetJson(url, apiKey);
    const good = data?.data?.listGoods?.[0];
    if (!good) return undefined;
    const sizes = good.sizes ?? [];
    const first = sizes[0];
    if (!first) return undefined;
    // WB отдаёт price в рублях. Конвертируем в копейки.
    return Math.round(Number(first.price) * 100);
  } catch (err: any) {
    logger.warn({ err: err?.message, nmId }, 'getCurrentWbPrice failed');
    return undefined;
  }
}

/**
 * Загрузить цену товара в WB через POST /upload/task. Используется как при ротации,
 * так и при остановке/применении победителя.
 */
export async function uploadPriceToWb(apiKey: string, nmId: number, priceKop: number): Promise<void> {
  const body = { data: [{ nmID: nmId, price: Math.round(priceKop / 100), discount: 0 }] };
  await wbPostJson(`${PRICES_BASE}/upload/task`, apiKey, body);
}

const variantSchema = z.object({
  label: z.string().min(1).max(4),
  priceKop: z.number().int().positive(),
});

const createBodySchema = z.object({
  nmId: z.coerce.number().int().positive(),
  name: z.string().max(120).nullish(),
  goal: z.enum(['orders', 'revenue', 'margin', 'ctr']).default('orders'),
  periodDays: z.number().int().min(1).max(60).default(7),
  rotationMinutes: z.number().int().min(20).max(10080).default(20),
  autoRotate: z.boolean().default(true),
  variants: z.array(variantSchema).min(2).max(4),
});

export const priceAbRoutes: FastifyPluginAsync = async (app) => {
  // List tests for workspace
  app.get('/price-ab/:workspaceId', { preHandler: requireRole('viewer') }, async (req) => {
    const { workspaceId } = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const shopId = extractShopId(req);
    const rows = await db
      .select()
      .from(priceAbTests)
      .where(and(
        eq(priceAbTests.workspaceId, workspaceId),
        shopId ? eq(priceAbTests.shopId, shopId) : sql`true`,
      ))
      .orderBy(desc(priceAbTests.createdAt))
      .limit(100);
    return { tests: rows };
  });

  // Create test
  app.post('/price-ab/:workspaceId', { preHandler: requireRole('manager') }, async (req, reply) => {
    const { workspaceId } = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = createBodySchema.parse(req.body);
    const reqShopId = extractShopId(req);
    const shopId = await resolveShopId(workspaceId, body.nmId, undefined, reqShopId);
    if (!shopId) {
      return reply.code(400).send({ error: 'cannot resolve shopId for nm' });
    }
    const apiKey = await getWbApiKey(workspaceId, shopId);
    const originalPriceKop = await getCurrentWbPrice(apiKey, body.nmId);

    // Стартуем с варианта A. Сразу же отправляем его цену в WB.
    const first = body.variants[0];
    let priceSynced = false;
    let syncError: string | null = null;
    try {
      await uploadPriceToWb(apiKey, body.nmId, first.priceKop);
      priceSynced = true;
    } catch (err: any) {
      syncError = err?.message ?? String(err);
      logger.error({ err: syncError, nmId: body.nmId }, 'initial price upload failed');
    }

    const now = new Date();
    const [test] = await db.insert(priceAbTests).values({
      workspaceId,
      shopId,
      nmId: body.nmId,
      name: body.name ?? null,
      goal: body.goal,
      periodDays: body.periodDays,
      variants: body.variants,
      currentVariant: first.label,
      rotationMinutes: body.rotationMinutes,
      autoRotate: body.autoRotate,
      originalPriceKop: originalPriceKop ?? null,
      lastRotatedAt: now,
      lastSyncError: syncError,
      startedAt: now,
      status: 'running',
    }).returning();

    await db.insert(priceAbPhases).values({
      testId: test.testId,
      variant: first.label,
      priceKop: first.priceKop,
      startedAt: now,
      priceSynced,
      syncError,
    });

    return { test };
  });

  // Test details + phases + current
  app.get('/price-ab/:workspaceId/:testId', { preHandler: requireRole('viewer') }, async (req, reply) => {
    const { workspaceId, testId } = z.object({
      workspaceId: z.coerce.number().int().positive(),
      testId: z.coerce.number().int().positive(),
    }).parse(req.params);
    const [test] = await db.select().from(priceAbTests)
      .where(and(eq(priceAbTests.testId, testId), eq(priceAbTests.workspaceId, workspaceId)))
      .limit(1);
    if (!test) return reply.code(404).send({ error: 'not found' });
    const phases = await db.select().from(priceAbPhases)
      .where(eq(priceAbPhases.testId, testId))
      .orderBy(desc(priceAbPhases.startedAt));
    return { test, phases };
  });

  // Stop & revert to original price
  app.post('/price-ab/:workspaceId/:testId/stop', { preHandler: requireRole('manager') }, async (req, reply) => {
    const { workspaceId, testId } = z.object({
      workspaceId: z.coerce.number().int().positive(),
      testId: z.coerce.number().int().positive(),
    }).parse(req.params);
    const [test] = await db.select().from(priceAbTests)
      .where(and(eq(priceAbTests.testId, testId), eq(priceAbTests.workspaceId, workspaceId)))
      .limit(1);
    if (!test) return reply.code(404).send({ error: 'not found' });
    if (test.status !== 'running') return reply.code(400).send({ error: `test is ${test.status}` });

    let syncError: string | null = null;
    if (test.originalPriceKop) {
      try {
        const apiKey = await getWbApiKey(workspaceId, test.shopId ?? (await resolveShopId(workspaceId, test.nmId, test.shopId))!);
        await uploadPriceToWb(apiKey, test.nmId, test.originalPriceKop);
      } catch (err: any) {
        syncError = err?.message ?? String(err);
      }
    }

    const now = new Date();
    await db.update(priceAbTests).set({
      status: 'completed',
      completedAt: now,
      lastSyncError: syncError,
      updatedAt: now,
    }).where(eq(priceAbTests.testId, testId));

    // Закрываем последнюю активную фазу
    await db.update(priceAbPhases).set({ endedAt: now })
      .where(and(eq(priceAbPhases.testId, testId), sql`ended_at IS NULL`));

    return { ok: true };
  });

  // Apply winner — закрывает тест и фиксирует цену победителя
  app.post('/price-ab/:workspaceId/:testId/apply-winner', { preHandler: requireRole('manager') }, async (req, reply) => {
    const { workspaceId, testId } = z.object({
      workspaceId: z.coerce.number().int().positive(),
      testId: z.coerce.number().int().positive(),
    }).parse(req.params);
    const body = z.object({ winnerLabel: z.string().min(1).max(4) }).parse(req.body ?? {});

    const [test] = await db.select().from(priceAbTests)
      .where(and(eq(priceAbTests.testId, testId), eq(priceAbTests.workspaceId, workspaceId)))
      .limit(1);
    if (!test) return reply.code(404).send({ error: 'not found' });

    const variants = (test.variants as any[]) ?? [];
    const winner = variants.find((v) => v.label === body.winnerLabel);
    if (!winner) return reply.code(400).send({ error: 'unknown variant label' });

    let syncError: string | null = null;
    try {
      const apiKey = await getWbApiKey(workspaceId, test.shopId ?? (await resolveShopId(workspaceId, test.nmId, test.shopId))!);
      await uploadPriceToWb(apiKey, test.nmId, winner.priceKop);
    } catch (err: any) {
      syncError = err?.message ?? String(err);
    }

    const now = new Date();
    await db.update(priceAbTests).set({
      status: 'completed',
      winnerVariant: winner.label,
      completedAt: now,
      lastSyncError: syncError,
      updatedAt: now,
    }).where(eq(priceAbTests.testId, testId));

    await db.update(priceAbPhases).set({ endedAt: now })
      .where(and(eq(priceAbPhases.testId, testId), sql`ended_at IS NULL`));

    return { ok: true, winner };
  });
};
