/**
 * Tool: action_return_by_review — оформить возврат товара по отзыву.
 *
 * Инициируется продавцом на основании негативного отзыва. Доступно только
 * если у отзыва `isAbleReturnProductOrders: true`. Если товар уже у
 * покупателя — возврат произойдёт когда он попадёт обратно в ПВЗ.
 *
 * Use case: AI читает 3+ негативных отзыва на товар → предлагает снять
 * товар с продажи через серию возвратов.
 *
 * DANGEROUS: confirmation required.
 */

import { db } from '../../db/client.js';
import { agentActions } from '../../db/schema.js';
import { sql } from 'drizzle-orm';
import { returnByReview } from '../../integrations/wb/returns.js';
import { assertAgentAuth } from './locks.js';

interface ActionReturnByReviewArgs {
  feedbackId: string;
  _workspaceId?: number;
  _shopId?: number;
  _userId?: number;
  _confirmed?: boolean;
}

export async function actionReturnByReview(args: ActionReturnByReviewArgs): Promise<string> {
  if (args._confirmed !== true) {
    return JSON.stringify({
      status: 'error',
      error: 'action_return_by_review must be confirmed by the user via executeNode',
    });
  }
  const wsId = args._workspaceId;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });
  await assertAgentAuth(args._userId, wsId);

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

  // Дедуп: тот же отзыв нельзя дважды отдавать на возврат.
  const existing = await db.execute<{ action_id: number }>(sql`
    SELECT action_id FROM agent_actions
    WHERE workspace_id = ${wsId}
      AND action_type = 'return_by_review'
      AND payload->>'feedbackId' = ${args.feedbackId}
      AND status = 'executed'
    LIMIT 1
  `);
  const existingRows = (existing as any).rows ?? existing;
  if (Array.isArray(existingRows) && existingRows.length > 0) {
    return JSON.stringify({
      status: 'already_done',
      message: `Возврат по отзыву ${args.feedbackId} уже был оформлен ранее`,
    });
  }

  const [action] = await db.insert(agentActions).values({
    workspaceId: wsId,
    shopId: args._shopId ?? null,
    actionType: 'return_by_review',
    status: 'pending',
    payload: { feedbackId: args.feedbackId },
    rationale: 'Возврат по отзыву подтверждён пользователем',
    decidedBy: args._userId ? BigInt(args._userId) as any : null,
    decidedAt: new Date(),
  }).returning();

  try {
    const apiKey = await (await import('../../integrations/wb/wbClient.js')).getWbApiKey(wsId, args._shopId ?? undefined);
    await returnByReview(apiKey, args.feedbackId);
    await db.update(agentActions)
      .set({ status: 'executed', executedAt: new Date(), completedAt: new Date() })
      .where(sql`action_id = ${action.actionId}`);
    return JSON.stringify({
      status: 'success',
      actionId: action.actionId,
      message: `✅ Заявка на возврат по отзыву ${args.feedbackId} оформлена. Если товар у покупателя — возврат пройдёт после доставки в ПВЗ.`,
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    await db.update(agentActions)
      .set({ status: 'failed', result: { success: false, error: errorMsg }, executedAt: new Date() })
      .where(sql`action_id = ${action.actionId}`);
    const hint = /isAbleReturn|not.allowed|forbidden/i.test(errorMsg)
      ? ' (отзыв не допускает возврат: проверьте поле isAbleReturnProductOrders)'
      : '';
    return JSON.stringify({
      status: 'error',
      actionId: action.actionId,
      message: `Ошибка оформления возврата: ${errorMsg}${hint}`,
    });
  }
}
