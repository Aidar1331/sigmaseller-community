import type { FastifyPluginAsync } from 'fastify';
import { eq, and, gte, lte, desc, asc, or, sql, inArray, isNull, isNotNull, ne, gt, lt, ilike, between, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import {
  pulsePresets,
  pulsePresetGroupSettings,
  pulsePresetMetricSettings,
  pulsePresetEvents,
  workspaces,
} from '../db/schema.js';
import { NotFoundError, InternalError } from '../lib/errors.js';
import { requireRole } from '../plugins/roleCheck.js';

const adsTabSchema = z.enum(['general', 'unified', 'manual']);

const presetConfigSchema = z
  .object({
    heatmap: z
      .object({
        numberFormat: z.enum(['full', 'short']).optional(),
      })
      .optional(),
    header: z
      .object({
        deltasEnabled: z.boolean().optional(),
        anomaliesEnabled: z.boolean().optional(),
        anomalyThreshold: z.number().int().min(-80).max(80).optional(),
      })
      .optional(),
    ads: z
      .object({
        tab: adsTabSchema.optional(),
      })
      .optional(),
  })
  .passthrough();

const createPresetBodySchema = z.object({
  workspaceId: z.number().int().positive(),
  shopId: z.number().int().positive().optional(),
  // actorUserId опционален: если фронт не успел загрузить юзера из store,
  // берём из request.user (JWT). Раньше требовали positive int → 400
  // «Некорректные входные данные» при race-condition с auth-store.
  actorUserId: z.number().int().positive().optional(),

  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),

  isPinned: z.boolean().optional(),
  sortOrder: z.number().int().optional(),

  config: presetConfigSchema.default({}),

  // optional bulk toggles (hybrid approach)
  groupToggles: z
    .array(z.object({ groupId: z.string().min(1), isEnabled: z.boolean() }))
    .optional(),
  metricToggles: z
    .array(z.object({ metricId: z.string().min(1), isEnabled: z.boolean() }))
    .optional(),
});

const updatePresetBodySchema = z
  .object({
    actorUserId: z.number().int().positive(),
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
    isPinned: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
    config: presetConfigSchema.optional(),
    groupToggles: z
      .array(z.object({ groupId: z.string().min(1), isEnabled: z.boolean() }))
      .optional(),
    metricToggles: z
      .array(z.object({ metricId: z.string().min(1), isEnabled: z.boolean() }))
      .optional(),
  })
  .strict();

const pinPresetBodySchema = z.object({
  actorUserId: z.number().int().positive(),
  isPinned: z.boolean(),
});

const reorderPresetBodySchema = z.object({
  actorUserId: z.number().int().positive(),
  sortOrder: z.number().int(),
});

const bulkReorderBodySchema = z.object({
  actorUserId: z.number().int().positive(),
  workspaceId: z.number().int().positive(),
  items: z
    .array(
      z.object({
        presetId: z.number().int().positive(),
        sortOrder: z.number().int(),
      })
    )
    .min(1),
});

/* ─── workspace ownership helper ─── */
async function verifyPresetOwnership(presetId: number, workspaceId: number) {
  const [preset] = await db
    .select()
    .from(pulsePresets)
    .where(and(eq(pulsePresets.presetId, presetId), eq(pulsePresets.workspaceId, workspaceId)))
    .limit(1);
  return preset ?? null;
}

export const presetsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/presets', { preHandler: requireRole('viewer') },async (req) => {
    const q = z
      .object({
        workspaceId: z.coerce.number().int().positive(),
        shopId: z.coerce.number().int().positive().optional(),
        includeDeleted: z
          .union([z.literal('true'), z.literal('false')])
          .optional(),
      })
      .parse(req.query);


    const includeDeleted = q.includeDeleted === 'true';

    const conditions: any[] = [eq(pulsePresets.workspaceId, q.workspaceId)];
    if (!includeDeleted) {
      conditions.push(isNull(pulsePresets.deletedAt));
    }
    if (q.shopId) {
      // Include both shop-specific presets AND workspace-wide presets (shopId IS NULL)
      conditions.push(or(eq(pulsePresets.shopId, q.shopId), isNull(pulsePresets.shopId)));
    }

    const presets = await db
      .select()
      .from(pulsePresets)
      .where(and(...conditions))
      .orderBy(desc(pulsePresets.isPinned), asc(pulsePresets.sortOrder), desc(pulsePresets.updatedAt));

    return { presets };
  });

  app.get('/presets/:presetId', { preHandler: requireRole('viewer') },async (req) => {
    const params = z
      .object({
        presetId: z.coerce.number().int().positive(),
      })
      .parse(req.params);
    const q = z
      .object({ workspaceId: z.coerce.number().int().positive() })
      .parse(req.query);

    const preset = await verifyPresetOwnership(params.presetId, q.workspaceId);
    if (!preset) throw new NotFoundError('Preset not found in workspace');


    const groupToggles = await db
      .select()
      .from(pulsePresetGroupSettings)
      .where(eq(pulsePresetGroupSettings.presetId, params.presetId));

    const metricToggles = await db
      .select()
      .from(pulsePresetMetricSettings)
      .where(eq(pulsePresetMetricSettings.presetId, params.presetId));

    return { preset, groupToggles, metricToggles };
  });

  app.post('/presets', { preHandler: requireRole('manager') },async (req, reply) => {
    const body = createPresetBodySchema.parse(req.body);

    // actorUserId: предпочитаем явно переданный, иначе берём из аутентификации.
    // Без этого фолбэка пресет создавался без атрибуции к пользователю.
    const sessionUserId = (req as any).user?.userId ?? null;
    const actorUserId = body.actorUserId ?? sessionUserId;
    if (!actorUserId) {
      throw Object.assign(new Error('Не удалось определить пользователя'), { statusCode: 401 });
    }

    // Verify workspace exists
    const [ws] = await db.select({ workspaceId: workspaces.workspaceId }).from(workspaces).where(eq(workspaces.workspaceId, body.workspaceId)).limit(1);
    if (!ws) throw new NotFoundError('Workspace not found');

    // Check for duplicate name within workspace + shop (non-deleted presets only)
    const dupConditions: any[] = [
      eq(pulsePresets.workspaceId, body.workspaceId),
      eq(pulsePresets.name, body.name),
      isNull(pulsePresets.deletedAt),
    ];
    if (body.shopId) {
      dupConditions.push(eq(pulsePresets.shopId, body.shopId));
    } else {
      dupConditions.push(isNull(pulsePresets.shopId));
    }
    const [dup] = await db
      .select({ presetId: pulsePresets.presetId })
      .from(pulsePresets)
      .where(and(...dupConditions))
      .limit(1);
    if (dup) {
      throw Object.assign(new Error('Имя уже занято, выберите другое'), { statusCode: 409 });
    }

    const result = await db.transaction(async (tx) => {
      const [preset] = await tx
        .insert(pulsePresets)
        .values({
          workspaceId: body.workspaceId,
          shopId: body.shopId ?? null,
          createdByUserId: actorUserId,
          name: body.name,
          description: body.description,
          config: body.config,
          isPinned: body.isPinned ?? true,
          sortOrder: body.sortOrder ?? 0,
        })
        .returning();

      if (!preset) throw new InternalError('Insert preset failed');

      if (body.groupToggles?.length) {
        await tx.insert(pulsePresetGroupSettings).values(
          body.groupToggles.map((g) => ({
            presetId: preset.presetId,
            groupId: g.groupId,
            isEnabled: g.isEnabled,
          }))
        );
      }

      if (body.metricToggles?.length) {
        await tx.insert(pulsePresetMetricSettings).values(
          body.metricToggles.map((m) => ({
            presetId: preset.presetId,
            metricId: m.metricId,
            isEnabled: m.isEnabled,
          }))
        );
      }

      await tx.insert(pulsePresetEvents).values({
        presetId: preset.presetId,
        workspaceId: body.workspaceId,
        actorUserId,
        eventType: 'created',
        before: null,
        after: {
          name: preset.name,
          config: preset.config,
          isPinned: preset.isPinned,
          sortOrder: preset.sortOrder,
        },
      });

      return preset;
    });

    return reply.code(201).send({ preset: result });
  });

  app.patch('/presets/:presetId', { preHandler: requireRole('manager') },async (req) => {
    const params = z
      .object({ presetId: z.coerce.number().int().positive() })
      .parse(req.params);
    const body = updatePresetBodySchema.parse(req.body);
    const q = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.query);

    const owned = await verifyPresetOwnership(params.presetId, q.workspaceId);
    if (!owned) throw new NotFoundError('Preset not found in workspace');


    const result = await db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(pulsePresets)
        .where(eq(pulsePresets.presetId, params.presetId))
        .limit(1);

      if (!before) throw new NotFoundError('Preset not found');

      const [after] = await tx
        .update(pulsePresets)
        .set({
          name: body.name ?? before.name,
          description:
            body.description === undefined ? before.description : body.description,
          config: body.config ?? before.config,
          isPinned: body.isPinned ?? before.isPinned,
          sortOrder: body.sortOrder ?? before.sortOrder,
          updatedAt: new Date(),
        })
        .where(eq(pulsePresets.presetId, params.presetId))
        .returning();

      if (!after) throw new InternalError('Update failed');

      if (body.groupToggles) {
        await tx
          .delete(pulsePresetGroupSettings)
          .where(eq(pulsePresetGroupSettings.presetId, params.presetId));
        if (body.groupToggles.length) {
          await tx.insert(pulsePresetGroupSettings).values(
            body.groupToggles.map((g) => ({
              presetId: params.presetId,
              groupId: g.groupId,
              isEnabled: g.isEnabled,
            }))
          );
        }
      }

      if (body.metricToggles) {
        await tx
          .delete(pulsePresetMetricSettings)
          .where(eq(pulsePresetMetricSettings.presetId, params.presetId));
        if (body.metricToggles.length) {
          await tx.insert(pulsePresetMetricSettings).values(
            body.metricToggles.map((m) => ({
              presetId: params.presetId,
              metricId: m.metricId,
              isEnabled: m.isEnabled,
            }))
          );
        }
      }

      await tx.insert(pulsePresetEvents).values({
        presetId: params.presetId,
        workspaceId: after.workspaceId,
        actorUserId: body.actorUserId,
        eventType: 'updated_config',
        before: {
          name: before.name,
          description: before.description,
          config: before.config,
          isPinned: before.isPinned,
          sortOrder: before.sortOrder,
        },
        after: {
          name: after.name,
          description: after.description,
          config: after.config,
          isPinned: after.isPinned,
          sortOrder: after.sortOrder,
        },
      });

      return after;
    });

    return { preset: result };
  });

  app.patch('/presets/:presetId/pin', { preHandler: requireRole('manager') },async (req) => {
    const params = z
      .object({ presetId: z.coerce.number().int().positive() })
      .parse(req.params);
    const body = pinPresetBodySchema.parse(req.body);
    const q = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.query);

    const owned = await verifyPresetOwnership(params.presetId, q.workspaceId);
    if (!owned) throw new NotFoundError('Preset not found in workspace');


    const [after] = await db
      .update(pulsePresets)
      .set({ isPinned: body.isPinned, updatedAt: new Date() })
      .where(eq(pulsePresets.presetId, params.presetId))
      .returning();

    if (!after) throw new NotFoundError('Preset not found');

    await db.insert(pulsePresetEvents).values({
      presetId: params.presetId,
      workspaceId: after.workspaceId,
      actorUserId: body.actorUserId,
      eventType: 'pinned_changed',
      before: null,
      after: { isPinned: after.isPinned },
    });

    return { preset: after };
  });

  app.patch('/presets/:presetId/order', { preHandler: requireRole('manager') },async (req) => {
    const params = z
      .object({ presetId: z.coerce.number().int().positive() })
      .parse(req.params);
    const body = reorderPresetBodySchema.parse(req.body);
    const q = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.query);

    const owned = await verifyPresetOwnership(params.presetId, q.workspaceId);
    if (!owned) throw new NotFoundError('Preset not found in workspace');


    const [after] = await db
      .update(pulsePresets)
      .set({ sortOrder: body.sortOrder, updatedAt: new Date() })
      .where(eq(pulsePresets.presetId, params.presetId))
      .returning();

    if (!after) throw new NotFoundError('Preset not found');

    await db.insert(pulsePresetEvents).values({
      presetId: params.presetId,
      workspaceId: after.workspaceId,
      actorUserId: body.actorUserId,
      eventType: 'reordered',
      before: null,
      after: { sortOrder: after.sortOrder },
    });

    return { preset: after };
  });

  app.post('/presets/:presetId/duplicate', { preHandler: requireRole('manager') },async (req, reply) => {
    const params = z
      .object({ presetId: z.coerce.number().int().positive() })
      .parse(req.params);
    const body = z
      .object({
        actorUserId: z.number().int().positive(),
        workspaceId: z.number().int().positive(),
        name: z.string().min(1).max(200).optional(),
      })
      .parse(req.body);

    const owned = await verifyPresetOwnership(params.presetId, body.workspaceId);
    if (!owned) throw new NotFoundError('Preset not found in workspace');


    const result = await db.transaction(async (tx) => {
      const [src] = await tx
        .select()
        .from(pulsePresets)
        .where(eq(pulsePresets.presetId, params.presetId))
        .limit(1);

      if (!src) throw new NotFoundError('Preset not found');

      const name = body.name ?? `${src.name} (copy)`;

      const [dst] = await tx
        .insert(pulsePresets)
        .values({
          workspaceId: src.workspaceId,
          createdByUserId: body.actorUserId,
          name,
          description: src.description,
          config: src.config,
          isPinned: src.isPinned,
          sortOrder: src.sortOrder,
        })
        .returning();

      if (!dst) throw new InternalError('Duplicate failed');

      const groups = await tx
        .select()
        .from(pulsePresetGroupSettings)
        .where(eq(pulsePresetGroupSettings.presetId, src.presetId));

      if (groups.length) {
        await tx.insert(pulsePresetGroupSettings).values(
          groups.map((g) => ({
            presetId: dst.presetId,
            groupId: g.groupId,
            isEnabled: g.isEnabled,
          }))
        );
      }

      const metrics = await tx
        .select()
        .from(pulsePresetMetricSettings)
        .where(eq(pulsePresetMetricSettings.presetId, src.presetId));

      if (metrics.length) {
        await tx.insert(pulsePresetMetricSettings).values(
          metrics.map((m) => ({
            presetId: dst.presetId,
            metricId: m.metricId,
            isEnabled: m.isEnabled,
          }))
        );
      }

      await tx.insert(pulsePresetEvents).values({
        presetId: dst.presetId,
        workspaceId: dst.workspaceId,
        actorUserId: body.actorUserId,
        eventType: 'created',
        before: null,
        after: { duplicatedFrom: src.presetId },
      });

      return dst;
    });

    return reply.code(201).send({ preset: result });
  });

  app.delete('/presets/:presetId', { preHandler: requireRole('manager') },async (req, reply) => {
    const params = z
      .object({ presetId: z.coerce.number().int().positive() })
      .parse(req.params);
    // Support both body and query for workspaceId (DELETE often has no body)
    const q = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.query);
    const bodyRaw = typeof req.body === 'object' && req.body !== null ? req.body : {};
    const body = z.object({
      actorUserId: z.number().int().positive().optional(),
      workspaceId: z.number().int().positive().optional(),
    }).parse(bodyRaw);
    const workspaceId = body.workspaceId ?? q.workspaceId;
    const actorUserId = body.actorUserId ?? (req as any).userId ?? 1;

    const owned = await verifyPresetOwnership(params.presetId, workspaceId);
    if (!owned) throw new NotFoundError('Preset not found in workspace');


    const [after] = await db
      .update(pulsePresets)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(pulsePresets.presetId, params.presetId))
      .returning();

    if (!after) throw new NotFoundError('Preset not found');

    await db.insert(pulsePresetEvents).values({
      presetId: params.presetId,
      workspaceId: after.workspaceId,
      actorUserId: actorUserId,
      eventType: 'deleted',
      before: null,
      after: { deletedAt: after.deletedAt },
    });

    return reply.code(204).send();
  });

  app.post('/presets/:presetId/restore', { preHandler: requireRole('manager') },async (req) => {
    const params = z
      .object({ presetId: z.coerce.number().int().positive() })
      .parse(req.params);
    const body = z
      .object({
        actorUserId: z.number().int().positive(),
        workspaceId: z.number().int().positive(),
      })
      .parse(req.body);

    const owned = await verifyPresetOwnership(params.presetId, body.workspaceId);
    if (!owned) throw new NotFoundError('Preset not found in workspace');


    const [after] = await db
      .update(pulsePresets)
      .set({ deletedAt: null, updatedAt: new Date() })
      .where(eq(pulsePresets.presetId, params.presetId))
      .returning();

    if (!after) throw new NotFoundError('Preset not found');

    await db.insert(pulsePresetEvents).values({
      presetId: params.presetId,
      workspaceId: after.workspaceId,
      actorUserId: body.actorUserId,
      eventType: 'restored',
      before: null,
      after: { deletedAt: null },
    });

    return { preset: after };
  });

  app.post('/presets/reorder', { preHandler: requireRole('manager') },async (req) => {
    const body = bulkReorderBodySchema.parse(req.body);

    await db.transaction(async (tx) => {
      // Verify presets belong to workspace and are not deleted
      const ids = body.items.map((i) => i.presetId);
      const rows = await tx
        .select({ presetId: pulsePresets.presetId })
        .from(pulsePresets)
        .where(and(eq(pulsePresets.workspaceId, body.workspaceId), isNull(pulsePresets.deletedAt)));

      const allowed = new Set(rows.map((r) => r.presetId));
      for (const id of ids) {
        if (!allowed.has(id)) throw new NotFoundError(`Preset ${id} not found in workspace`);
      }

      // Individual updates (each preset gets a different sortOrder)
      const now = new Date();
      await Promise.all(
        body.items.map((item) =>
          tx
            .update(pulsePresets)
            .set({ sortOrder: item.sortOrder, updatedAt: now })
            .where(eq(pulsePresets.presetId, item.presetId)),
        ),
      );

      // Batch insert audit events
      if (body.items.length > 0) {
        await tx.insert(pulsePresetEvents).values(
          body.items.map((item) => ({
            presetId: item.presetId,
            workspaceId: body.workspaceId,
            actorUserId: body.actorUserId,
            eventType: 'reordered' as const,
            before: null,
            after: { sortOrder: item.sortOrder },
          })),
        );
      }
    });

    return { ok: true };
  });

  app.get('/presets/:presetId/events', { preHandler: requireRole('viewer') },async (req) => {
    const params = z
      .object({ presetId: z.coerce.number().int().positive() })
      .parse(req.params);
    const q = z
      .object({ workspaceId: z.coerce.number().int().positive() })
      .parse(req.query);

    const owned = await verifyPresetOwnership(params.presetId, q.workspaceId);
    if (!owned) throw new NotFoundError('Preset not found in workspace');


    const events = await db
      .select()
      .from(pulsePresetEvents)
      .where(eq(pulsePresetEvents.presetId, params.presetId))
      .orderBy(desc(pulsePresetEvents.createdAt));

    return { events };
  });
};
