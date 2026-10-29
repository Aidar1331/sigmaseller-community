import { runWithAiWorkspace } from '../lib/sellerAiContext.js';
/**
 * pg-boss worker for processing AI agent tasks.
 * 
 * Tasks are created from UI tabs (e.g. /pulse, /finance) when user clicks "🤖 Analyze".
 * Worker runs the LangGraph agent and stores results in the conversation.
 */

import { getQueue } from './queue.js';
import { db } from '../db/client.js';
import { agentTasks, agentConversations, agentMessages } from '../db/schema.js';
import { logAgent as logger } from '../lib/logger.js';
import { eq } from 'drizzle-orm';
import { buildAgentGraph } from '../agents/assistant/graph.js';
import { HumanMessage } from '@langchain/core/messages';
import { randomUUID } from 'crypto';
import type { PromptContext } from '../agents/assistant/systemPrompt.js';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface TaskPayload {
  taskId: number;
  conversationId: number;
  workspaceId: number;
}

// -----------------------------------------------------------------------------
// Worker
// -----------------------------------------------------------------------------

export async function registerAgentTaskWorker(): Promise<void> {
  const boss = await getQueue();
  
  // Create queue if not exists
  await boss.createQueue('agent-process-task');
  
  await boss.work<TaskPayload>('agent-process-task', {
    // Note: concurrency handled by pg-boss internally
  }, async (jobs) => {
    const job = jobs[0];
    const { taskId, conversationId, workspaceId } = job.data;
    
    logger.info({ taskId }, 'Starting agent task');
    
    try {
      // Update status: processing
      await db.update(agentTasks)
        .set({ status: 'processing', startedAt: new Date() })
        .where(eq(agentTasks.taskId, taskId));
      
      await db.update(agentConversations)
        .set({ status: 'processing', updatedAt: new Date() })
        .where(eq(agentConversations.conversationId, conversationId));
      
      // Load task
      const [task] = await db
        .select()
        .from(agentTasks)
        .where(eq(agentTasks.taskId, taskId))
        .limit(1);
      
      if (!task) {
        throw new Error('Task not found');
      }
      
      // Create thread for LangGraph
      const threadId = `task-${taskId}-${randomUUID()}`;
      
      // Build graph
      const graph = await buildAgentGraph();
      
      // Build prompt context from task meta
      const filters = task.filters as Record<string, unknown>;
      const summary = task.summary as Record<string, unknown> | undefined;
      const selectedItems = task.selectedItems as Array<{ nmId: number; name?: string }> | undefined;
      
      const promptContext: PromptContext = {
        page: task.page as PromptContext['page'],
        dateFrom: filters?.dateFrom as string | undefined,
        dateTo: filters?.dateTo as string | undefined,
        summary,
        selectedItems,
      };
      
      // Run agent with timeout (not streaming — full result)
      logger.info({ taskId, workspaceId }, 'Running agent graph');
      
      const LLM_TIMEOUT_MS = 600_000; // 10 minutes max
      
      const graphPromise = runWithAiWorkspace(workspaceId, () => graph.invoke(
        {
          messages: [new HumanMessage(task.message)],
          workspaceId,
          promptContext,
          pendingAction: null,
          sseEventCounter: 0,
        },
        {
          configurable: { thread_id: threadId },
          // M2: match the chat path (routes/aiChat.ts) — without an explicit
          // cap LangGraph defaults to 25, which is enough for one-shot
          // analyses but trips on long tool-call chains the LLM occasionally
          // produces. The whole job has a 10-min hard timeout anyway.
          recursionLimit: 40,
        }
      ));
      
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('LLM timeout: задача превысила лимит времени (10 мин)')), LLM_TIMEOUT_MS);
      });
      
      const result = await Promise.race([graphPromise, timeoutPromise]);
      
      // Extract result from last message
      const lastMessage = result.messages[result.messages.length - 1];
      const content = typeof lastMessage.content === 'string' 
        ? lastMessage.content 
        : JSON.stringify(lastMessage.content);
      
      // Check for widgets in response
      let widgetType: string | undefined;
      let widgetProps: Record<string, unknown> | undefined;
      
      try {
        const parsed = JSON.parse(content);
        if (parsed.__widget) {
          widgetType = parsed.__widget;
          widgetProps = parsed.props;
        }
      } catch {
        // Not JSON, that's fine — it's plain text
      }
      
      // Save assistant message
      await db.insert(agentMessages).values({
        conversationId,
        role: 'assistant',
        content,
        widgetType,
        widgetProps,
      });
      
      // Update statuses: completed / ready
      await db.update(agentTasks)
        .set({ status: 'completed', completedAt: new Date() })
        .where(eq(agentTasks.taskId, taskId));
      
      await db.update(agentConversations)
        .set({ 
          status: 'ready', 
          threadId, 
          updatedAt: new Date() 
        })
        .where(eq(agentConversations.conversationId, conversationId));
      
      logger.info({ taskId }, 'Agent task completed');
      
    } catch (error: unknown) {
      logger.error({ taskId, err: error }, 'Agent task failed');
      
      // Update statuses: failed / error
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      await db.update(agentTasks)
        .set({ 
          status: 'failed', 
          errorMessage,
          retryCount: (job.data as TaskPayload & { retryCount?: number }).retryCount ?? 0,
        })
        .where(eq(agentTasks.taskId, taskId));
      
      await db.update(agentConversations)
        .set({ 
          status: 'error', 
          errorMessage,
          updatedAt: new Date() 
        })
        .where(eq(agentConversations.conversationId, conversationId));
      
      throw error; // pg-boss will retry
    }
  });
  
  logger.info('Agent task worker registered');
}
