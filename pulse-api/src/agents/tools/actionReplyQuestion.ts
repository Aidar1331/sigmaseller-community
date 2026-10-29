/**
 * Tool: action_reply_question — Reply to a customer question on WB.
 * DANGEROUS: must be invoked ONLY through executeNode after user confirmation.
 *
 * Security contract:
 *  - `_confirmed`/`_userId`/`_shopId`/`_workspaceId` are SERVER-injected by
 *    `graph.ts:executeNode`.
 *  - Lock acquisition lives at graph level — no per-tool locks here.
 */

import { db } from '../../db/client.js';
import { agentActions } from '../../db/schema.js';
import { eq, sql } from 'drizzle-orm';
import { sendWbQuestionAnswer } from '../../integrations/wb/feedbacks.js';
import { assertAgentAuth } from './locks.js';
import { env } from '../../env.js';
import { enqueueAction } from './actionQueue.js';

interface ActionReplyQuestionArgs {
  questionId: string;
  replyText: string;
  _workspaceId?: number;
  _shopId?: number;
  _userId?: number;
  // Server-injected by executeNode — never trust values supplied by the LLM.
  _confirmed?: boolean;
}

export async function actionReplyQuestion(args: ActionReplyQuestionArgs): Promise<string> {
  // Failsafe: must only be reached via graph.executeNode.
  if (args._confirmed !== true) {
    return JSON.stringify({
      status: 'error',
      error: 'action_reply_question must be confirmed by the user via executeNode',
    });
  }

  const wsId = args._workspaceId;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });

  // Auth check: user must be manager+ in workspace
  try {
    await assertAgentAuth(args._userId, wsId);
  } catch (err: any) {
    return JSON.stringify({ error: err.message });
  }

  // Ownership: question stored in marketplace_feedback_items with item_type='question'.
  const ownedRes = await db.execute<{ exists: number }>(sql`
    SELECT 1 AS exists FROM marketplace_feedback_items
    WHERE workspace_id = ${wsId} AND marketplace = 'wb' AND item_type = 'question' AND item_id = ${args.questionId}
    LIMIT 1
  `);
  if (!Array.isArray(((ownedRes as any).rows ?? ownedRes)) || (((ownedRes as any).rows ?? ownedRes) as any[]).length === 0) {
    return JSON.stringify({ status: 'error', error: `Вопрос ${args.questionId} не найден в этом workspace.` });
  }

  // Action Queue path
  if (env.ENABLE_ACTION_QUEUE === '1') {
    const enq = await enqueueAction({
      workspaceId: wsId, shopId: args._shopId ?? null, userId: args._userId ?? null, conversationId: null,
      actionType: 'reply_question',
      toolArgs: { questionId: args.questionId, replyText: args.replyText },
      rationale: 'Ответ на вопрос покупателя',
    });
    return JSON.stringify({
      status: enq.reused ? 'already_queued' : 'queued',
      actionId: enq.actionId,
      message: enq.reused
        ? `Ответ на вопрос ${args.questionId} уже в очереди [actionId:${enq.actionId}].`
        : `✓ Ответ на вопрос ${args.questionId} поставлен в очередь [actionId:${enq.actionId}].`,
    });
  }

  let action: any = null;
  try {
    // Log action as pending
    [action] = await db.insert(agentActions).values({
      workspaceId: wsId,
      shopId: args._shopId ?? null,
      actionType: 'reply_question',
      status: 'pending',
      payload: { questionId: args.questionId, replyText: args.replyText },
      rationale: `Ответ на вопрос покупателя`,
      decidedBy: args._userId ? (BigInt(args._userId) as any) : null,
      decidedAt: new Date(),
    }).returning();

    // Call WB API
    await sendWbQuestionAnswer(wsId, args._shopId ?? null, args.questionId, args.replyText);

    // Mark as executed
    await db.update(agentActions)
      .set({ status: 'executed', executedAt: new Date(), completedAt: new Date() })
      .where(eq(agentActions.actionId, action.actionId));

    return JSON.stringify({
      status: 'success',
      actionId: Number(action.actionId),
      message: `Ответ на вопрос ${args.questionId} отправлен успешно.`,
    });
  } catch (err: any) {
    if (action?.actionId) {
      await db.update(agentActions).set({ status: 'failed' }).where(eq(agentActions.actionId, action.actionId)).catch(() => {});
    }
    return JSON.stringify({
      status: 'failed',
      error: err.message || 'Ошибка при отправке ответа на вопрос',
    });
  }
}
