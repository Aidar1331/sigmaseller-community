import type { FastifyPluginAsync } from 'fastify';
import { eq, and, gte, lte, desc, asc, or, sql, inArray, isNull, isNotNull, ne, gt, lt, ilike, between, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { wbEventComments, wbEvents, users, notificationSettings } from '../db/schema.js';
import { NotFoundError } from '../lib/errors.js';
import { requireRole } from '../plugins/roleCheck.js';
import { buildShopFilter } from './pulse/helpers.js';

const EventType = z.enum(['alert', 'log', 'task', 'reminder', 'note']);
const Severity = z.enum(['info', 'warn', 'critical']);
const Status = z.enum(['open', 'ack', 'resolved', 'done']);
const Priority = z.enum(['low', 'medium', 'high', 'urgent']);

const RecurrenceSchema = z.object({
  type: z.enum(['daily', 'weekly', 'monthly']),
  interval: z.number().int().min(1).max(365).default(1),
  endDate: z.string().optional(),
}).optional();

/**
 * Expand recurring events into virtual instances within a date range.
 * Original event is kept, virtual instances get isVirtual=true and parentEventId.
 */
function expandRecurringEvents(
  events: any[],
  rangeStart: string,
  rangeEnd: string
): any[] {
  const result: any[] = [];
  const startDate = new Date(rangeStart + 'T00:00:00Z');
  const endDate = new Date(rangeEnd + 'T23:59:59Z');

  for (const event of events) {
    // Add original event
    result.push(event);

    // Check if event has recurrence
    const recurrence = event.recurrence as { type: string; interval: number; endDate?: string } | null;
    if (!recurrence || !recurrence.type) continue;

    const eventDate = new Date(event.date + 'T00:00:00Z');
    const recurrenceEnd = recurrence.endDate ? new Date(recurrence.endDate + 'T23:59:59Z') : endDate;
    const interval = recurrence.interval || 1;

    let currentDate = new Date(eventDate);

    // Generate virtual instances
    let iterations = 0;
    const maxIterations = 365; // Safety limit

    while (iterations++ < maxIterations) {
      // Move to next occurrence
      switch (recurrence.type) {
        case 'daily':
          currentDate.setUTCDate(currentDate.getUTCDate() + interval);
          break;
        case 'weekly':
          currentDate.setUTCDate(currentDate.getUTCDate() + interval * 7);
          break;
        case 'monthly':
          currentDate.setUTCMonth(currentDate.getUTCMonth() + interval);
          break;
        default:
          iterations = maxIterations; // Unknown type, stop
          continue;
      }

      // Check bounds
      if (currentDate > endDate || currentDate > recurrenceEnd) break;
      if (currentDate < startDate) continue;

      // Create virtual instance
      const virtualDate = currentDate.toISOString().slice(0, 10);
      result.push({
        ...event,
        eventId: `${event.eventId}-virtual-${virtualDate}`,
        date: virtualDate,
        isVirtual: true,
        parentEventId: event.eventId,
      });
    }
  }

  return result;
}

export const eventsRoutes: FastifyPluginAsync = async (app) => {
  // ─────────────────────────────────────────────
  // List events (for date/nmId cell tooltip and timeline)
  // ─────────────────────────────────────────────
  app.get('/events/:workspaceId', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z
      .object({
        start: z.string().optional(),
        end: z.string().optional(),
        nmId: z.coerce.number().int().nonnegative().optional(),
        date: z.string().optional(),
        types: z.string().optional(),
        category: z.string().optional(),
        status: z.string().optional(),
        priority: z.string().optional(),
        assigneeId: z.coerce.number().int().optional(),
        source: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(5000).optional(),
        shopId: z.coerce.number().int().positive().optional(),
      })
      .parse(req.query);
    
    const shopId = query.shopId;

    const types = (query.types ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const statuses = (query.status ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const conds: any[] = [eq(wbEvents.workspaceId, params.workspaceId)];
    const shopFilter = buildShopFilter(wbEvents.shopId, shopId);
    if (shopFilter) conds.push(shopFilter);
    if (query.date) conds.push(eq(wbEvents.date, query.date));
    if (query.start) conds.push(gte(wbEvents.date, query.start));
    if (query.end) conds.push(lte(wbEvents.date, query.end));
    if (query.nmId) conds.push(eq(wbEvents.nmId, query.nmId as any));
    if (query.category) conds.push(eq(wbEvents.category, query.category));
    if (types.length) conds.push(inArray(wbEvents.type, types as any));
    if (statuses.length) conds.push(inArray(wbEvents.status, statuses as any));
    if (query.priority) conds.push(eq(wbEvents.priority, query.priority));
    if (query.assigneeId) conds.push(eq(wbEvents.assigneeId, query.assigneeId as any));
    if (query.source) conds.push(eq(wbEvents.source, query.source));

    const rows = await db
      .select()
      .from(wbEvents)
      .where(and(...conds))
      .orderBy(desc(wbEvents.date), asc(wbEvents.time), desc(wbEvents.createdAt))
      .limit(query.limit ?? 2000);

    // Expand recurring events into virtual instances within the date range
    const expandedRows = (query.start && query.end)
      ? expandRecurringEvents(rows, query.start, query.end)
      : rows;

    return { workspaceId: params.workspaceId, rows: expandedRows };
  });

  // ─────────────────────────────────────────────
  // Quick counts for date columns
  // ─────────────────────────────────────────────
  app.get('/events/:workspaceId/counts', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z
      .object({
        start: z.string(),
        end: z.string(),
        nmId: z.coerce.number().int().nonnegative().optional(),
        category: z.string().optional(),
        shopId: z.coerce.number().int().positive().optional(),
      })
      .parse(req.query);
    
    const shopId = query.shopId;

    const baseConditions = [
      eq(wbEvents.workspaceId, params.workspaceId),
      buildShopFilter(wbEvents.shopId, shopId),
      gte(wbEvents.date, query.start),
      lte(wbEvents.date, query.end),
    ].filter((c): c is NonNullable<typeof c> => c !== undefined);
    
    if (query.nmId) baseConditions.push(eq(wbEvents.nmId, query.nmId as any));

    const baseWhere = and(...baseConditions);

    const where = query.category ? and(baseWhere, eq(wbEvents.category, query.category)) : baseWhere;

    const rows = await db
      .select({
        date: wbEvents.date,
        alerts: sql<number>`sum(case when ${wbEvents.type} = 'alert' then 1 else 0 end)`.mapWith(Number),
        logs: sql<number>`sum(case when ${wbEvents.type} = 'log' then 1 else 0 end)`.mapWith(Number),
        tasks: sql<number>`sum(case when ${wbEvents.type} = 'task' then 1 else 0 end)`.mapWith(Number),
        reminders: sql<number>`sum(case when ${wbEvents.type} = 'reminder' then 1 else 0 end)`.mapWith(Number),
      })
      .from(wbEvents)
      .where(where)
      .groupBy(wbEvents.date);

    const byDate: Record<string, { alerts: number; logs: number; tasks: number; reminders: number }> = {};
    for (const r of rows as any[]) {
      byDate[String(r.date)] = { alerts: r.alerts ?? 0, logs: r.logs ?? 0, tasks: r.tasks ?? 0, reminders: r.reminders ?? 0 };
    }

    return { workspaceId: params.workspaceId, start: query.start, end: query.end, byDate };
  });

  // ─────────────────────────────────────────────
  // Tasks overview (kanban-style)
  // ─────────────────────────────────────────────
  app.get('/events/:workspaceId/tasks', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z
      .object({
        assigneeId: z.coerce.number().int().optional(),
        priority: Priority.optional(),
        includeDone: z.enum(['0', '1']).optional(),
        shopId: z.coerce.number().int().positive().optional(),
      })
      .parse(req.query);

    const conds: any[] = [
      eq(wbEvents.workspaceId, params.workspaceId),
      eq(wbEvents.type, 'task'),
    ];

    const shopFilter = buildShopFilter(wbEvents.shopId, query.shopId);
    if (shopFilter) conds.push(shopFilter);

    if (query.assigneeId) conds.push(eq(wbEvents.assigneeId, query.assigneeId as any));
    if (query.priority) conds.push(eq(wbEvents.priority, query.priority));
    if (query.includeDone !== '1') {
      conds.push(ne(wbEvents.status, 'done'));
    }

    const rows = await db
      .select()
      .from(wbEvents)
      .where(and(...conds))
      .orderBy(
        sql`CASE ${wbEvents.priority} WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`,
        asc(wbEvents.dueAt),
        desc(wbEvents.createdAt)
      )
      .limit(500);

    // Group by status for kanban
    const byStatus = {
      open: rows.filter((r) => r.status === 'open'),
      ack: rows.filter((r) => r.status === 'ack'),
      done: rows.filter((r) => r.status === 'done' || r.status === 'resolved'),
    };

    return { workspaceId: params.workspaceId, tasks: rows, byStatus };
  });

  // ─────────────────────────────────────────────
  // Upcoming reminders
  // ─────────────────────────────────────────────
  app.get('/events/:workspaceId/reminders', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z
      .object({
        hours: z.coerce.number().int().min(1).max(168).optional(), // next N hours
      })
      .parse(req.query);

    const hoursAhead = query.hours ?? 24;
    const now = new Date();
    const cutoff = new Date(now.getTime() + hoursAhead * 60 * 60 * 1000);

    const rows = await db
      .select()
      .from(wbEvents)
      .where(
        and(
          eq(wbEvents.workspaceId, params.workspaceId),
          isNotNull(wbEvents.reminderAt),
          gte(wbEvents.reminderAt, now),
          lte(wbEvents.reminderAt, cutoff),
          eq(wbEvents.reminderSent, false)
        )
      )
      .orderBy(asc(wbEvents.reminderAt))
      .limit(100);

    return { workspaceId: params.workspaceId, reminders: rows };
  });

  // ─────────────────────────────────────────────
  // Create event (enhanced)
  // ─────────────────────────────────────────────
  app.post('/events/:workspaceId', { preHandler: requireRole('manager') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z
      .object({
        // shopId: задача привязывается к конкретному магазину если он выбран в UI.
        // Без этого GET /events/tasks?shopId=N фильтрует и не показывает новую
        // задачу (shop_id=NULL ≠ shop_id=4) → юзер думает «не сохранилось».
        shopId: z.coerce.number().int().positive().optional(),
        nmId: z.coerce.number().int().nonnegative().optional(),
        date: z.string().min(1, 'Дата обязательна').regex(/^\d{4}-\d{2}-\d{2}$/, 'Формат даты: YYYY-MM-DD'),
        time: z.string().optional(),
        type: EventType,
        category: z.string().optional(),
        severity: Severity.optional(),
        priority: Priority.optional(),
        title: z.string().min(1, 'Заголовок обязателен').max(140, 'Максимум 140 символов'),
        description: z.string().max(10_000).optional(),
        tags: z.array(z.string()).optional(),
        dueAt: z.string().optional(),
        reminderAt: z.string().optional(),
        assigneeId: z.coerce.number().int().optional(),
        parentEventId: z.coerce.number().int().optional(),
        recurrence: RecurrenceSchema,
        linkedCampaignId: z.coerce.number().int().optional(),
        linkedSupplyId: z.string().optional(),
      })
      .parse((req as any).body ?? {});

    // Также пробуем взять shopId из query (UI пересылает его автоматически в query
    // через workspaceId-роутер). В body может прийти undefined.
    const shopIdQuery = Number((req.query as any)?.shopId);
    const shopId = body.shopId ?? (Number.isFinite(shopIdQuery) && shopIdQuery > 0 ? shopIdQuery : null);

    const row = await db
      .insert(wbEvents)
      .values({
        workspaceId: params.workspaceId,
        shopId,
        nmId: (body.nmId && body.nmId > 0 ? body.nmId : null) as any,
        date: body.date,
        time: body.time ?? null,
        type: body.type,
        category: body.category ?? null,
        severity: body.severity ?? null,
        priority: body.priority ?? 'medium',
        status: 'open',
        title: body.title,
        description: body.description ?? null,
        tags: body.tags ?? [],
        dueAt: body.dueAt ? new Date(body.dueAt) : null,
        reminderAt: body.reminderAt ? new Date(body.reminderAt) : null,
        reminderSent: false,
        assigneeId: body.assigneeId ?? null,
        parentEventId: body.parentEventId ?? null,
        recurrence: body.recurrence ?? null,
        source: 'manual',
        linkedCampaignId: body.linkedCampaignId ?? null,
        linkedSupplyId: body.linkedSupplyId ?? null,
        updatedAt: new Date(),
      } as any)
      .returning();

    return { ok: true, event: row[0] };
  });

  // ─────────────────────────────────────────────
  // Create task (shorthand)
  // ─────────────────────────────────────────────
  app.post('/events/:workspaceId/tasks', { preHandler: requireRole('manager') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z
      .object({
        title: z.string().min(1).max(140),
        description: z.string().max(10_000).optional(),
        priority: Priority.optional(),
        dueAt: z.string().optional(),
        reminderAt: z.string().optional(),
        assigneeId: z.coerce.number().int().optional(),
        nmId: z.coerce.number().int().optional(),
        tags: z.array(z.string()).optional(),
        recurrence: RecurrenceSchema,
      })
      .parse((req as any).body ?? {});

    const today = new Date().toISOString().slice(0, 10);

    const row = await db
      .insert(wbEvents)
      .values({
        workspaceId: params.workspaceId,
        nmId: body.nmId ?? null,
        date: today,
        type: 'task',
        priority: body.priority ?? 'medium',
        status: 'open',
        title: body.title,
        description: body.description ?? null,
        tags: body.tags ?? [],
        dueAt: body.dueAt ? new Date(body.dueAt) : null,
        reminderAt: body.reminderAt ? new Date(body.reminderAt) : null,
        reminderSent: false,
        assigneeId: body.assigneeId ?? null,
        recurrence: body.recurrence ?? null,
        source: 'manual',
        updatedAt: new Date(),
      } as any)
      .returning();

    return { ok: true, task: row[0] };
  });

  // ─────────────────────────────────────────────
  // Create subtask
  // ─────────────────────────────────────────────
  app.post('/events/:workspaceId/:eventId/subtasks', { preHandler: requireRole('manager') }, async (req) => {
    const params = z
      .object({
        workspaceId: z.coerce.number().int().positive(),
        eventId: z.coerce.number().int().positive(),
      })
      .parse(req.params);

    const body = z
      .object({
        title: z.string().min(1).max(140),
        description: z.string().max(10_000).optional(),
        dueAt: z.string().optional(),
        assigneeId: z.coerce.number().int().optional(),
      })
      .parse((req as any).body ?? {});

    // Verify parent exists
    const [parent] = await db
      .select({ eventId: wbEvents.eventId, date: wbEvents.date })
      .from(wbEvents)
      .where(and(eq(wbEvents.eventId, params.eventId), eq(wbEvents.workspaceId, params.workspaceId)))
      .limit(1);

    if (!parent) throw new NotFoundError('Parent event not found');

    const row = await db
      .insert(wbEvents)
      .values({
        workspaceId: params.workspaceId,
        date: parent.date,
        type: 'task',
        priority: 'medium',
        status: 'open',
        title: body.title,
        description: body.description ?? null,
        dueAt: body.dueAt ? new Date(body.dueAt) : null,
        assigneeId: body.assigneeId ?? null,
        parentEventId: params.eventId,
        source: 'manual',
        updatedAt: new Date(),
      } as any)
      .returning();

    return { ok: true, subtask: row[0] };
  });

  // ─────────────────────────────────────────────
  // Get subtasks for an event
  // ─────────────────────────────────────────────
  app.get('/events/:workspaceId/:eventId/subtasks', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z
      .object({
        workspaceId: z.coerce.number().int().positive(),
        eventId: z.coerce.number().int().positive(),
      })
      .parse(req.params);

    const rows = await db
      .select()
      .from(wbEvents)
      .where(
        and(
          eq(wbEvents.workspaceId, params.workspaceId),
          eq(wbEvents.parentEventId, params.eventId)
        )
      )
      .orderBy(asc(wbEvents.createdAt))
      .limit(100);

    const done = rows.filter((r) => r.status === 'done' || r.status === 'resolved').length;

    return {
      ok: true,
      subtasks: rows,
      progress: { total: rows.length, done },
    };
  });

  // ─────────────────────────────────────────────
  // Update event (enhanced)
  // ─────────────────────────────────────────────
  app.patch('/events/:workspaceId/:eventId', { preHandler: requireRole('manager') }, async (req) => {
    const params = z
      .object({
        workspaceId: z.coerce.number().int().positive(),
        eventId: z.coerce.number().int().positive(),
      })
      .parse(req.params);

    const body = z
      .object({
        date: z.string().optional(),
        time: z.string().optional().nullable(),
        category: z.string().optional().nullable(),
        severity: Severity.optional().nullable(),
        priority: Priority.optional().nullable(),
        title: z.string().min(1).max(140).optional(),
        description: z.string().max(10_000).optional().nullable(),
        tags: z.array(z.string()).optional(),
        dueAt: z.string().optional().nullable(),
        reminderAt: z.string().optional().nullable(),
        assigneeId: z.coerce.number().int().optional().nullable(),
        recurrence: RecurrenceSchema.nullable(),
      })
      .parse((req as any).body ?? {});

    const updates: any = { updatedAt: new Date() };

    if (body.date !== undefined) updates.date = body.date;
    if (body.time !== undefined) updates.time = body.time ?? null;
    if (body.category !== undefined) updates.category = body.category ?? null;
    if (body.severity !== undefined) updates.severity = body.severity ?? null;
    if (body.priority !== undefined) updates.priority = body.priority ?? 'medium';
    if (body.title !== undefined) updates.title = body.title;
    if (body.description !== undefined) updates.description = body.description ?? null;
    if (body.tags !== undefined) updates.tags = body.tags;
    if (body.dueAt !== undefined) updates.dueAt = body.dueAt ? new Date(body.dueAt) : null;
    if (body.reminderAt !== undefined) {
      updates.reminderAt = body.reminderAt ? new Date(body.reminderAt) : null;
      updates.reminderSent = false; // reset reminder
    }
    if (body.assigneeId !== undefined) updates.assigneeId = body.assigneeId ?? null;
    if (body.recurrence !== undefined) updates.recurrence = body.recurrence ?? null;

    await db
      .update(wbEvents)
      .set(updates)
      .where(and(eq(wbEvents.workspaceId, params.workspaceId), eq(wbEvents.eventId, params.eventId)));

    return { ok: true };
  });

  // ─────────────────────────────────────────────
  // Update event status
  // ─────────────────────────────────────────────
  app.post('/events/:workspaceId/:eventId/status', { preHandler: requireRole('manager') }, async (req) => {
    const params = z
      .object({
        workspaceId: z.coerce.number().int().positive(),
        eventId: z.coerce.number().int().positive(),
      })
      .parse(req.params);

    const body = z.object({ status: Status }).parse((req as any).body ?? {});

    const updates: any = {
      status: body.status,
      updatedAt: new Date(),
    };

    if (body.status === 'resolved' || body.status === 'done') {
      updates.resolvedAt = new Date();
      updates.completedAt = new Date();
    }

    await db
      .update(wbEvents)
      .set(updates)
      .where(and(eq(wbEvents.workspaceId, params.workspaceId), eq(wbEvents.eventId, params.eventId)));

    return { ok: true };
  });

  // ─────────────────────────────────────────────
  // Delete event
  // ─────────────────────────────────────────────
  app.delete('/events/:workspaceId/:eventId', { preHandler: requireRole('owner') }, async (req) => {
    const params = z
      .object({
        workspaceId: z.coerce.number().int().positive(),
        eventId: z.coerce.number().int().positive(),
      })
      .parse(req.params);

    await db.delete(wbEvents).where(and(eq(wbEvents.workspaceId, params.workspaceId), eq(wbEvents.eventId, params.eventId)));
    return { ok: true };
  });

  // ─────────────────────────────────────────────
  // Comments
  // ─────────────────────────────────────────────
  app.get('/events/:workspaceId/:eventId/comments', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z
      .object({
        workspaceId: z.coerce.number().int().positive(),
        eventId: z.coerce.number().int().positive(),
      })
      .parse(req.params);

    const rows = await db
      .select({
        commentId: wbEventComments.commentId,
        eventId: wbEventComments.eventId,
        body: wbEventComments.body,
        createdAt: wbEventComments.createdAt,
      })
      .from(wbEventComments)
      .innerJoin(wbEvents, eq(wbEvents.eventId, wbEventComments.eventId))
      .where(and(eq(wbEvents.workspaceId, params.workspaceId), eq(wbEventComments.eventId, params.eventId)))
      .orderBy(asc(wbEventComments.createdAt))
      .limit(500);

    return { ok: true, workspaceId: params.workspaceId, eventId: params.eventId, rows };
  });

  app.post('/events/:workspaceId/:eventId/comments', { preHandler: requireRole('manager') }, async (req) => {
    const params = z
      .object({
        workspaceId: z.coerce.number().int().positive(),
        eventId: z.coerce.number().int().positive(),
      })
      .parse(req.params);

    const body = z.object({ body: z.string().min(1).max(10_000) }).parse((req as any).body ?? {});

    const [evt] = await db
      .select({ eventId: wbEvents.eventId })
      .from(wbEvents)
      .where(and(eq(wbEvents.eventId, params.eventId), eq(wbEvents.workspaceId, params.workspaceId)))
      .limit(1);

    if (!evt) throw new NotFoundError('Event not found in this workspace');

    const row = await db
      .insert(wbEventComments)
      .values({ eventId: params.eventId, body: body.body })
      .returning();

    return { ok: true, comment: row[0] };
  });

  // ─────────────────────────────────────────────
  // Notification settings (per user)
  // ─────────────────────────────────────────────
  app.get('/events/:workspaceId/notifications/settings', { preHandler: requireRole('viewer') }, async (req, reply) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const userId = (req as any).user?.userId;

    if (!userId) {
      return reply.code(401).send({ ok: false, error: 'Not authenticated' });
    }

    const [settings] = await db
      .select()
      .from(notificationSettings)
      .where(and(eq(notificationSettings.workspaceId, params.workspaceId), eq(notificationSettings.userId, userId)))
      .limit(1);

    return { ok: true, settings: settings ?? null };
  });

  app.put('/events/:workspaceId/notifications/settings', { preHandler: requireRole('viewer') }, async (req, reply) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const userId = (req as any).user?.userId;

    if (!userId) {
      return reply.code(401).send({ ok: false, error: 'Not authenticated' });
    }

    const body = z
      .object({
        telegramChatId: z.string().optional(),
        telegramEnabled: z.boolean().optional(),
        notifyTasks: z.boolean().optional(),
        notifyAlerts: z.boolean().optional(),
        notifyReminders: z.boolean().optional(),
        notifyFeedback: z.boolean().optional(),
        notifyBeforeMinutes: z.coerce.number().int().optional(),
        quietHoursStart: z.string().optional(),
        quietHoursEnd: z.string().optional(),
        timezone: z.string().optional(),
      })
      .parse((req as any).body ?? {});

    await db
      .insert(notificationSettings)
      .values({
        workspaceId: params.workspaceId,
        userId,
        ...body,
        updatedAt: new Date(),
      } as any)
      .onConflictDoUpdate({
        target: [notificationSettings.workspaceId, notificationSettings.userId],
        set: {
          ...body,
          updatedAt: new Date(),
        } as any,
      });

    return { ok: true };
  });

  // ─────────────────────────────────────────────
  // System: create event from other modules
  // ─────────────────────────────────────────────
  app.post('/events/:workspaceId/system', { preHandler: requireRole('manager') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z
      .object({
        source: z.enum(['bidder', 'seo', 'supplies', 'feedback', 'system']),
        sourceId: z.string().optional(),
        type: EventType,
        severity: Severity.optional(),
        title: z.string().min(1).max(140),
        description: z.string().max(10_000).optional(),
        nmId: z.coerce.number().int().optional(),
        evidence: z.any().optional(),
        fingerprint: z.string().optional(),
        linkedCampaignId: z.coerce.number().int().optional(),
        linkedSupplyId: z.string().optional(),
      })
      .parse((req as any).body ?? {});

    const today = new Date().toISOString().slice(0, 10);
    const time = new Date().toISOString().slice(11, 16);

    // Check for duplicate by fingerprint
    if (body.fingerprint) {
      const [existing] = await db
        .select({ eventId: wbEvents.eventId })
        .from(wbEvents)
        .where(
          and(
            eq(wbEvents.workspaceId, params.workspaceId),
            eq(wbEvents.fingerprint, body.fingerprint)
          )
        )
        .limit(1);

      if (existing) {
        return { ok: true, duplicate: true, eventId: existing.eventId };
      }
    }

    const row = await db
      .insert(wbEvents)
      .values({
        workspaceId: params.workspaceId,
        nmId: body.nmId ?? null,
        date: today,
        time,
        type: body.type,
        severity: body.severity ?? null,
        status: 'open',
        title: body.title,
        description: body.description ?? null,
        evidence: body.evidence ?? {},
        fingerprint: body.fingerprint ?? null,
        source: body.source,
        sourceId: body.sourceId ?? null,
        linkedCampaignId: body.linkedCampaignId ?? null,
        linkedSupplyId: body.linkedSupplyId ?? null,
        updatedAt: new Date(),
      } as any)
      .returning();

    return { ok: true, event: row[0] };
  });
};
