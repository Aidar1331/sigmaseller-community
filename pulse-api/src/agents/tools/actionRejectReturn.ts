/**
 * Tool: action_reject_return — Reject a customer return on Wildberries.
 * DANGEROUS: must be invoked ONLY through executeNode after user confirmation.
 *
 * WB endpoint: PATCH /api/v1/returns/{returnId}/reject (feedbacks-api).
 */

import { db } from '../../db/client.js';
import { agentActions, wbReturns } from '../../db/schema.js';
import { eq, and, sql } from 'drizzle-orm';
import { rejectReturn } from '../../integrations/wb/returns.js';
import { getWbApiKey } from '../../integrations/wb/wbClient.js';
import { assertAgentAuth } from './locks.js';
import { env } from '../../env.js';
import { enqueueAction } from './actionQueue.js';

interface ActionRejectReturnArgs {
  returnId: number;
  reason: string;
  comment?: string;
  _workspaceId?: number;
  _shopId?: number;
  _userId?: number;
  _confirmed?: boolean;
}

export async function actionRejectReturn(args: ActionRejectReturnArgs): Promise<string> {
  if (args._confirmed !== true) {
    return JSON.stringify({
      status: 'error',
      error: 'action_reject_return must be confirmed by the user via executeNode',
    });
  }

  const wsId = args._workspaceId;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });
  await assertAgentAuth(args._userId, wsId);

  if (!Number.isFinite(args.returnId) || args.returnId <= 0) {
    return JSON.stringify({ status: 'error', error: 'returnId must be a positive number' });
  }
  if (!args.reason || args.reason.trim().length < 3) {
    return JSON.stringify({
      status: 'error',
      error: 'reason обязателен и не может быть пустым (минимум 3 символа)',
    });
  }

  const owned = await db
    .select({ id: wbReturns.id, shopId: wbReturns.shopId, status: wbReturns.status })
    .from(wbReturns)
    .where(and(eq(wbReturns.workspaceId, wsId), eq(wbReturns.returnId, args.returnId)))
    .limit(1);

  if (owned.length === 0) {
    return JSON.stringify({
      status: 'error',
      error: `Возврат ${args.returnId} не найден в этом workspace.`,
    });
  }
  const returnShopId = owned[0].shopId;

  if (owned[0].status === 'rejected') {
    return 'Возврат уже отклонён ранее.';
  }
  const existing = await db
    .select({ id: agentActions.actionId })
    .from(agentActions)
    .where(
      and(
        eq(agentActions.workspaceId, wsId),
        eq(agentActions.actionType, 'reject_return'),
        sql`(${agentActions.payload}->>'returnId')::bigint = ${args.returnId}`,
        eq(agentActions.status, 'executed'),
      ),
    )
    .limit(1);
  if (existing.length > 0) {
    return 'Возврат уже был отклонён через AI ранее.';
  }

  if (env.ENABLE_ACTION_QUEUE === '1') {
    const enq = await enqueueAction({
      workspaceId: wsId,
      shopId: returnShopId ?? args._shopId ?? null,
      userId: args._userId ?? null,
      conversationId: null,
      actionType: 'reject_return',
      toolArgs: { returnId: args.returnId, reason: args.reason, comment: args.comment ?? null },
      rationale: `Отклонение возврата: ${args.reason}`,
    });
    return JSON.stringify({
      status: enq.reused ? 'already_queued' : 'queued',
      actionId: enq.actionId,
      message: enq.reused
        ? `Возврат ${args.returnId} уже в очереди [actionId:${enq.actionId}].`
        : `✓ Возврат ${args.returnId} поставлен в очередь на отклонение [actionId:${enq.actionId}].`,
    });
  }

  const [action] = await db
    .insert(agentActions)
    .values({
      workspaceId: wsId,
      shopId: returnShopId ?? args._shopId ?? null,
      actionType: 'reject_return',
      status: 'pending',
      payload: { returnId: args.returnId, reason: args.reason, comment: args.comment ?? null },
      rationale: `Отклонение возврата: ${args.reason}`,
      decidedBy: args._userId ? (BigInt(args._userId) as any) : null,
      decidedAt: new Date(),
    })
    .returning();

  try {
    const apiKey = await getWbApiKey(wsId, returnShopId ?? args._shopId ?? undefined);
    if (!apiKey) throw new Error('WB API key not found for this shop');

    const result = await rejectReturn(apiKey, {
      returnId: args.returnId,
      reason: args.reason,
      comment: args.comment,
    });

    if (!result.success) {
      await db
        .update(agentActions)
        .set({ status: 'failed', result, executedAt: new Date() })
        .where(eq(agentActions.actionId, action.actionId));
      return JSON.stringify({
        status: 'error',
        actionId: action.actionId,
        message: 'WB вернул ответ без success=true',
      });
    }

    await db
      .update(wbReturns)
      .set({ status: 'rejected', rejectedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(wbReturns.workspaceId, wsId), eq(wbReturns.returnId, args.returnId)));

    await db
      .update(agentActions)
      .set({ status: 'executed', executedAt: new Date(), completedAt: new Date(), result })
      .where(eq(agentActions.actionId, action.actionId));

    return JSON.stringify({
      status: 'success',
      actionId: action.actionId,
      message: `✅ Возврат ${args.returnId} отклонён (причина: ${args.reason})`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    await db
      .update(agentActions)
      .set({ status: 'failed', result: { error: msg }, executedAt: new Date() })
      .where(eq(agentActions.actionId, action.actionId));
    return JSON.stringify({
      status: 'error',
      actionId: action.actionId,
      message: `Ошибка отклонения возврата: ${msg}`,
    });
  }
}
