/**
 * Tool: action_reject_question — отклонить вопрос покупателя.
 * Покупатель получит ответ, но вопрос+ответ НЕ опубликуются на WB.
 *
 * Используется для не-вопросов («спасибо», спам, повторы).
 * DANGEROUS: confirmation required.
 */

import { db } from '../../db/client.js';
import { agentActions } from '../../db/schema.js';
import { sql } from 'drizzle-orm';
import { rejectWbQuestion } from '../../integrations/wb/feedbacks.js';
import { assertAgentAuth } from './locks.js';

interface ActionRejectQuestionArgs {
  questionId: string;
  replyText: string;
  _workspaceId?: number;
  _shopId?: number;
  _userId?: number;
  _confirmed?: boolean;
}

export async function actionRejectQuestion(args: ActionRejectQuestionArgs): Promise<string> {
  if (args._confirmed !== true) {
    return JSON.stringify({
      status: 'error',
      error: 'action_reject_question must be confirmed by the user via executeNode',
    });
  }
  const wsId = args._workspaceId;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });
  await assertAgentAuth(args._userId, wsId);

  const owned = await db.execute<{ exists: number }>(sql`
    SELECT 1 AS exists FROM marketplace_feedback_items
    WHERE workspace_id = ${wsId}
      AND marketplace = 'wb'
      AND item_type = 'question'
      AND item_id = ${args.questionId}
    LIMIT 1
  `);
  const ownedRows = (owned as any).rows ?? owned;
  if (!Array.isArray(ownedRows) || ownedRows.length === 0) {
    return JSON.stringify({
      status: 'error',
      error: `Вопрос ${args.questionId} не найден в этом workspace.`,
    });
  }

  const [action] = await db.insert(agentActions).values({
    workspaceId: wsId,
    shopId: args._shopId ?? null,
    actionType: 'reject_question',
    status: 'pending',
    payload: { questionId: args.questionId, replyText: args.replyText },
    rationale: 'Отклонение вопроса подтверждено пользователем',
    decidedBy: args._userId ? BigInt(args._userId) as any : null,
    decidedAt: new Date(),
  }).returning();

  try {
    await rejectWbQuestion(wsId, args._shopId ?? null, args.questionId, args.replyText);
    await db.update(agentActions)
      .set({ status: 'executed', executedAt: new Date(), completedAt: new Date() })
      .where(sql`action_id = ${action.actionId}`);
    return JSON.stringify({
      status: 'success',
      actionId: action.actionId,
      message: `✅ Вопрос ${args.questionId} отклонён (не опубликован на WB)`,
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    await db.update(agentActions)
      .set({ status: 'failed', result: { success: false, error: errorMsg }, executedAt: new Date() })
      .where(sql`action_id = ${action.actionId}`);
    return JSON.stringify({
      status: 'error',
      actionId: action.actionId,
      message: `Ошибка отклонения вопроса: ${errorMsg}`,
    });
  }
}
