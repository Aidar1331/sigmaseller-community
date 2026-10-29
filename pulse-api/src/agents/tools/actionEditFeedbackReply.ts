/**
 * Tool: action_edit_feedback_reply — отредактировать ранее отправленный ответ
 * на отзыв. WB разрешает 1 правку в течение 60 дней после исходного ответа.
 *
 * DANGEROUS: только через executeNode после подтверждения пользователя.
 */

import { db } from '../../db/client.js';
import { agentActions } from '../../db/schema.js';
import { sql } from 'drizzle-orm';
import { editWbFeedbackAnswer } from '../../integrations/wb/feedbacks.js';
import { assertAgentAuth } from './locks.js';

interface ActionEditFeedbackReplyArgs {
  feedbackId: string;
  replyText: string;
  _workspaceId?: number;
  _shopId?: number;
  _userId?: number;
  _confirmed?: boolean;
}

export async function actionEditFeedbackReply(args: ActionEditFeedbackReplyArgs): Promise<string> {
  if (args._confirmed !== true) {
    return JSON.stringify({
      status: 'error',
      error: 'action_edit_feedback_reply must be confirmed by the user via executeNode',
    });
  }
  const wsId = args._workspaceId;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });
  await assertAgentAuth(args._userId, wsId);

  // Ownership check — отзыв должен принадлежать workspace.
  const owned = await db.execute<{ exists: number }>(sql`
    SELECT 1 AS exists FROM marketplace_feedback_items
    WHERE workspace_id = ${wsId}
      AND marketplace = 'wb'
      AND item_type = 'feedback'
      AND item_id = ${args.feedbackId}
    LIMIT 1
  `);
  const ownedRows = (owned as any).rows ?? owned;
  if (!Array.isArray(ownedRows) || ownedRows.length === 0) {
    return JSON.stringify({
      status: 'error',
      error: `Отзыв ${args.feedbackId} не найден в этом workspace.`,
    });
  }

  // Лог действия (для audit trail). Inline без queue — редактирование редкое.
  const [action] = await db.insert(agentActions).values({
    workspaceId: wsId,
    shopId: args._shopId ?? null,
    actionType: 'edit_feedback_reply',
    status: 'pending',
    payload: { feedbackId: args.feedbackId, replyText: args.replyText },
    rationale: 'Редактирование ответа подтверждено пользователем',
    decidedBy: args._userId ? BigInt(args._userId) as any : null,
    decidedAt: new Date(),
  }).returning();

  try {
    await editWbFeedbackAnswer(wsId, args._shopId ?? null, args.feedbackId, args.replyText);
    await db.update(agentActions)
      .set({ status: 'executed', executedAt: new Date(), completedAt: new Date() })
      .where(sql`action_id = ${action.actionId}`);
    return JSON.stringify({
      status: 'success',
      actionId: action.actionId,
      message: `✅ Ответ на отзыв ${args.feedbackId} обновлён`,
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    await db.update(agentActions)
      .set({ status: 'failed', result: { success: false, error: errorMsg }, executedAt: new Date() })
      .where(sql`action_id = ${action.actionId}`);
    // Типичная ошибка: 60-дневное окно истекло
    const hint = /60|expired|window/i.test(errorMsg)
      ? ' (возможно, прошло более 60 дней с момента исходного ответа — WB не разрешает редактирование)'
      : '';
    return JSON.stringify({
      status: 'error',
      actionId: action.actionId,
      message: `Ошибка редактирования ответа: ${errorMsg}${hint}`,
    });
  }
}
