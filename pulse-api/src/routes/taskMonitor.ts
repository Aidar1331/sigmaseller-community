/**
 * Task Monitor routes — manage triggers, view events.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { agentEvents } from '../db/schema.js';
import { eq, and, desc, inArray, or, isNull } from 'drizzle-orm';
import { TRIGGERS } from '../services/taskMonitor/triggers.js';
import { requireRole } from '../plugins/roleCheck.js';
import { sql as dsql } from 'drizzle-orm';

export const taskMonitorRoutes: FastifyPluginAsync = async (app) => {
  // List available triggers
  app.get('/task-monitor/triggers', { preHandler: requireRole('viewer') }, async () => {
    return { triggers: TRIGGERS };
  });

  // Aggregate agent status — used by the task-monitor UI header card.
  // Frontend tolerates 404 silently, but adding the endpoint removes log noise
  // and lets the UI show real numbers.
  app.get('/task-monitor/agent-status', { preHandler: requireRole('viewer') }, async (req) => {
    const q = z.object({
      workspaceId: z.coerce.number().int().positive(),
      shopId: z.coerce.number().int().positive().optional(),
    }).parse(req.query);

    const conditions = [eq(agentEvents.workspaceId, q.workspaceId)];
    // If shopId provided — restrict to that shop's events (plus legacy events
    // with NULL shop_id that predate the shop_id column). Mirrors /events.
    if (q.shopId) {
      conditions.push(or(eq(agentEvents.shopId, q.shopId), isNull(agentEvents.shopId))!);
    }

    const [row] = await db.select({
      lastRunAt: dsql<Date | null>`MAX(${agentEvents.createdAt})`,
      findingsCount: dsql<number>`COUNT(*) FILTER (WHERE ${agentEvents.status} = 'pending')::int`,
      itemsAnalyzed: dsql<number>`COUNT(*)::int`,
    }).from(agentEvents).where(and(...conditions));

    return {
      lastRunAt: row?.lastRunAt ?? null,
      itemsAnalyzed: row?.itemsAnalyzed ?? 0,
      findingsCount: row?.findingsCount ?? 0,
      nextRunAt: null,
      isRunning: false,
    };
  });

  // List events for workspace (optionally narrowed to active shop)
  app.get('/task-monitor/events', { preHandler: requireRole('viewer') }, async (req) => {
    const q = z.object({
      workspaceId: z.coerce.number().int().positive(),
      shopId: z.coerce.number().int().positive().optional(),
      status: z.enum(['pending', 'applied', 'dismissed', 'snoozed', 'expired', 'all']).optional().default('pending'),
      limit: z.coerce.number().int().min(1).max(200).optional().default(50),
    }).parse(req.query);

    const conditions = [eq(agentEvents.workspaceId, q.workspaceId)];
    if (q.status !== 'all') {
      conditions.push(eq(agentEvents.status, q.status));
    }
    // Filter by active shop, but keep legacy events (shop_id IS NULL) visible
    // so users don't lose history when they switched to per-shop filtering.
    if (q.shopId) {
      conditions.push(or(eq(agentEvents.shopId, q.shopId), isNull(agentEvents.shopId))!);
    }

    const events = await db.select()
      .from(agentEvents)
      .where(and(...conditions))
      .orderBy(desc(agentEvents.createdAt))
      .limit(q.limit);

    return { events };
  });

  // Dismiss event
  app.post('/task-monitor/events/:id/dismiss', { preHandler: requireRole('manager') }, async (req) => {
    const { workspaceId: wsId } = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.query);
    const eventId = Number((req.params as any).id);

    await db.update(agentEvents)
      .set({ status: 'dismissed', updatedAt: new Date() })
      .where(and(eq(agentEvents.eventId, eventId), eq(agentEvents.workspaceId, wsId)));

    return { ok: true };
  });

  // Snooze event
  app.post('/task-monitor/events/:id/snooze', { preHandler: requireRole('manager') }, async (req) => {
    const { workspaceId: wsId } = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.query);
    const eventId = Number((req.params as any).id);
    const { hours } = z.object({ hours: z.number().min(1).max(168).default(24) }).parse(req.body);

    const snoozedUntil = new Date(Date.now() + hours * 3600000);
    await db.update(agentEvents)
      .set({ status: 'snoozed', snoozedUntil, updatedAt: new Date() })
      .where(and(eq(agentEvents.eventId, eventId), eq(agentEvents.workspaceId, wsId)));

    return { ok: true, snoozedUntil };
  });

  // Apply suggested action
  app.post('/task-monitor/events/:id/apply', { preHandler: requireRole('manager') }, async (req) => {
    const { workspaceId: wsId } = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.query);
    const eventId = Number((req.params as any).id);
    const userId: number | null = (req as any).user?.userId ?? null;

    await db.update(agentEvents)
      .set({
        status: 'applied',
        appliedAt: new Date(),
        appliedBy: userId,
        updatedAt: new Date(),
      })
      .where(and(eq(agentEvents.eventId, eventId), eq(agentEvents.workspaceId, wsId)));

    return { ok: true };
  });

  // Run monitor manually (admin/debug)
  app.post('/task-monitor/run', { preHandler: requireRole('manager') }, async (req) => {
    const { workspaceId: wsId } = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.query);

    const { runTaskMonitor } = await import('../services/taskMonitor/index.js');
    const result = await runTaskMonitor(wsId);

    return { eventsCreated: result.eventsCreated };
  });
};
