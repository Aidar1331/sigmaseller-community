import type { FastifyPluginAsync } from 'fastify';
import { eq, and, gte, lte, desc, asc, or, sql, inArray, isNull, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { runAutoAlerts } from '../jobs/autoAlerts.js';
import { db } from '../db/client.js';
import { wbEvents } from '../db/schema.js';
import { requireRole } from '../plugins/roleCheck.js';
import { buildShopFilter } from './pulse/helpers.js';

export const alertsRoutes: FastifyPluginAsync = async (app) => {
  app.post('/alerts/:workspaceId/run', { preHandler: requireRole('manager') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z.object({ date: z.string().optional() }).parse(req.query);

    return await runAutoAlerts({ workspaceId: params.workspaceId, date: query.date });
  });

  // Morning-style report: group alerts for a given day
  app.get('/alerts/:workspaceId/report', { preHandler: requireRole('viewer') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z
      .object({
        date: z.string().optional(),
        status: z.enum(['open', 'ack', 'resolved', 'done', 'all']).optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
        shopId: z.coerce.number().int().positive().optional(),
      })
      .parse(req.query);

    const today = new Date().toISOString().slice(0, 10);
    const date = query.date ?? today;
    const limit = query.limit ?? 200;

    const statusCond =
      query.status && query.status !== 'all' ? eq(wbEvents.status, query.status) : sql`true`;

    const shopFilter = buildShopFilter(wbEvents.shopId, query.shopId);
    const conditions: any[] = [
      eq(wbEvents.workspaceId, params.workspaceId),
      eq(wbEvents.date, date),
      eq(wbEvents.type, 'alert'),
      statusCond,
    ];
    if (shopFilter) conditions.push(shopFilter);

    const rows = await db
      .select({
        eventId: wbEvents.eventId,
        nmId: wbEvents.nmId,
        severity: wbEvents.severity,
        category: wbEvents.category,
        status: wbEvents.status,
        title: wbEvents.title,
        evidence: wbEvents.evidence,
        createdAt: wbEvents.createdAt,
      })
      .from(wbEvents)
      .where(and(...conditions))
      .orderBy(
        sql`case ${wbEvents.severity} when 'critical' then 0 when 'warn' then 1 when 'info' then 2 else 9 end`,
        asc(wbEvents.category),
        asc(wbEvents.nmId)
      )
      .limit(limit);

    const bySeverity: Record<string, number> = {};
    const byCategory: Record<string, number> = {};
    for (const r of rows as any[]) {
      const sev = String(r.severity ?? 'unknown');
      const cat = String(r.category ?? 'other');
      bySeverity[sev] = (bySeverity[sev] ?? 0) + 1;
      byCategory[cat] = (byCategory[cat] ?? 0) + 1;
    }

    return {
      workspaceId: params.workspaceId,
      date,
      status: query.status ?? 'all',
      total: rows.length,
      bySeverity,
      byCategory,
      rows,
    };
  });
};
