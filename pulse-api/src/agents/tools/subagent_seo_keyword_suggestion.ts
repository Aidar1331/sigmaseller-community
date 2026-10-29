/**
 * Subagent tool: предлагает поисковые слова для отслеживания.
 *
 * Вызывает `runSeoKeywordSuggest` + форматирует результат так, чтобы main
 * assistant мог показать виджет `keyword_suggestions` с чекбоксами.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { agentExecutionRuns } from '../../db/schema.js';
import { logAgent as logger } from '../../lib/logger.js';
import { runSeoKeywordSuggest } from '../specialized/seoAgentKeywordSuggest.js';

export interface SubagentSeoKeywordSuggestionInput {
  userIntent: string;
  limit?: number;
  includeTracked?: boolean;
  _workspaceId?: number;
  _shopId?: number | null;
  _correlationId?: string;
}

export async function subagentSeoKeywordSuggestion(input: SubagentSeoKeywordSuggestionInput): Promise<string> {
  const wsId = input._workspaceId;
  if (!wsId) {
    return JSON.stringify({ status: 'error', agentName: 'seo-keyword-suggest', error: 'workspace_id missing' });
  }

  const correlationId = input._correlationId ?? randomUUID();
  const execRunId = randomUUID();
  const shopId = input._shopId ?? null;

  await db.insert(agentExecutionRuns).values({
    runId: execRunId,
    agentName: 'seo-keyword-suggest',
    workspaceId: wsId,
    shopId,
    correlationId,
    status: 'running',
    inputSnapshot: { userIntent: input.userIntent, limit: input.limit, includeTracked: input.includeTracked },
  });

  try {
    const { summary, candidates } = await runSeoKeywordSuggest(wsId, shopId, {
      limit: input.limit,
      includeTracked: input.includeTracked,
    });

    const output = {
      status: 'ok',
      agentName: 'seo-keyword-suggest',
      runId: execRunId,
      summary,
      candidates,
      // widget — main assistant может решить показывать или нет
      __widget: 'keyword_suggestions',
      props: { candidates, workspaceId: wsId, shopId },
    };
    await db.update(agentExecutionRuns)
      .set({ status: 'done', finishedAt: new Date(), output: output as unknown as Record<string, unknown> })
      .where(eq(agentExecutionRuns.runId, execRunId));
    return JSON.stringify(output);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, wsId, execRunId }, 'subagentSeoKeywordSuggestion failed');
    await db.update(agentExecutionRuns)
      .set({ status: 'failed', finishedAt: new Date(), error: msg })
      .where(eq(agentExecutionRuns.runId, execRunId));
    return JSON.stringify({ status: 'error', agentName: 'seo-keyword-suggest', error: msg, runId: execRunId });
  }
}
