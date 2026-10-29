import type { FastifyPluginAsync } from 'fastify';
import { eq, and, gte, lte, desc, asc, or, sql, inArray, isNull, isNotNull, ne, gt, lt, ilike, between, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { wbAlertSettings } from '../db/schema.js';
import { requireRole } from '../plugins/roleCheck.js';

const settingsSchema = z.object({
  workspaceId: z.number().int().positive(),
  actorUserId: z.number().int().positive(),

  settingId: z.number().int().positive().optional(),
  tagId: z.number().int().positive().nullable().optional(),
  nmId: z.number().int().positive().nullable().optional(),

  maxDrrFactPct: z.number().int().min(0).max(500).nullable().optional(),
  maxDrrForecastPct: z.number().int().min(0).max(500).nullable().optional(),
  minDaysOfStock: z.number().int().min(0).max(3650).nullable().optional(),
  buyoutDropPpWarn: z.number().int().min(0).max(100).nullable().optional(),
  buyoutDropPpCrit: z.number().int().min(0).max(100).nullable().optional(),
});

export const alertSettingsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/alert-settings', { preHandler: requireRole('viewer') },async (req) => {
    const q = z
      .object({
        workspaceId: z.coerce.number().int().positive(),
      })
      .parse(req.query);


    const rows = await db
      .select()
      .from(wbAlertSettings)
      .where(eq(wbAlertSettings.workspaceId, q.workspaceId))
      .orderBy(desc(wbAlertSettings.nmId), desc(wbAlertSettings.tagId), asc(wbAlertSettings.settingId));

    return { rows };
  });

  app.post('/alert-settings', { preHandler: requireRole('manager') },async (req) => {
    const body = settingsSchema.parse(req.body);

    // Upsert by (workspaceId, nmId, tagId) semantics are not enforced in DB.
    // Here: if settingId provided -> update; else create.

    const now = new Date();

    if (body.settingId) {
      const [row] = await db
        .update(wbAlertSettings)
        .set({
          tagId: body.tagId ?? null,
          nmId: body.nmId ?? null,
          maxDrrFactPct: body.maxDrrFactPct ?? null,
          maxDrrForecastPct: body.maxDrrForecastPct ?? null,
          minDaysOfStock: body.minDaysOfStock ?? null,
          buyoutDropPpWarn: body.buyoutDropPpWarn ?? null,
          buyoutDropPpCrit: body.buyoutDropPpCrit ?? null,
          updatedAt: now,
        })
        .where(and(eq(wbAlertSettings.workspaceId, body.workspaceId), eq(wbAlertSettings.settingId, body.settingId)))
        .returning();

      return { row };
    }

    const [row] = await db
      .insert(wbAlertSettings)
      .values({
        workspaceId: body.workspaceId,
        tagId: body.tagId ?? null,
        nmId: body.nmId ?? null,
        maxDrrFactPct: body.maxDrrFactPct ?? null,
        maxDrrForecastPct: body.maxDrrForecastPct ?? null,
        minDaysOfStock: body.minDaysOfStock ?? null,
        buyoutDropPpWarn: body.buyoutDropPpWarn ?? null,
        buyoutDropPpCrit: body.buyoutDropPpCrit ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return { row };
  });

  app.delete('/alert-settings/:settingId', { preHandler: requireRole('owner') },async (req) => {
    const params = z.object({ settingId: z.coerce.number().int().positive() }).parse(req.params);
    const q = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.query);


    const [row] = await db
      .delete(wbAlertSettings)
      .where(and(eq(wbAlertSettings.workspaceId, q.workspaceId), eq(wbAlertSettings.settingId, params.settingId)))
      .returning();

    return { row };
  });
};
