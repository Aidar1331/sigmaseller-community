/**
 * Audit log API
 * 
 * View audit log for workspace (owner only)
 */

import { FastifyPluginAsync } from 'fastify';
import { eq, and, desc, gte, lte, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { auditLog, users } from '../db/schema.js';
import { requireRole } from '../plugins/roleCheck.js';

export const auditRoutes: FastifyPluginAsync = async (app) => {
  // ─────────────────────────────────────────────
  // GET /audit/:workspaceId/logs
  // View audit log
  // ─────────────────────────────────────────────
  app.get<{
    Params: { workspaceId: string };
    Querystring: {
      action?: string;
      userId?: string;
      resourceType?: string;
      from?: string;
      to?: string;
      limit?: string;
      offset?: string;
    };
  }>('/audit/:workspaceId/logs', {
    preHandler: requireRole('owner'),
  }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const {
      action,
      userId,
      resourceType,
      from,
      to,
      limit: limitStr,
      offset: offsetStr,
    } = request.query;

    const limit = Math.min(Number(limitStr) || 50, 200);
    const offset = Number(offsetStr) || 0;

    const conditions = [eq(auditLog.workspaceId, workspaceId)];

    if (action) {
      conditions.push(eq(auditLog.action, action));
    }
    if (userId) {
      conditions.push(eq(auditLog.userId, Number(userId)));
    }
    if (resourceType) {
      conditions.push(eq(auditLog.resourceType, resourceType));
    }
    if (from) {
      conditions.push(gte(auditLog.createdAt, new Date(from)));
    }
    if (to) {
      conditions.push(lte(auditLog.createdAt, new Date(to)));
    }

    const logs = await db
      .select({
        logId: auditLog.logId,
        userId: auditLog.userId,
        userEmail: users.email,
        action: auditLog.action,
        resourceType: auditLog.resourceType,
        resourceId: auditLog.resourceId,
        details: auditLog.details,
        ipAddress: auditLog.ipAddress,
        createdAt: auditLog.createdAt,
      })
      .from(auditLog)
      .leftJoin(users, eq(auditLog.userId, users.userId))
      .where(and(...conditions))
      .orderBy(desc(auditLog.createdAt))
      .limit(limit)
      .offset(offset);

    // Get total count
    const countResult = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(auditLog)
      .where(and(...conditions));

    return {
      logs,
      total: countResult[0]?.count || 0,
      limit,
      offset,
    };
  });

  // ─────────────────────────────────────────────
  // GET /audit/:workspaceId/summary
  // Audit summary stats
  // ─────────────────────────────────────────────
  app.get<{
    Params: { workspaceId: string };
    Querystring: { days?: string };
  }>('/audit/:workspaceId/summary', {
    preHandler: requireRole('owner'),
  }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const days = Number(request.query.days) || 7;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // Actions by type
    const actionCounts = await db
      .select({
        action: auditLog.action,
        count: sql<number>`count(*)::int`,
      })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.workspaceId, workspaceId),
          gte(auditLog.createdAt, since)
        )
      )
      .groupBy(auditLog.action)
      .orderBy(desc(sql`count(*)`));

    // Actions by user
    const userCounts = await db
      .select({
        userId: auditLog.userId,
        email: users.email,
        count: sql<number>`count(*)::int`,
      })
      .from(auditLog)
      .leftJoin(users, eq(auditLog.userId, users.userId))
      .where(
        and(
          eq(auditLog.workspaceId, workspaceId),
          gte(auditLog.createdAt, since)
        )
      )
      .groupBy(auditLog.userId, users.email)
      .orderBy(desc(sql`count(*)`))
      .limit(10);

    // Total events
    const totalResult = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.workspaceId, workspaceId),
          gte(auditLog.createdAt, since)
        )
      );

    return {
      period: { days, since: since.toISOString() },
      total: totalResult[0]?.count || 0,
      byAction: actionCounts,
      byUser: userCounts,
    };
  });
};
