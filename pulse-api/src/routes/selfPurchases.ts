import type { FastifyPluginAsync } from 'fastify';
import { eq, and, gte, lte, sql, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { wbSelfPurchases } from '../db/schema.js';
import { requireRole } from '../plugins/roleCheck.js';
import { buildShopFilter } from './pulse/helpers.js';

export const selfPurchasesRoutes: FastifyPluginAsync = async (app) => {
  // Список самовыкупов
  app.get('/self-purchases/:workspaceId', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z.object({
      start: z.string().optional(),
      end: z.string().optional(),
      shopId: z.coerce.number().int().positive().optional(),
      nmId: z.coerce.number().int().positive().optional(),
    }).parse(req.query);

    const today = new Date().toISOString().slice(0, 10);
    const end = query.end ?? today;
    const start = query.start ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const rows = await db
      .select()
      .from(wbSelfPurchases)
      .where(
        and(
          eq(wbSelfPurchases.workspaceId, params.workspaceId),
          gte(wbSelfPurchases.date, start),
          lte(wbSelfPurchases.date, end),
          query.shopId ? eq(wbSelfPurchases.shopId, query.shopId) : undefined,
          query.nmId ? eq(wbSelfPurchases.nmId, query.nmId) : undefined,
        )
      )
      .orderBy(wbSelfPurchases.date);

    // Итоги
    const totals = {
      count: rows.length,
      totalQuantity: rows.reduce((s, r) => s + (r.quantity || 0), 0),
      totalAmountRub: rows.reduce((s, r) => s + (r.amountKopecks || 0), 0) / 100,
    };

    return {
      workspaceId: params.workspaceId,
      start,
      end,
      rows: rows.map(r => ({
        id: r.id,
        shopId: r.shopId,
        nmId: r.nmId,
        date: r.date,
        quantity: r.quantity,
        amountRub: (r.amountKopecks || 0) / 100,
        purpose: r.purpose,
        orderId: r.orderId,
        comment: r.comment,
        createdAt: r.createdAt,
      })),
      totals,
    };
  });

  // Агрегация по товарам (для unit-economics)
  app.get('/self-purchases/:workspaceId/by-product', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z.object({
      start: z.string().optional(),
      end: z.string().optional(),
      shopId: z.coerce.number().int().positive().optional(),
      nmIds: z.string().optional(),
    }).parse(req.query);

    const today = new Date().toISOString().slice(0, 10);
    const end = query.end ?? today;
    const start = query.start ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const nmIds = query.nmIds?.split(',').map(s => Number(s.trim())).filter(n => n > 0);

    const rows = await db
      .select({
        nmId: wbSelfPurchases.nmId,
        quantity: sql<number>`sum(${wbSelfPurchases.quantity})`.as('quantity'),
        amountKopecks: sql<number>`sum(${wbSelfPurchases.amountKopecks})`.as('amountKopecks'),
      })
      .from(wbSelfPurchases)
      .where(
        and(
          eq(wbSelfPurchases.workspaceId, params.workspaceId),
          gte(wbSelfPurchases.date, start),
          lte(wbSelfPurchases.date, end),
          query.shopId ? eq(wbSelfPurchases.shopId, query.shopId) : undefined,
          nmIds?.length ? inArray(wbSelfPurchases.nmId, nmIds) : undefined,
        )
      )
      .groupBy(wbSelfPurchases.nmId);

    return {
      workspaceId: params.workspaceId,
      start,
      end,
      rows: rows.map(r => ({
        nmId: r.nmId,
        quantity: Number(r.quantity) || 0,
        amountRub: (Number(r.amountKopecks) || 0) / 100,
      })),
    };
  });

  // Добавить самовыкуп
  app.post('/self-purchases/:workspaceId', { preHandler: requireRole('manager') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z.object({
      shopId: z.number().int().positive().optional(),
      nmId: z.number().int().positive().optional(),
      date: z.string(),
      quantity: z.number().int().positive().default(1),
      amountRub: z.number().min(0),
      purpose: z.enum(['review', 'photo', 'test', 'other']).optional(),
      orderId: z.string().optional(),
      comment: z.string().optional(),
    }).parse(req.body);

    const [inserted] = await db
      .insert(wbSelfPurchases)
      .values({
        workspaceId: params.workspaceId,
        shopId: body.shopId ?? null,
        nmId: body.nmId ?? null,
        date: body.date,
        quantity: body.quantity,
        amountKopecks: Math.round(body.amountRub * 100),
        purpose: body.purpose ?? null,
        orderId: body.orderId ?? null,
        comment: body.comment ?? null,
        createdByUserId: (req as any).user?.userId ?? null,
      })
      .returning();

    return { ok: true, id: inserted.id };
  });

  // Удалить самовыкуп
  app.delete('/self-purchases/:workspaceId/:id', { preHandler: requireRole('manager') }, async (req) => {
    const params = z.object({
      workspaceId: z.coerce.number().int().positive(),
      id: z.coerce.number().int().positive(),
    }).parse(req.params);

    await db
      .delete(wbSelfPurchases)
      .where(
        and(
          eq(wbSelfPurchases.workspaceId, params.workspaceId),
          eq(wbSelfPurchases.id, params.id),
        )
      );

    return { ok: true };
  });
};
