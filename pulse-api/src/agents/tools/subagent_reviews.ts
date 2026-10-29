// Multi-Agent v2 — Reviews subagent tool. Lightweight: aggregates recent
// feedback stats for workspace + classification hint. Full autonomous-reply
// pipeline remains in jobs/feedbackAutoReply.ts.

import { randomUUID } from 'node:crypto';
import { eq, and, gte, desc, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { agentExecutionRuns, marketplaceFeedbackItems } from '../../db/schema.js';
import { logAgent as logger } from '../../lib/logger.js';

export interface SubagentReviewsInput {
  userIntent: string;
  daysBack?: number;
  detailLevel?: 'quick' | 'thorough';
  _workspaceId?: number;
  _shopId?: number | null;
  _correlationId?: string;
}

interface ReviewsSummary {
  status: 'ok' | 'error' | 'no_data';
  agentName: 'reviews';
  summary: string;
  stats: {
    total: number;
    byRating: Record<string, number>;
    withoutReply: number;
    criticalUnanswered: number;
  };
  runId?: string;
}

export async function subagentReviews(input: SubagentReviewsInput): Promise<string> {
  const wsId = input._workspaceId;
  if (!wsId) return JSON.stringify({ status: 'error', agentName: 'reviews', error: 'workspace_id missing' });

  const correlationId = input._correlationId ?? randomUUID();
  const runId = randomUUID();
  const daysBack = input.daysBack ?? 7;
  const sinceDate = new Date(Date.now() - daysBack * 86400000);

  await db.insert(agentExecutionRuns).values({
    runId,
    agentName: 'reviews',
    workspaceId: wsId,
    shopId: input._shopId ?? null,
    correlationId,
    status: 'running',
    inputSnapshot: { userIntent: input.userIntent, daysBack, detailLevel: input.detailLevel ?? 'quick' },
  });

  try {
    const rows = await db
      .select({
        rating: marketplaceFeedbackItems.rating,
        isAnswered: marketplaceFeedbackItems.isAnswered,
      })
      .from(marketplaceFeedbackItems)
      .where(and(
        eq(marketplaceFeedbackItems.workspaceId, wsId),
        gte(marketplaceFeedbackItems.createdAt, sinceDate),
      ))
      .orderBy(desc(marketplaceFeedbackItems.createdAt))
      .limit(500);

    const byRating: Record<string, number> = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
    let withoutReply = 0;
    let criticalUnanswered = 0;
    for (const r of rows) {
      const rating = String(r.rating ?? '0');
      if (byRating[rating] !== undefined) byRating[rating]++;
      if (!r.isAnswered) {
        withoutReply++;
        if (r.rating != null && r.rating <= 2) criticalUnanswered++;
      }
    }

    const output: ReviewsSummary = {
      status: rows.length > 0 ? 'ok' : 'no_data',
      agentName: 'reviews',
      summary: `За ${daysBack}д: ${rows.length} отзывов, без ответа ${withoutReply}, критичных 1-2★ без ответа ${criticalUnanswered}`,
      stats: { total: rows.length, byRating, withoutReply, criticalUnanswered },
      runId,
    };

    await db.update(agentExecutionRuns)
      .set({ status: 'done', finishedAt: new Date(), output: output as unknown as Record<string, unknown> })
      .where(eq(agentExecutionRuns.runId, runId));

    return JSON.stringify(output);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, wsId, runId }, 'subagentReviews failed');
    await db.update(agentExecutionRuns)
      .set({ status: 'failed', finishedAt: new Date(), error: msg })
      .where(eq(agentExecutionRuns.runId, runId));
    return JSON.stringify({ status: 'error', agentName: 'reviews', error: msg, runId });
  }
}
