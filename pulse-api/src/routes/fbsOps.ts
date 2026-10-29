import type { FastifyPluginAsync } from 'fastify';
import { eq, and, gte, lte, desc, asc, or, sql, inArray, isNull, isNotNull, ne, gt, lt, ilike, between, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { fbsSchedules, fbsRuns, fbsDocuments, marketplaceShops } from '../db/schema.js';
import { BadRequestError, NotFoundError } from '../lib/errors.js';
import { requireRole } from '../plugins/roleCheck.js';

function normalizeDays(days?: number[]) {
  if (!days) return null;
  const uniq = Array.from(new Set(days)).filter((d) => Number.isFinite(d) && d >= 1 && d <= 7).sort();
  if (!uniq.length) throw new BadRequestError('daysOfWeek must include at least one day (1..7)');
  return uniq;
}

function validTimeStr(v: string) {
  return /^\d{2}:\d{2}$/.test(v);
}

export const fbsOpsRoutes: FastifyPluginAsync = async (app) => {
  // -----------------------------------------------------------------------
  // List schedules
  // -----------------------------------------------------------------------
  app.get('/fbs/:workspaceId/schedules', { preHandler: requireRole('viewer') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);

    const rows = await db
      .select({
        scheduleId: fbsSchedules.scheduleId,
        workspaceId: fbsSchedules.workspaceId,
        shopId: fbsSchedules.shopId,
        daysOfWeek: fbsSchedules.daysOfWeek,
        sendTime: fbsSchedules.sendTime,
        timezone: fbsSchedules.timezone,
        telegramChatId: fbsSchedules.telegramChatId,
        telegramEnabled: fbsSchedules.telegramEnabled,
        isActive: fbsSchedules.isActive,
        lastRunAt: fbsSchedules.lastRunAt,
        createdAt: fbsSchedules.createdAt,
        updatedAt: fbsSchedules.updatedAt,
        shopName: marketplaceShops.name,
        platform: marketplaceShops.platform,
      })
      .from(fbsSchedules)
      .leftJoin(
        marketplaceShops,
        and(eq(marketplaceShops.shopId, fbsSchedules.shopId), eq(marketplaceShops.workspaceId, params.workspaceId))
      )
      .where(eq(fbsSchedules.workspaceId, params.workspaceId))
      .orderBy(asc(fbsSchedules.createdAt));

    return { ok: true, workspaceId: params.workspaceId, rows };
  });

  // -----------------------------------------------------------------------
  // Create schedule
  // -----------------------------------------------------------------------
  app.post('/fbs/:workspaceId/schedules', { preHandler: requireRole('manager') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z
      .object({
        shopId: z.coerce.number().int().positive().optional(),
        daysOfWeek: z.array(z.coerce.number().int()).optional(),
        sendTime: z.string().optional(),
        timezone: z.string().optional(),
        telegramChatId: z.string().optional(),
        telegramEnabled: z.boolean().optional(),
        isActive: z.boolean().optional(),
      })
      .parse((req as any).body ?? {});

    if (body.sendTime && !validTimeStr(body.sendTime)) {
      throw new BadRequestError('sendTime must be HH:MM');
    }

    if (body.shopId) {
      const [shop] = await db
        .select({ shopId: marketplaceShops.shopId })
        .from(marketplaceShops)
        .where(and(eq(marketplaceShops.shopId, body.shopId), eq(marketplaceShops.workspaceId, params.workspaceId)))
        .limit(1);
      if (!shop) throw new NotFoundError('Shop not found for workspace');
    }

    const days = normalizeDays(body.daysOfWeek) ?? [1, 2, 3, 4, 5, 6, 7];

    const row = await db
      .insert(fbsSchedules)
      .values({
        workspaceId: params.workspaceId,
        shopId: body.shopId ?? null,
        daysOfWeek: days,
        sendTime: body.sendTime ?? '09:00',
        timezone: body.timezone ?? 'Europe/Moscow',
        telegramChatId: body.telegramChatId ? body.telegramChatId.trim() : null,
        telegramEnabled: body.telegramEnabled ?? false,
        isActive: body.isActive ?? true,
        updatedAt: new Date(),
      })
      .returning({
        scheduleId: fbsSchedules.scheduleId,
        shopId: fbsSchedules.shopId,
        daysOfWeek: fbsSchedules.daysOfWeek,
        sendTime: fbsSchedules.sendTime,
        timezone: fbsSchedules.timezone,
        telegramChatId: fbsSchedules.telegramChatId,
        telegramEnabled: fbsSchedules.telegramEnabled,
        isActive: fbsSchedules.isActive,
        createdAt: fbsSchedules.createdAt,
      });

    return { ok: true, schedule: row[0] };
  });

  // -----------------------------------------------------------------------
  // Update schedule
  // -----------------------------------------------------------------------
  app.patch('/fbs/:workspaceId/schedules/:scheduleId', { preHandler: requireRole('manager') },async (req) => {
    const params = z
      .object({
        workspaceId: z.coerce.number().int().positive(),
        scheduleId: z.coerce.number().int().positive(),
      })
      .parse(req.params);

    const body = z
      .object({
        shopId: z.coerce.number().int().positive().optional(),
        daysOfWeek: z.array(z.coerce.number().int()).optional(),
        sendTime: z.string().optional(),
        timezone: z.string().optional(),
        telegramChatId: z.string().optional(),
        telegramEnabled: z.boolean().optional(),
        isActive: z.boolean().optional(),
      })
      .parse((req as any).body ?? {});

    if (body.sendTime && !validTimeStr(body.sendTime)) {
      throw new BadRequestError('sendTime must be HH:MM');
    }

    if (body.shopId) {
      const [shop] = await db
        .select({ shopId: marketplaceShops.shopId })
        .from(marketplaceShops)
        .where(and(eq(marketplaceShops.shopId, body.shopId), eq(marketplaceShops.workspaceId, params.workspaceId)))
        .limit(1);
      if (!shop) throw new NotFoundError('Shop not found for workspace');
    }

    const updates: Record<string, any> = { updatedAt: new Date() };
    if (body.shopId !== undefined) updates.shopId = body.shopId;
    if (body.daysOfWeek !== undefined) updates.daysOfWeek = normalizeDays(body.daysOfWeek);
    if (body.sendTime !== undefined) updates.sendTime = body.sendTime;
    if (body.timezone !== undefined) updates.timezone = body.timezone;
    if (body.telegramChatId !== undefined) updates.telegramChatId = body.telegramChatId ? body.telegramChatId.trim() : null;
    if (body.telegramEnabled !== undefined) updates.telegramEnabled = body.telegramEnabled;
    if (body.isActive !== undefined) updates.isActive = body.isActive;

    const row = await db
      .update(fbsSchedules)
      .set(updates)
      .where(and(eq(fbsSchedules.scheduleId, params.scheduleId), eq(fbsSchedules.workspaceId, params.workspaceId)))
      .returning({
        scheduleId: fbsSchedules.scheduleId,
        shopId: fbsSchedules.shopId,
        daysOfWeek: fbsSchedules.daysOfWeek,
        sendTime: fbsSchedules.sendTime,
        timezone: fbsSchedules.timezone,
        telegramChatId: fbsSchedules.telegramChatId,
        telegramEnabled: fbsSchedules.telegramEnabled,
        isActive: fbsSchedules.isActive,
        updatedAt: fbsSchedules.updatedAt,
      });

    if (!row.length) throw new NotFoundError('Schedule not found');
    return { ok: true, schedule: row[0] };
  });

  // -----------------------------------------------------------------------
  // Delete schedule
  // -----------------------------------------------------------------------
  app.delete('/fbs/:workspaceId/schedules/:scheduleId', { preHandler: requireRole('owner') },async (req) => {
    const params = z
      .object({
        workspaceId: z.coerce.number().int().positive(),
        scheduleId: z.coerce.number().int().positive(),
      })
      .parse(req.params);

    const row = await db
      .delete(fbsSchedules)
      .where(and(eq(fbsSchedules.scheduleId, params.scheduleId), eq(fbsSchedules.workspaceId, params.workspaceId)))
      .returning({ scheduleId: fbsSchedules.scheduleId });

    if (!row.length) throw new NotFoundError('Schedule not found');
    return { ok: true, deleted: row[0].scheduleId };
  });

  // -----------------------------------------------------------------------
  // Manual run (enqueue)
  // -----------------------------------------------------------------------
  app.post('/fbs/:workspaceId/run', { preHandler: requireRole('manager') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z
      .object({
        shopId: z.coerce.number().int().positive().optional(),
        scheduleId: z.coerce.number().int().positive().optional(),
        telegramChatId: z.string().optional(),
      })
      .parse((req as any).body ?? {});

    let shopId = body.shopId ?? null;

    if (body.scheduleId) {
      const [sched] = await db
        .select({ shopId: fbsSchedules.shopId })
        .from(fbsSchedules)
        .where(and(eq(fbsSchedules.scheduleId, body.scheduleId), eq(fbsSchedules.workspaceId, params.workspaceId)))
        .limit(1);
      if (!sched) throw new NotFoundError('Schedule not found');
      if (!shopId && sched.shopId) shopId = sched.shopId as any;
    }

    if (shopId) {
      const [shop] = await db
        .select({ shopId: marketplaceShops.shopId })
        .from(marketplaceShops)
        .where(and(eq(marketplaceShops.shopId, shopId), eq(marketplaceShops.workspaceId, params.workspaceId)))
        .limit(1);
      if (!shop) throw new NotFoundError('Shop not found for workspace');
    }

    const { randomUUID } = await import('node:crypto');
    const runId = randomUUID();

    await db.insert(fbsRuns).values({
      runId,
      workspaceId: params.workspaceId,
      scheduleId: body.scheduleId ?? null,
      shopId,
      status: 'queued',
      telegramChatId: body.telegramChatId ? body.telegramChatId.trim() : null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    try {
      const { getQueue, JOB_FBS_RUN } = await import('../jobs/queue.js');
      const boss = await getQueue();
      await boss.send(JOB_FBS_RUN, { runId, workspaceId: params.workspaceId, shopId }, {
        retryLimit: 1,
        expireInSeconds: 3600,
      });
    } catch (e: any) {
      await db
        .update(fbsRuns)
        .set({ status: 'failed', errorText: String(e?.message ?? e), updatedAt: new Date(), finishedAt: new Date() })
        .where(eq(fbsRuns.runId, runId));
      throw new BadRequestError('Failed to enqueue FBS run');
    }

    return { ok: true, runId };
  });

  // -----------------------------------------------------------------------
  // Runs list
  // -----------------------------------------------------------------------
  app.get('/fbs/:workspaceId/runs', { preHandler: requireRole('viewer') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z
      .object({
        status: z.string().optional(),
        scheduleId: z.coerce.number().int().optional(),
      })
      .parse(req.query);


    const where = [eq(fbsRuns.workspaceId, params.workspaceId)];
    if (query.status) where.push(eq(fbsRuns.status, query.status));
    if (query.scheduleId) where.push(eq(fbsRuns.scheduleId, query.scheduleId));

    const rows = await db
      .select({
        runId: fbsRuns.runId,
        scheduleId: fbsRuns.scheduleId,
        shopId: fbsRuns.shopId,
        status: fbsRuns.status,
        errorText: fbsRuns.errorText,
        startedAt: fbsRuns.startedAt,
        finishedAt: fbsRuns.finishedAt,
        createdAt: fbsRuns.createdAt,
        updatedAt: fbsRuns.updatedAt,
      })
      .from(fbsRuns)
      .where(and(...where))
      .orderBy(desc(fbsRuns.createdAt))
      .limit(200);

    return { ok: true, workspaceId: params.workspaceId, rows };
  });

  // -----------------------------------------------------------------------
  // Run details (workspace-scoped)
  // -----------------------------------------------------------------------
  app.get('/fbs/:workspaceId/runs/:runId', { preHandler: requireRole('viewer') },async (req) => {
    const params = z
      .object({
        workspaceId: z.coerce.number().int().positive(),
        runId: z.string().min(4),
      })
      .parse(req.params);


    const [row] = await db
      .select()
      .from(fbsRuns)
      .where(and(eq(fbsRuns.runId, params.runId), eq(fbsRuns.workspaceId, params.workspaceId)))
      .limit(1);

    if (!row) throw new NotFoundError('Run not found');
    return { ok: true, run: row };
  });

  // -----------------------------------------------------------------------
  // Run documents (workspace-scoped)
  // -----------------------------------------------------------------------
  app.get('/fbs/:workspaceId/runs/:runId/documents', { preHandler: requireRole('viewer') },async (req) => {
    const params = z
      .object({
        workspaceId: z.coerce.number().int().positive(),
        runId: z.string().min(4),
      })
      .parse(req.params);


    const rows = await db
      .select({
        docId: fbsDocuments.docId,
        runId: fbsDocuments.runId,
        filePath: fbsDocuments.filePath,
        fileName: fbsDocuments.fileName,
        mime: fbsDocuments.mime,
        sizeBytes: fbsDocuments.sizeBytes,
        createdAt: fbsDocuments.createdAt,
      })
      .from(fbsDocuments)
      .leftJoin(fbsRuns, eq(fbsRuns.runId, fbsDocuments.runId))
      .where(and(eq(fbsDocuments.runId, params.runId), eq(fbsRuns.workspaceId, params.workspaceId)))
      .orderBy(fbsDocuments.createdAt);

    const rowsWithUrl = rows.map((r) => ({
      ...r,
      downloadUrl: `/fbs/${params.workspaceId}/runs/${params.runId}/documents/${r.docId}/download`,
    }));

    return { ok: true, runId: params.runId, rows: rowsWithUrl };
  });

  // -----------------------------------------------------------------------
  // Document download (workspace-scoped)
  // -----------------------------------------------------------------------
  app.get('/fbs/:workspaceId/runs/:runId/documents/:docId/download', { preHandler: requireRole('viewer') },async (req, reply) => {
    const params = z
      .object({
        workspaceId: z.coerce.number().int().positive(),
        runId: z.string().min(4),
        docId: z.coerce.number().int().positive(),
      })
      .parse(req.params);


    const [row] = await db
      .select({
        filePath: fbsDocuments.filePath,
        fileName: fbsDocuments.fileName,
        mime: fbsDocuments.mime,
      })
      .from(fbsDocuments)
      .leftJoin(fbsRuns, eq(fbsRuns.runId, fbsDocuments.runId))
      .where(and(
        eq(fbsDocuments.docId, params.docId),
        eq(fbsDocuments.runId, params.runId),
        eq(fbsRuns.workspaceId, params.workspaceId)
      ))
      .limit(1);

    if (!row) throw new NotFoundError('Document not found');

    const path = await import('node:path');
    const fs = await import('node:fs');

    const baseDir = path.resolve('out', 'fbs');
    const abs = path.resolve(row.filePath);

    if (!abs.startsWith(baseDir)) {
      throw new NotFoundError('Document not found');
    }

    if (!fs.existsSync(abs)) {
      throw new NotFoundError('Document not found');
    }

    const safeName = (row.fileName || 'document.pdf').replace(/[^a-zA-Z0-9._\-()\s]/g, '_');

    reply.header('Content-Type', row.mime || 'application/pdf');
    reply.header('Content-Disposition', `attachment; filename="${safeName}"`);

    return reply.send(fs.createReadStream(abs));
  });

  // -----------------------------------------------------------------------
  // Run details (legacy path — pre-workspace-scoped routing)
  // -----------------------------------------------------------------------
  // H10 fix: previously this endpoint queried fbsRuns by runId alone, allowing
  // any authenticated user to read FBS runs from foreign workspaces by
  // guessing the runId. The workspace plugin does not fire because no
  // shopId/workspaceId is present in params/query/body.
  // We now require a workspaceId from the request context (set by the workspace
  // plugin when the user has a current workspace selected) and constrain the
  // query to it. If a client really needs the workspaceId-less lookup, they
  // must use the /fbs/:workspaceId/runs/:runId route.
  app.get('/fbs/runs/:runId', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({ runId: z.string().min(4) }).parse(req.params);
    const wsId = (req as { workspaceId?: number }).workspaceId;
    if (!wsId) throw new NotFoundError('Run not found'); // intentional 404 — don't leak whether the run exists

    const [row] = await db
      .select()
      .from(fbsRuns)
      .where(and(eq(fbsRuns.runId, params.runId), eq(fbsRuns.workspaceId, wsId)))
      .limit(1);

    if (!row) throw new NotFoundError('Run not found');
    return { ok: true, run: row };
  });

  // -----------------------------------------------------------------------
  // Run documents (legacy path — same H10 fix as above)
  // -----------------------------------------------------------------------
  app.get('/fbs/runs/:runId/documents', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({ runId: z.string().min(4) }).parse(req.params);
    const wsId = (req as { workspaceId?: number }).workspaceId;
    if (!wsId) throw new NotFoundError('Run not found');

    // Two-step: first verify the run is in this workspace (cheap), then list
    // its documents. Doing this avoids leaking documents whose run lives in
    // another workspace.
    const [runRow] = await db
      .select({ runId: fbsRuns.runId })
      .from(fbsRuns)
      .where(and(eq(fbsRuns.runId, params.runId), eq(fbsRuns.workspaceId, wsId)))
      .limit(1);
    if (!runRow) throw new NotFoundError('Run not found');

    const rows = await db
      .select({
        docId: fbsDocuments.docId,
        runId: fbsDocuments.runId,
        filePath: fbsDocuments.filePath,
        fileName: fbsDocuments.fileName,
        mime: fbsDocuments.mime,
        sizeBytes: fbsDocuments.sizeBytes,
        createdAt: fbsDocuments.createdAt,
      })
      .from(fbsDocuments)
      .where(eq(fbsDocuments.runId, params.runId))
      .orderBy(fbsDocuments.createdAt);

    return { ok: true, runId: params.runId, rows };
  });
};
