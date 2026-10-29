import type { FastifyPluginAsync } from 'fastify';
import { eq, and, gte, lte, desc, asc, or, sql, inArray, isNull, isNotNull, ne, gt, lt, ilike, between, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { pulseAlertControls } from '../db/schema.js';
import { requireRole } from '../plugins/roleCheck.js';

const bodySchema = z.object({
  workspaceId: z.number().int().positive(),
  actorUserId: z.number().int().positive(),

  controlId: z.number().int().positive().optional(),
  tagId: z.number().int().positive().nullable().optional(),
  nmId: z.number().int().positive().nullable().optional(),

  enableStocks: z.boolean().optional(),
  enableAds: z.boolean().optional(),
  enableDrr: z.boolean().optional(),
  enableBuyout: z.boolean().optional(),
  enableSalesDrop: z.boolean().optional(),

  cooldownDays: z.number().int().min(0).max(90).optional(),
});

export const alertControlsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/alert-controls', { preHandler: requireRole('viewer') },async (req) => {
    const q = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.query);

    const rows = await db
      .select()
      .from(pulseAlertControls)
      .where(eq(pulseAlertControls.workspaceId, q.workspaceId))
      .orderBy(desc(pulseAlertControls.nmId), desc(pulseAlertControls.tagId), asc(pulseAlertControls.controlId));

    return { rows };
  });

  app.post('/alert-controls', { preHandler: requireRole('manager') },async (req) => {
    const body = bodySchema.parse(req.body);
    const now = new Date();

    if (body.controlId) {
      const [row] = await db
        .update(pulseAlertControls)
        .set({
          tagId: body.tagId ?? null,
          nmId: body.nmId ?? null,
          enableStocks: body.enableStocks ?? undefined,
          enableAds: body.enableAds ?? undefined,
          enableDrr: body.enableDrr ?? undefined,
          enableBuyout: body.enableBuyout ?? undefined,
          enableSalesDrop: body.enableSalesDrop ?? undefined,
          cooldownDays: body.cooldownDays ?? undefined,
          updatedAt: now,
        })
        .where(and(eq(pulseAlertControls.workspaceId, body.workspaceId), eq(pulseAlertControls.controlId, body.controlId)))
        .returning();
      return { row };
    }

    const [row] = await db
      .insert(pulseAlertControls)
      .values({
        workspaceId: body.workspaceId,
        tagId: body.tagId ?? null,
        nmId: body.nmId ?? null,
        enableStocks: body.enableStocks ?? true,
        enableAds: body.enableAds ?? true,
        enableDrr: body.enableDrr ?? true,
        enableBuyout: body.enableBuyout ?? true,
        enableSalesDrop: body.enableSalesDrop ?? true,
        cooldownDays: body.cooldownDays ?? 1,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return { row };
  });

  app.delete('/alert-controls/:controlId', { preHandler: requireRole('owner') },async (req) => {
    const params = z.object({ controlId: z.coerce.number().int().positive() }).parse(req.params);
    const q = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.query);

    const [row] = await db
      .delete(pulseAlertControls)
      .where(and(eq(pulseAlertControls.workspaceId, q.workspaceId), eq(pulseAlertControls.controlId, params.controlId)))
      .returning();

    return { row };
  });
};
