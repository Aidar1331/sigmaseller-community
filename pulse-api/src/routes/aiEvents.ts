/**
 * AI Agent Events API.
 *
 * GET  /ai/events            — List events for workspace
 * GET  /ai/events/:id        — Get single event
 * PATCH /ai/events/:id/apply — Apply suggested action
 * PATCH /ai/events/:id/dismiss — Dismiss event
 * PATCH /ai/events/:id/snooze — Snooze event
 * GET  /ai/events/stats      — Event counts by status/type
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { agentEvents, agentConversations, agentMessages } from '../db/schema.js';
import { eq, and, desc, sql, gte, lte, inArray } from 'drizzle-orm';
import { requireRole } from '../plugins/roleCheck.js';

export const aiEventsRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /ai/events — List events.
   */
  app.get('/ai/events', { preHandler: requireRole('viewer') }, async (req) => {
    const query = z.object({
      workspaceId: z.coerce.number().int().positive(),
      // Per-shop scoping. Omitted = include workspace-level events (shop_id IS NULL)
      // plus any shop. Workspace plugin already verifies that shopId belongs to workspace.
      shopId: z.coerce.number().int().positive().optional(),
      status: z.enum(['pending', 'applied', 'dismissed', 'snoozed', 'expired', 'all']).optional(),
      eventType: z.string().optional(),
      severity: z.enum(['info', 'warning', 'critical', 'all']).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query);

    const conditions = [eq(agentEvents.workspaceId, query.workspaceId)];
    if (query.shopId != null) conditions.push(eq(agentEvents.shopId, query.shopId));

    if (query.status && query.status !== 'all') {
      conditions.push(eq(agentEvents.status, query.status));
    }
    if (query.eventType) {
      conditions.push(eq(agentEvents.eventType, query.eventType));
    }
    if (query.severity && query.severity !== 'all') {
      conditions.push(eq(agentEvents.severity, query.severity));
    }

    const events = await db
      .select()
      .from(agentEvents)
      .where(and(...conditions))
      .orderBy(desc(agentEvents.createdAt))
      .limit(query.limit)
      .offset(query.offset);

    return { events, count: events.length };
  });

  /**
   * GET /ai/events/stats — Counts by status.
   */
  app.get('/ai/events/stats', { preHandler: requireRole('viewer') }, async (req) => {
    const { workspaceId } = z.object({
      workspaceId: z.coerce.number().int().positive(),
    }).parse(req.query);

    const stats = await db
      .select({
        status: agentEvents.status,
        severity: agentEvents.severity,
        count: sql<number>`count(*)::int`,
      })
      .from(agentEvents)
      .where(eq(agentEvents.workspaceId, workspaceId))
      .groupBy(agentEvents.status, agentEvents.severity);

    // Aggregate
    const pending = stats.filter(s => s.status === 'pending').reduce((a, s) => a + s.count, 0);
    const critical = stats.filter(s => s.severity === 'critical' && s.status === 'pending').reduce((a, s) => a + s.count, 0);

    return {
      pending,
      critical,
      byStatus: stats.reduce((acc, s) => {
        acc[s.status] = (acc[s.status] ?? 0) + s.count;
        return acc;
      }, {} as Record<string, number>),
      bySeverity: stats.reduce((acc, s) => {
        acc[s.severity] = (acc[s.severity] ?? 0) + s.count;
        return acc;
      }, {} as Record<string, number>),
    };
  });

  /**
   * GET /ai/events/:id — Get single event.
   */
  app.get('/ai/events/:id', { preHandler: requireRole('viewer') }, async (req, reply) => {
    const { workspaceId } = z.object({
      workspaceId: z.coerce.number().int().positive(),
    }).parse(req.query);
    const eventId = Number((req.params as any).id);

    const [event] = await db
      .select()
      .from(agentEvents)
      .where(and(
        eq(agentEvents.eventId, eventId),
        eq(agentEvents.workspaceId, workspaceId)
      ))
      .limit(1);

    if (!event) return reply.code(404).send({ error: 'Event not found' });
    return { event };
  });

  /**
   * PATCH /ai/events/:id/apply — Apply suggested action.
   */
  app.patch('/ai/events/:id/apply', { preHandler: requireRole('manager') }, async (req, reply) => {
    const { workspaceId } = z.object({
      workspaceId: z.coerce.number().int().positive(),
    }).parse(req.query);
    const eventId = Number((req.params as any).id);
    const userId = (req as any).user?.userId ?? null;

    // Get event
    const [event] = await db
      .select()
      .from(agentEvents)
      .where(and(
        eq(agentEvents.eventId, eventId),
        eq(agentEvents.workspaceId, workspaceId)
      ))
      .limit(1);

    if (!event) return reply.code(404).send({ error: 'Event not found' });
    if (event.status !== 'pending') {
      return reply.code(400).send({ error: 'Event already processed' });
    }

    // Map suggestedAction → executor actionType. Раньше тут стоял TODO и
    // событие просто помечалось applied, а реальное действие не запускалось.
    // Теперь — ставим в durable action queue (agent_actions), executor
    // подхватывает и идёт в WB API. Если для suggestedAction нет executor'а
    // (restock и подобные «информативные»), помечаем как applied без
    // действия — пользователь сам решит что делать.
    const actionTypeMap: Record<string, string> = {
      reprice: 'set_price',
      set_price: 'set_price',
      pause_ads: 'pause_campaign',
      pause_campaign: 'pause_campaign',
      start_campaign: 'start_campaign',
      update_bid: 'update_bid',
      reply_review: 'reply_feedback',
      reply_feedback: 'reply_feedback',
      reply_question: 'reply_question',
    };
    const actionType = event.suggestedAction ? actionTypeMap[event.suggestedAction] : undefined;
    const actionArgs = (event.actionArgs as Record<string, unknown> | null) ?? {};

    // If there's a recognized action type but no args to execute, reject early
    // instead of silently marking as "applied" with no real WB action.
    if (actionType && Object.keys(actionArgs).length === 0) {
      return reply.code(400).send({ ok: false, error: 'Нет данных для применения' });
    }

    let actionId: number | null = null;
    let queuedStatus: string | null = null;
    if (actionType && Object.keys(actionArgs).length > 0) {
      const { enqueueAction } = await import('../agents/tools/actionQueue.js');
      try {
        const enq = await enqueueAction({
          workspaceId,
          shopId: event.shopId != null ? Number(event.shopId) : null,
          userId,
          conversationId: event.conversationId != null ? Number(event.conversationId) : null,
          actionType,
          toolArgs: actionArgs,
          rationale: event.description ?? event.title,
        });
        actionId = enq.actionId;
        queuedStatus = enq.status;
      } catch (err) {
        return reply.code(500).send({ error: (err as Error).message });
      }
    }

    await db
      .update(agentEvents)
      .set({
        status: 'applied',
        appliedAt: new Date(),
        appliedBy: userId,
        updatedAt: new Date(),
        meta: { ...((event.meta as Record<string, unknown>) ?? {}), actionId, queuedStatus },
      })
      .where(eq(agentEvents.eventId, eventId));

    return { ok: true, status: 'applied', actionId, queuedStatus };
  });

  /**
   * PATCH /ai/events/:id/dismiss — Dismiss event.
   */
  app.patch('/ai/events/:id/dismiss', { preHandler: requireRole('manager') }, async (req, reply) => {
    const { workspaceId } = z.object({
      workspaceId: z.coerce.number().int().positive(),
    }).parse(req.query);
    const eventId = Number((req.params as any).id);

    const result = await db
      .update(agentEvents)
      .set({
        status: 'dismissed',
        updatedAt: new Date(),
      })
      .where(and(
        eq(agentEvents.eventId, eventId),
        eq(agentEvents.workspaceId, workspaceId)
      ));

    return { ok: true, status: 'dismissed' };
  });

  /**
   * PATCH /ai/events/:id/snooze — Snooze event.
   */
  app.patch('/ai/events/:id/snooze', { preHandler: requireRole('manager') }, async (req, reply) => {
    const { workspaceId } = z.object({
      workspaceId: z.coerce.number().int().positive(),
    }).parse(req.query);
    const body = z.object({
      hours: z.number().min(1).max(168).default(24), // 1h to 7 days
    }).parse(req.body);
    const eventId = Number((req.params as any).id);

    const snoozedUntil = new Date(Date.now() + body.hours * 60 * 60 * 1000);

    await db
      .update(agentEvents)
      .set({
        status: 'snoozed',
        snoozedUntil,
        updatedAt: new Date(),
      })
      .where(and(
        eq(agentEvents.eventId, eventId),
        eq(agentEvents.workspaceId, workspaceId)
      ));

    return { ok: true, status: 'snoozed', snoozedUntil };
  });

  /**
   * POST /ai/events/:id/chat — Create conversation from event.
   */
  app.post('/ai/events/:id/chat', { preHandler: requireRole('viewer') }, async (req, reply) => {
    const { workspaceId } = z.object({
      workspaceId: z.coerce.number().int().positive(),
    }).parse(req.query);
    const eventId = Number((req.params as any).id);
    const userId = (req as any).user?.userId ?? null;

    // Get event
    const [event] = await db
      .select()
      .from(agentEvents)
      .where(and(
        eq(agentEvents.eventId, eventId),
        eq(agentEvents.workspaceId, workspaceId)
      ))
      .limit(1);

    if (!event) return reply.code(404).send({ error: 'Event not found' });

    // Create conversation
    const threadId = crypto.randomUUID();
    const [conv] = await db.insert(agentConversations).values({
      workspaceId,
      userId,
      threadId,
      title: event.title,
      meta: { fromEventId: eventId },
    }).returning();

    // Add system context message
    const contextMessage = `[Контекст события]
Тип: ${event.eventType}
Важность: ${event.severity}
${event.productTitle ? `Товар: ${event.productTitle} (nmId: ${event.nmId})` : ''}
${event.description ?? ''}
${event.suggestedAction ? `Предлагаемое действие: ${event.suggestedAction}` : ''}`;

    await db.insert(agentMessages).values({
      conversationId: conv.conversationId,
      role: 'system',
      content: contextMessage,
    });

    // Link event to conversation
    await db
      .update(agentEvents)
      .set({
        conversationId: conv.conversationId,
        updatedAt: new Date(),
      })
      .where(eq(agentEvents.eventId, eventId));

    return {
      conversationId: conv.conversationId,
      threadId,
    };
  });
};
