/**
 * Tool: action_confirm_fbs_order — Confirm assembly of an FBS order on WB.
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
import { getWbApiKey } from '../../integrations/wb/wbClient.js';
import { confirmOrder } from '../../integrations/wb/marketplace/client.js';
import { assertAgentAuth } from './locks.js';
import { env } from '../../env.js';
import { enqueueAction } from './actionQueue.js';

interface ActionConfirmFbsOrderArgs {
  orderId: number;
  rationale: string;
  _workspaceId?: number;
  _shopId?: number;
  _userId?: number;
  // Server-injected by executeNode — never trust values supplied by the LLM.
  _confirmed?: boolean;
}

export async function actionConfirmFbsOrder(args: ActionConfirmFbsOrderArgs): Promise<string> {
  // Failsafe: must only be reached via graph.executeNode.
  if (args._confirmed !== true) {
    return JSON.stringify({
      status: 'error',
      error: 'action_confirm_fbs_order must be confirmed by the user via executeNode',
    });
  }

  const wsId = args._workspaceId;
  const shopId = args._shopId as number | undefined;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });

  try { await assertAgentAuth(args._userId, wsId); } catch (err: any) { return JSON.stringify({ error: err.message }); }

  // Ownership: best-effort check against wb_fbs_orders if it exists.
  // Table may not be populated for fresh shops — soft check, log on miss but allow.
  try {
    const ownedRes = await db.execute<{ exists: number }>(sql`
      SELECT 1 AS exists FROM wb_fbs_orders
      WHERE workspace_id = ${wsId} AND order_id = ${args.orderId}
      LIMIT 1
    `);
    const rows = (ownedRes as any).rows ?? ownedRes;
    if (Array.isArray(rows) && rows.length === 0) {
      // Soft fail: order may be too recent to be in our cache. Log + proceed.
      // Strict-fail later when fbs_orders sync is reliable.
      console.warn(`[confirmFbsOrder] orderId=${args.orderId} not in wb_fbs_orders cache for ws=${wsId}`);
    }
  } catch {
    // Table missing entirely — skip ownership check, fall through.
  }

  // Action Queue path
  if (env.ENABLE_ACTION_QUEUE === '1') {
    const enq = await enqueueAction({
      workspaceId: wsId, shopId: args._shopId ?? null, userId: args._userId ?? null, conversationId: null,
      actionType: 'confirm_fbs_order',
      toolArgs: { orderId: args.orderId },
      rationale: args.rationale,
    });
    return JSON.stringify({
      status: enq.reused ? 'already_queued' : 'queued',
      actionId: enq.actionId,
      message: enq.reused
        ? `Подтверждение FBS-заказа ${args.orderId} уже в очереди [actionId:${enq.actionId}].`
        : `✓ Подтверждение FBS-заказа ${args.orderId} поставлено в очередь [actionId:${enq.actionId}].`,
    });
  }

  let action: any = null;
  try {
    const apiKey = await getWbApiKey(wsId, shopId);
    if (!apiKey) return JSON.stringify({ error: 'WB API ключ не настроен' });

    [action] = await db.insert(agentActions).values({
      workspaceId: wsId, shopId: args._shopId ?? null, actionType: 'confirm_fbs_order', status: 'pending',
      payload: { orderId: args.orderId }, rationale: args.rationale,
      decidedBy: args._userId ? (BigInt(args._userId) as any) : null, decidedAt: new Date(),
    }).returning();

    await confirmOrder(apiKey, args.orderId);

    await db.update(agentActions).set({ status: 'executed', executedAt: new Date(), completedAt: new Date() }).where(eq(agentActions.actionId, action.actionId));

    return JSON.stringify({ status: 'success', actionId: Number(action.actionId), message: `FBS заказ #${args.orderId} подтверждён.` });
  } catch (err: any) {
    if (action?.actionId) {
      await db.update(agentActions).set({ status: 'failed' }).where(eq(agentActions.actionId, action.actionId)).catch(() => {});
    }
    return JSON.stringify({ status: 'failed', error: err.message || 'Ошибка подтверждения заказа' });
  }
}
