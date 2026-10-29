/**
 * Tool: action_reply_feedback — Reply to a customer review on WB.
 * DANGEROUS: must be invoked ONLY through executeNode after user confirmation.
 *
 * Security contract:
 *  - `_confirmed`/`_userId`/`_shopId`/`_workspaceId` are SERVER-injected by
 *    `graph.ts:executeNode`.
 *  - Lock acquisition lives at graph level — no per-tool locks here. Fixes
 *    the prior race where the per-tool lock was released before WB API
 *    confirmation.
 */

import { db } from '../../db/client.js';
import { agentActions } from '../../db/schema.js';
import { eq, and, sql } from 'drizzle-orm';
import { wbReplyFeedback } from '../../integrations/wb/wbActions.js';
import { assertAgentAuth } from './locks.js';
import { env } from '../../env.js';
import { enqueueAction } from './actionQueue.js';

interface ActionReplyFeedbackArgs {
  feedbackId: string;
  replyText: string;
  _workspaceId?: number;
  _shopId?: number;
  _userId?: number;
  // Server-injected by executeNode — never trust values supplied by the LLM.
  _confirmed?: boolean;
}

export async function actionReplyFeedback(args: ActionReplyFeedbackArgs): Promise<string> {
  // Failsafe: must only be reached via graph.executeNode.
  if (args._confirmed !== true) {
    return JSON.stringify({
      status: 'error',
      error: 'action_reply_feedback must be confirmed by the user via executeNode',
    });
  }

  const wsId = args._workspaceId;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });
  await assertAgentAuth(args._userId, wsId);

  // Dedup check
  const existing = await db.select({ id: agentActions.actionId })
    .from(agentActions)
    .where(and(
      eq(agentActions.workspaceId, wsId),
      eq(agentActions.actionType, 'reply_feedback'),
      sql`${agentActions.payload}->>'feedbackId' = ${args.feedbackId}`,
      eq(agentActions.status, 'executed'),
    ))
    .limit(1);
  if (existing.length > 0) {
    return 'Ответ на этот отзыв уже был отправлен ранее.';
  }

  // Ownership check: feedback must belong to this workspace.
  // marketplace_feedback_items is workspace-scoped (shop_id not tracked there;
  // see DECISIONS / migration 0053 — feedback ingest is per-workspace token).
  const owned = await db.execute<{ exists: number }>(sql`
    SELECT 1 AS exists
    FROM marketplace_feedback_items
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
      error: `Отзыв ${args.feedbackId} не найден в этом workspace. Проверь принадлежность.`,
    });
  }

  // ─── Action Queue path (feature-flagged) ────────────────────────────────
  if (env.ENABLE_ACTION_QUEUE === '1') {
    const enq = await enqueueAction({
      workspaceId: wsId,
      shopId: args._shopId ?? null,
      userId: args._userId ?? null,
      conversationId: null,
      actionType: 'reply_feedback',
      toolArgs: { feedbackId: args.feedbackId, replyText: args.replyText },
      rationale: 'Ответ сгенерирован AI-ассистентом и подтверждён пользователем',
    });
    return JSON.stringify({
      status: enq.reused ? 'already_queued' : 'queued',
      actionId: enq.actionId,
      message: enq.reused
        ? `Ответ на отзыв ${args.feedbackId} уже в очереди [actionId:${enq.actionId}].`
        : `✓ Ответ на отзыв ${args.feedbackId} поставлен в очередь [actionId:${enq.actionId}]. Будет отправлен в ближайшие секунды.`,
    });
  }
  // ────────────────────────────────────────────────────────────────────────

  // Log action as pending
  const [action] = await db.insert(agentActions).values({
    workspaceId: wsId,
    shopId: args._shopId ?? null,
    actionType: 'reply_feedback',
    status: 'pending',
    payload: { feedbackId: args.feedbackId, replyText: args.replyText },
    rationale: 'Ответ сгенерирован AI-ассистентом и подтверждён пользователем',
    decidedBy: args._userId ? BigInt(args._userId) as any : null,
    decidedAt: new Date(),
  }).returning();

  try {
    // Call WB API
    const result = await wbReplyFeedback(wsId, args._shopId!, args.feedbackId, args.replyText);

    if (!result.success) {
      await db.update(agentActions)
        .set({
          status: 'failed',
          result: { success: false, error: result.error },
          executedAt: new Date(),
        })
        .where(eq(agentActions.actionId, action.actionId));

      return JSON.stringify({
        status: 'error',
        actionId: action.actionId,
        message: `Не удалось отправить ответ: ${result.error}`,
      });
    }

    await db.update(agentActions)
      .set({
        status: 'executed',
        executedAt: new Date(), completedAt: new Date(),
      })
      .where(eq(agentActions.actionId, action.actionId));

    return JSON.stringify({
      status: 'success',
      actionId: action.actionId,
      message: `✅ Ответ на отзыв ${args.feedbackId} успешно отправлен`,
    });

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';

    await db.update(agentActions)
      .set({
        status: 'failed',
        result: { success: false, error: errorMsg },
        executedAt: new Date(),
      })
      .where(eq(agentActions.actionId, action.actionId));

    return JSON.stringify({
      status: 'error',
      actionId: action.actionId,
      message: `Ошибка при отправке ответа: ${errorMsg}`,
    });
  }
}
