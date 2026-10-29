// Multi-Agent v2 — SEO subagent tool. Wraps runSeoAgentPersisted() so
// that calls from main assistant also populate seo_alerts with 48h dedupe
// (visible on /seo page).

import { randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { agentExecutionRuns, seoAlerts, seoKeywords } from '../../db/schema.js';
import { logAgent as logger } from '../../lib/logger.js';
import { runSeoAgentPersisted } from '../specialized/runners/seoRunner.js';

export interface SubagentSeoInput {
  userIntent: string;
  detailLevel?: 'quick' | 'thorough';
  _workspaceId?: number;
  _shopId?: number | null;
  _correlationId?: string;
}

export async function subagentSeo(input: SubagentSeoInput): Promise<string> {
  const wsId = input._workspaceId;
  if (!wsId) {
    return JSON.stringify({ status: 'error', agentName: 'seo', error: 'workspace_id missing' });
  }

  const correlationId = input._correlationId ?? randomUUID();
  const execRunId = randomUUID();
  const shopId = input._shopId ?? null;

  await db.insert(agentExecutionRuns).values({
    runId: execRunId,
    agentName: 'seo',
    workspaceId: wsId,
    shopId,
    correlationId,
    status: 'running',
    inputSnapshot: { userIntent: input.userIntent, detailLevel: input.detailLevel ?? 'quick' },
  });

  try {
    const { runId, summary, alertsCreated, alertsSkippedDedup } = await runSeoAgentPersisted({
      workspaceId: wsId,
      shopId,
      trigger: 'subagent',
    });

    // Забираем 10 последних unread alerts для инлайн-ответа
    const recent = await db
      .select({
        alertId: seoAlerts.alertId,
        nmId: seoAlerts.nmId,
        keyword: seoKeywords.keyword,
        previousPosition: seoAlerts.previousPosition,
        currentPosition: seoAlerts.currentPosition,
        alertType: seoAlerts.alertType,
        createdAt: seoAlerts.createdAt,
      })
      .from(seoAlerts)
      .leftJoin(seoKeywords, eq(seoAlerts.keywordId, seoKeywords.keywordId))
      .where(eq(seoKeywords.workspaceId, wsId))
      .orderBy(desc(seoAlerts.createdAt))
      .limit(10);

    const output = {
      status: 'ok',
      agentName: 'seo',
      runId,
      execRunId,
      summary,
      alertsCreated,
      alertsSkippedDedup,
      topAlerts: recent,
    };
    await db.update(agentExecutionRuns)
      .set({ status: 'done', finishedAt: new Date(), output: output as unknown as Record<string, unknown> })
      .where(eq(agentExecutionRuns.runId, execRunId));
    return JSON.stringify(output);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, wsId, execRunId }, 'subagentSeo failed');
    await db.update(agentExecutionRuns)
      .set({ status: 'failed', finishedAt: new Date(), error: msg })
      .where(eq(agentExecutionRuns.runId, execRunId));
    return JSON.stringify({ status: 'error', agentName: 'seo', error: msg, runId: execRunId });
  }
}
