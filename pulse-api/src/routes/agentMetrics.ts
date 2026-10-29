/**
 * Agent Metrics API (Multi-Agent v2 Phase 5).
 *
 * GET /agent-metrics/:workspaceId/overview      — per-agent totals (7d/30d)
 * GET /agent-metrics/:workspaceId/runs          — recent agent_execution_runs
 * GET /agent-metrics/:workspaceId/verification  — V&V pass/drift/fail counts
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentActions, agentExecutionRuns, agentVerificationChecks } from '../db/schema.js';
import { requireRole } from '../plugins/roleCheck.js';

export const agentMetricsRoutes: FastifyPluginAsync = async (app) => {
  // GET /agent-metrics/:workspaceId/overview?window=7d|30d
  app.get('/agent-metrics/:workspaceId/overview', { preHandler: requireRole('viewer') }, async (req) => {
    const { workspaceId } = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const { window } = z.object({ window: z.enum(['7d', '30d']).default('7d') }).parse(req.query);
    const days = window === '7d' ? 7 : 30;
    const since = new Date(Date.now() - days * 86400000);

    const runs = await db
      .select({
        agentName: agentExecutionRuns.agentName,
        total: sql<number>`count(*)`.mapWith(Number),
        succeeded: sql<number>`count(*) filter (where ${agentExecutionRuns.status} = 'done')`.mapWith(Number),
        failed: sql<number>`count(*) filter (where ${agentExecutionRuns.status} = 'failed')`.mapWith(Number),
        avgTokensIn: sql<number>`coalesce(avg(${agentExecutionRuns.tokensInput}), 0)`.mapWith(Number),
        avgTokensOut: sql<number>`coalesce(avg(${agentExecutionRuns.tokensOutput}), 0)`.mapWith(Number),
        totalCostUsd: sql<number>`coalesce(sum(${agentExecutionRuns.costUsd}), 0)`.mapWith(Number),
      })
      .from(agentExecutionRuns)
      .where(and(
        eq(agentExecutionRuns.workspaceId, workspaceId),
        gte(agentExecutionRuns.startedAt, since),
      ))
      .groupBy(agentExecutionRuns.agentName);

    const actions = await db
      .select({
        agentName: agentActions.agentName,
        total: sql<number>`count(*)`.mapWith(Number),
        executed: sql<number>`count(*) filter (where ${agentActions.status} = 'executed')`.mapWith(Number),
        failed: sql<number>`count(*) filter (where ${agentActions.status} = 'failed')`.mapWith(Number),
        rejected: sql<number>`count(*) filter (where ${agentActions.status} = 'rejected')`.mapWith(Number),
      })
      .from(agentActions)
      .where(and(
        eq(agentActions.workspaceId, workspaceId),
        gte(agentActions.createdAt, since),
      ))
      .groupBy(agentActions.agentName);

    return { window, runs, actions };
  });

  // GET /agent-metrics/:workspaceId/runs?limit=50&agentName=pricing&shopId=19
  app.get('/agent-metrics/:workspaceId/runs', { preHandler: requireRole('viewer') }, async (req) => {
    const { workspaceId } = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const { limit, agentName, shopId } = z.object({
      limit: z.coerce.number().int().min(1).max(200).default(50),
      agentName: z.string().optional(),
      shopId: z.coerce.number().int().positive().optional(),
    }).parse(req.query);

    const conditions = [eq(agentExecutionRuns.workspaceId, workspaceId)];
    if (agentName) conditions.push(eq(agentExecutionRuns.agentName, agentName));
    if (shopId != null) conditions.push(eq(agentExecutionRuns.shopId, shopId));

    const runs = await db
      .select()
      .from(agentExecutionRuns)
      .where(and(...conditions))
      .orderBy(desc(agentExecutionRuns.startedAt))
      .limit(limit);

    return { runs, count: runs.length };
  });

  // GET /agent-metrics/:workspaceId/verification
  app.get('/agent-metrics/:workspaceId/verification', { preHandler: requireRole('viewer') }, async (req) => {
    const { workspaceId } = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const { window } = z.object({ window: z.enum(['7d', '30d']).default('7d') }).parse(req.query);
    const days = window === '7d' ? 7 : 30;
    const since = new Date(Date.now() - days * 86400000);

    const stats = await db
      .select({
        checkType: agentVerificationChecks.checkType,
        total: sql<number>`count(*)`.mapWith(Number),
        passed: sql<number>`count(*) filter (where ${agentVerificationChecks.result} = 'pass')`.mapWith(Number),
        drifted: sql<number>`count(*) filter (where ${agentVerificationChecks.result} = 'drift')`.mapWith(Number),
        failed: sql<number>`count(*) filter (where ${agentVerificationChecks.result} = 'fail')`.mapWith(Number),
        pending: sql<number>`count(*) filter (where ${agentVerificationChecks.result} is null)`.mapWith(Number),
      })
      .from(agentVerificationChecks)
      .innerJoin(agentActions, eq(agentVerificationChecks.actionId, agentActions.actionId))
      .where(and(
        eq(agentActions.workspaceId, workspaceId),
        gte(agentVerificationChecks.createdAt, since),
      ))
      .groupBy(agentVerificationChecks.checkType);

    return { window, byCheckType: stats };
  });
};
