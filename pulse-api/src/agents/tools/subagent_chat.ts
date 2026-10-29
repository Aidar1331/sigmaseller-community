// Multi-Agent v2 — Chat subagent tool. Simple aggregator over wb_chats.

import { randomUUID } from 'node:crypto';
import { and, eq, gte, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { agentExecutionRuns, wbChats } from '../../db/schema.js';
import { logAgent as logger } from '../../lib/logger.js';

export interface SubagentChatInput {
  userIntent: string;
  detailLevel?: 'quick' | 'thorough';
  _workspaceId?: number;
  _shopId?: number | null;
  _correlationId?: string;
}

export async function subagentChat(input: SubagentChatInput): Promise<string> {
  const wsId = input._workspaceId;
  if (!wsId) return JSON.stringify({ status: 'error', agentName: 'chat', error: 'workspace_id missing' });

  const correlationId = input._correlationId ?? randomUUID();
  const runId = randomUUID();
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000);

  await db.insert(agentExecutionRuns).values({
    runId,
    agentName: 'chat',
    workspaceId: wsId,
    shopId: input._shopId ?? null,
    correlationId,
    status: 'running',
    inputSnapshot: { userIntent: input.userIntent, detailLevel: input.detailLevel ?? 'quick' },
  });

  try {
    const [{ totalOpen, unreadSum, recent }] = await db
      .select({
        totalOpen: sql<number>`count(*) filter (where ${wbChats.status} = 'open')`.mapWith(Number),
        unreadSum: sql<number>`coalesce(sum(${wbChats.unreadCount}), 0)`.mapWith(Number),
        recent: sql<number>`count(*) filter (where ${wbChats.lastMessageAt} >= ${sevenDaysAgo.toISOString()})`.mapWith(Number),
      })
      .from(wbChats)
      .where(eq(wbChats.workspaceId, wsId));

    const output = {
      status: 'ok' as const,
      agentName: 'chat' as const,
      summary: `Открытых чатов: ${totalOpen}, непрочитанных сообщений: ${unreadSum}, активность за 7д: ${recent}`,
      stats: { totalOpen, unreadSum, recentActivity7d: recent },
      runId,
    };

    await db.update(agentExecutionRuns)
      .set({ status: 'done', finishedAt: new Date(), output: output as unknown as Record<string, unknown> })
      .where(eq(agentExecutionRuns.runId, runId));
    return JSON.stringify(output);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, wsId, runId }, 'subagentChat failed');
    await db.update(agentExecutionRuns)
      .set({ status: 'failed', finishedAt: new Date(), error: msg })
      .where(eq(agentExecutionRuns.runId, runId));
    return JSON.stringify({ status: 'error', agentName: 'chat', error: msg, runId });
  }
}
