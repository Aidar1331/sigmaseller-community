import type { FastifyPluginAsync } from 'fastify';
import { eq, and, gte, lte, desc, asc, or, sql, inArray, isNull, isNotNull, ne, gt, lt, ilike, between, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { insightSettings } from '../db/schema.js';
import { requireRole } from '../plugins/roleCheck.js';

const settingsSchema = z.object({
  workspaceId: z.number().int().positive(),
  sensitivity: z.enum(['sensitive', 'standard', 'critical']).optional(),
  minStockDays: z.number().int().min(0).max(3650).optional(),
  targetDrrPct: z.number().int().min(0).max(500).optional(),
  excludedTagIds: z.array(z.number().int().positive()).optional(),
  notifyChannels: z.any().optional(),
  notifyTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  timezone: z.string().min(1).max(64).optional(),
});

function defaultSettings(workspaceId: number) {
  return {
    workspaceId,
    sensitivity: 'standard',
    minStockDays: 5,
    targetDrrPct: 20,
    excludedTagIds: [],
    notifyChannels: { ui: true, telegram: false, categories: {} },
    notifyTime: '08:00',
    timezone: 'Europe/Moscow',
    lastRunAt: null as Date | null,
  };
}

export const insightSettingsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/insight-settings/:workspaceId', { preHandler: requireRole('viewer') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);

    const rows = await db.select().from(insightSettings).where(eq(insightSettings.workspaceId, params.workspaceId)).limit(1);
    if (rows.length) return { ok: true, settings: rows[0] };

    const defaults = defaultSettings(params.workspaceId);
    const [row] = await db
      .insert(insightSettings)
      .values({
        workspaceId: defaults.workspaceId,
        sensitivity: defaults.sensitivity,
        minStockDays: defaults.minStockDays,
        targetDrrPct: defaults.targetDrrPct,
        excludedTagIds: defaults.excludedTagIds,
        notifyChannels: defaults.notifyChannels,
        notifyTime: defaults.notifyTime,
        timezone: defaults.timezone,
        lastRunAt: null,
        updatedAt: new Date(),
      })
      .returning();

    return { ok: true, settings: row };
  });

  app.post('/insight-settings/:workspaceId', { preHandler: requireRole('manager') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = settingsSchema.parse({ ...(req.body as any), workspaceId: params.workspaceId });

    const patch: any = {
      updatedAt: new Date(),
    };

    if (body.sensitivity !== undefined) patch.sensitivity = body.sensitivity;
    if (body.minStockDays !== undefined) patch.minStockDays = body.minStockDays;
    if (body.targetDrrPct !== undefined) patch.targetDrrPct = body.targetDrrPct;
    if (body.excludedTagIds !== undefined) patch.excludedTagIds = body.excludedTagIds;
    if (body.notifyChannels !== undefined) patch.notifyChannels = body.notifyChannels;
    if (body.notifyTime !== undefined) patch.notifyTime = body.notifyTime;
    if (body.timezone !== undefined) patch.timezone = body.timezone;

    const existing = await db.select().from(insightSettings).where(eq(insightSettings.workspaceId, params.workspaceId)).limit(1);
    if (!existing.length) {
      const defaults = defaultSettings(params.workspaceId);
      const [row] = await db
        .insert(insightSettings)
        .values({
          workspaceId: params.workspaceId,
          sensitivity: body.sensitivity ?? defaults.sensitivity,
          minStockDays: body.minStockDays ?? defaults.minStockDays,
          targetDrrPct: body.targetDrrPct ?? defaults.targetDrrPct,
          excludedTagIds: body.excludedTagIds ?? defaults.excludedTagIds,
          notifyChannels: body.notifyChannels ?? defaults.notifyChannels,
          notifyTime: body.notifyTime ?? defaults.notifyTime,
          timezone: body.timezone ?? defaults.timezone,
          updatedAt: new Date(),
        })
        .returning();
      return { ok: true, settings: row };
    }

    const [row] = await db
      .update(insightSettings)
      .set(patch)
      .where(eq(insightSettings.workspaceId, params.workspaceId))
      .returning();

    return { ok: true, settings: row };
  });
};
