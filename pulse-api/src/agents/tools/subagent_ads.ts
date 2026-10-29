// Multi-Agent v2 — Ads/Bidder subagent tool. Wraps runBidderAgent().

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { agentExecutionRuns } from '../../db/schema.js';
import { logAgent as logger } from '../../lib/logger.js';
import { runBidderAgent } from '../specialized/bidderAgent.js';

type BidStrategy = 'maximize_position' | 'optimize_drr' | 'budget_saver' | 'aggressive_growth';

export interface SubagentAdsInput {
  userIntent: string;
  strategy?: BidStrategy;
  detailLevel?: 'quick' | 'thorough';
  _workspaceId?: number;
  _shopId?: number | null;
  _correlationId?: string;
}

export async function subagentAds(input: SubagentAdsInput): Promise<string> {
  const wsId = input._workspaceId;
  if (!wsId) return JSON.stringify({ status: 'error', agentName: 'ads', error: 'workspace_id missing' });

  const correlationId = input._correlationId ?? randomUUID();
  const runId = randomUUID();

  await db.insert(agentExecutionRuns).values({
    runId,
    agentName: 'ads',
    workspaceId: wsId,
    shopId: input._shopId ?? null,
    correlationId,
    status: 'running',
    inputSnapshot: {
      userIntent: input.userIntent,
      strategy: input.strategy ?? 'optimize_drr',
      detailLevel: input.detailLevel ?? 'quick',
    },
  });

  try {
    const result = await runBidderAgent(wsId, input.strategy ?? 'optimize_drr', input._shopId ?? undefined);
    const output = { status: 'ok', agentName: 'ads', ...result, runId };

    await db.update(agentExecutionRuns)
      .set({ status: 'done', finishedAt: new Date(), output: output as unknown as Record<string, unknown> })
      .where(eq(agentExecutionRuns.runId, runId));

    return JSON.stringify(output);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, wsId, runId }, 'subagentAds failed');
    await db.update(agentExecutionRuns)
      .set({ status: 'failed', finishedAt: new Date(), error: msg })
      .where(eq(agentExecutionRuns.runId, runId));
    return JSON.stringify({ status: 'error', agentName: 'ads', error: msg, runId });
  }
}
