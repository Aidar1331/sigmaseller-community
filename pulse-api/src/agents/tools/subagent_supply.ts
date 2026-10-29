// Multi-Agent v2 — Supply subagent tool. Wraps runSupplyAgentPersisted()
// so that calls from main assistant also populate agent_supply_recommendations
// (visible in UI on /plan).

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { agentExecutionRuns, agentSupplyRecommendations } from '../../db/schema.js';
import { logAgent as logger } from '../../lib/logger.js';
import { runSupplyAgentPersisted } from '../specialized/runners/supplyRunner.js';

export interface SubagentSupplyInput {
  userIntent: string;
  targetDays?: number;
  detailLevel?: 'quick' | 'thorough';
  _workspaceId?: number;
  _shopId?: number | null;
  _correlationId?: string;
}

export async function subagentSupply(input: SubagentSupplyInput): Promise<string> {
  const wsId = input._workspaceId;
  if (!wsId) {
    return JSON.stringify({ status: 'error', agentName: 'supply', error: 'workspace_id missing' });
  }

  const correlationId = input._correlationId ?? randomUUID();
  const execRunId = randomUUID();
  const targetDays = input.targetDays ?? 45;
  const shopId = input._shopId ?? null;

  // Legacy agentExecutionRuns bookkeeping (Multi-Agent v2 framework).
  await db.insert(agentExecutionRuns).values({
    runId: execRunId,
    agentName: 'supply',
    workspaceId: wsId,
    shopId,
    correlationId,
    status: 'running',
    inputSnapshot: { userIntent: input.userIntent, targetDays, detailLevel: input.detailLevel ?? 'quick' },
  });

  try {
    const { runId, summary, recommendationsCount } = await runSupplyAgentPersisted({
      workspaceId: wsId,
      shopId,
      trigger: 'subagent',
      targetDays,
    });

    // Берём топ-10 для инлайн-ответа агенту (чтобы LLM мог цитировать).
    const top = await db
      .select({
        nmId: agentSupplyRecommendations.nmId,
        productTitle: agentSupplyRecommendations.productTitle,
        currentStock: agentSupplyRecommendations.currentStock,
        avgDailySales: agentSupplyRecommendations.avgDailySales,
        daysOfStock: agentSupplyRecommendations.daysOfStock,
        recommendedQty: agentSupplyRecommendations.recommendedQty,
        urgency: agentSupplyRecommendations.urgency,
        reason: agentSupplyRecommendations.reason,
      })
      .from(agentSupplyRecommendations)
      .where(eq(agentSupplyRecommendations.runId, runId))
      .orderBy(agentSupplyRecommendations.urgency)
      .limit(10);

    const output = {
      status: 'ok',
      agentName: 'supply',
      runId,
      execRunId,
      summary,
      recommendationsCount,
      topRecommendations: top,
    };
    await db.update(agentExecutionRuns)
      .set({ status: 'done', finishedAt: new Date(), output: output as unknown as Record<string, unknown> })
      .where(eq(agentExecutionRuns.runId, execRunId));
    return JSON.stringify(output);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, wsId, execRunId }, 'subagentSupply failed');
    await db.update(agentExecutionRuns)
      .set({ status: 'failed', finishedAt: new Date(), error: msg })
      .where(eq(agentExecutionRuns.runId, execRunId));
    return JSON.stringify({ status: 'error', agentName: 'supply', error: msg, runId: execRunId });
  }
}
