import type { FastifyPluginAsync } from 'fastify';
import { eq, and, gte, lte, desc, asc, or, sql, inArray, isNull, isNotNull, ne, gt, lt, ilike, between, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { insights } from '../db/schema.js';
import { requireRole } from '../plugins/roleCheck.js';
import { buildShopFilter } from './pulse/helpers.js';

export const insightsRoutes: FastifyPluginAsync = async (app) => {
  // list insights
  app.get('/insights/:workspaceId', { preHandler: requireRole('viewer') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z
      .object({
        status: z.enum(['all', 'unread', 'dismissed']).optional(),
        category: z.string().optional(),
        nmId: z.coerce.number().int().positive().optional(),
        start: z.string().optional(),
        end: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
        offset: z.coerce.number().int().min(0).optional(),
        shopId: z.coerce.number().int().positive().optional(),
      })
      .parse(req.query);


    const conds: any[] = [eq(insights.workspaceId, params.workspaceId)];
    const shopFilter = buildShopFilter(insights.shopId, query.shopId);
    if (shopFilter) conds.push(shopFilter);
    if (query.category) conds.push(eq(insights.category, query.category));
    if (query.nmId) conds.push(eq(insights.nmId, query.nmId as any));
    if (query.start) conds.push(gte(insights.date, query.start));
    if (query.end) conds.push(lte(insights.date, query.end));

    const status = query.status ?? 'all';
    if (status === 'unread') {
      conds.push(isNull(insights.seenAt));
      conds.push(isNull(insights.dismissedAt));
    } else if (status === 'dismissed') {
      conds.push(isNotNull(insights.dismissedAt));
    }

    const rows = await db
      .select()
      .from(insights)
      .where(and(...conds))
      .orderBy(desc(insights.date), desc(insights.score), desc(insights.createdAt))
      .limit(query.limit ?? 200)
      .offset(query.offset ?? 0);

    return { ok: true, workspaceId: params.workspaceId, rows };
  });

  app.post('/insights/:workspaceId/seen', { preHandler: requireRole('manager') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z.object({ ids: z.array(z.coerce.number().int().positive()) }).parse((req as any).body ?? {});

    const rows = await db
      .update(insights)
      .set({ seenAt: new Date(), updatedAt: new Date() })
      .where(and(eq(insights.workspaceId, params.workspaceId), inArray(insights.insightId, body.ids), isNull(insights.seenAt)))
      .returning({ insightId: insights.insightId });

    return { ok: true, updated: rows.length };
  });

  app.post('/insights/:workspaceId/dismiss', { preHandler: requireRole('manager') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z.object({ ids: z.array(z.coerce.number().int().positive()) }).parse((req as any).body ?? {});

    const rows = await db
      .update(insights)
      .set({ dismissedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(insights.workspaceId, params.workspaceId), inArray(insights.insightId, body.ids)))
      .returning({ insightId: insights.insightId });

    return { ok: true, updated: rows.length };
  });

  app.post('/insights/:workspaceId/run', { preHandler: requireRole('manager') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z.object({ date: z.string().optional() }).parse((req as any).body ?? {});
    const { runInsightsForWorkspace } = await import('../jobs/insightsDaily.js');

    const res = await runInsightsForWorkspace(params.workspaceId, body.date);
    return { ok: true, ...res };
  });

  /**
   * POST /insights/:workspaceId/briefing — Generate AI morning briefing.
   * Collects yesterday's data, analyzes with Claude, returns structured summary.
   */
  app.post('/insights/:workspaceId/briefing', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const userId: number | undefined = (req as any).user?.userId;

    const { runMorningBriefing } = await import('../agents/insights/graph.js');
    const result = await runMorningBriefing(params.workspaceId, userId);

    return {
      ok: true,
      conversationId: result.conversationId,
      title: result.title,
      content: result.content,
      priority: result.priority,
      metrics: result.metrics,
    };
  });
};
