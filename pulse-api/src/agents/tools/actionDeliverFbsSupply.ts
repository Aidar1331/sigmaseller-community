/**
 * Tool `action_deliver_fbs_supply` — закрывает FBS-поставку на отправку
 * (PATCH /api/v3/supplies/{supplyId}/deliver). После этого статус становится
 * `done=true`, и поставку нельзя редактировать.
 *
 * DANGEROUS: must be invoked ONLY through executeNode after user confirmation.
 */

import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { agentActions, wbFbsSupplies } from '../../db/schema.js';
import { getWbApiKey } from '../../integrations/wb/wbClient.js';
import { closeSupply } from '../../integrations/wb/marketplace/client.js';
import { assertAgentAuth } from './locks.js';
import { env } from '../../env.js';
import { enqueueAction } from './actionQueue.js';
import { log } from '../../lib/logger.js';

const logger = log.child({ module: 'actionDeliverFbsSupply' });

export interface ActionDeliverFbsSupplyArgs {
  /** Внутренний id из wb_fbs_supplies (НЕ WB supplyId). */
  fbsSupplyPk?: number;
  /** Альтернатива: WB supplyId 'WB-GI-XXXX'. */
  wbSupplyId?: string;
  rationale: string;
  _workspaceId?: number;
  _shopId?: number;
  _userId?: number;
  _confirmed?: boolean;
}

export async function actionDeliverFbsSupply(
  args: ActionDeliverFbsSupplyArgs,
): Promise<string> {
  if (args._confirmed !== true) {
    return JSON.stringify({
      status: 'error',
      error: 'action_deliver_fbs_supply must be confirmed via executeNode',
    });
  }
  const wsId = args._workspaceId;
  const shopId = args._shopId as number | undefined;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });
  if (!shopId) return JSON.stringify({ error: 'shopId required' });
  if (!args.fbsSupplyPk && !args.wbSupplyId) {
    return JSON.stringify({ error: 'fbsSupplyPk or wbSupplyId required' });
  }

  try {
    await assertAgentAuth(args._userId, wsId);
  } catch (err: any) {
    return JSON.stringify({ error: err.message });
  }

  // Resolve wbSupplyId from local PK if needed
  let resolvedSupplyId = args.wbSupplyId;
  let pk = args.fbsSupplyPk;
  if (!resolvedSupplyId && pk) {
    const [row] = await db
      .select({ wbSupplyId: wbFbsSupplies.wbSupplyId, workspaceId: wbFbsSupplies.workspaceId })
      .from(wbFbsSupplies)
      .where(eq(wbFbsSupplies.id, pk))
      .limit(1);
    if (!row) return JSON.stringify({ error: `FBS supply pk=${pk} not found` });
    if (Number(row.workspaceId) !== wsId) {
      return JSON.stringify({ error: 'FBS supply belongs to a different workspace' });
    }
    resolvedSupplyId = row.wbSupplyId;
  }
  if (!resolvedSupplyId) return JSON.stringify({ error: 'wbSupplyId unresolved' });

  if (env.ENABLE_ACTION_QUEUE === '1') {
    const enq = await enqueueAction({
      workspaceId: wsId,
      shopId: shopId,
      userId: args._userId ?? null,
      conversationId: null,
      actionType: 'deliver_fbs_supply',
      toolArgs: { wbSupplyId: resolvedSupplyId, fbsSupplyPk: pk },
      rationale: args.rationale,
      turnId: `deliver-${resolvedSupplyId}`,
    });
    return JSON.stringify({
      status: enq.reused ? 'already_queued' : 'queued',
      actionId: enq.actionId,
      message: enq.reused
        ? `Отгрузка FBS-поставки ${resolvedSupplyId} уже в очереди [actionId:${enq.actionId}].`
        : `✓ Отгрузка FBS-поставки ${resolvedSupplyId} поставлена в очередь [actionId:${enq.actionId}].`,
    });
  }

  let action: any = null;
  try {
    const apiKey = await getWbApiKey(wsId, shopId);
    if (!apiKey) return JSON.stringify({ error: 'WB API ключ не настроен' });

    [action] = await db
      .insert(agentActions)
      .values({
        workspaceId: wsId,
        shopId: shopId,
        actionType: 'deliver_fbs_supply',
        status: 'pending',
        payload: { wbSupplyId: resolvedSupplyId, fbsSupplyPk: pk ?? null },
        rationale: args.rationale,
        decidedBy: args._userId ? (BigInt(args._userId) as any) : null,
        decidedAt: new Date(),
      })
      .returning();

    await closeSupply(apiKey, resolvedSupplyId);

    if (pk) {
      await db
        .update(wbFbsSupplies)
        .set({ done: true, closedAt: new Date(), updatedAt: new Date() })
        .where(eq(wbFbsSupplies.id, pk));
    } else {
      await db
        .update(wbFbsSupplies)
        .set({ done: true, closedAt: new Date(), updatedAt: new Date() })
        .where(eq(wbFbsSupplies.wbSupplyId, resolvedSupplyId));
    }

    await db
      .update(agentActions)
      .set({
        status: 'executed',
        executedAt: new Date(),
        completedAt: new Date(),
        result: { wbSupplyId: resolvedSupplyId, deliveredAt: new Date().toISOString() },
      })
      .where(eq(agentActions.actionId, action.actionId));

    return JSON.stringify({
      status: 'success',
      actionId: Number(action.actionId),
      wbSupplyId: resolvedSupplyId,
      message: `✅ FBS-поставка ${resolvedSupplyId} закрыта на отправку. Следующий шаг — выписать пропуск через action_create_pass.`,
    });
  } catch (err: any) {
    if (action?.actionId) {
      await db
        .update(agentActions)
        .set({ status: 'failed' })
        .where(eq(agentActions.actionId, action.actionId))
        .catch(() => {});
    }
    logger.error(
      { err: err.message, wsId, shopId, wbSupplyId: resolvedSupplyId },
      'actionDeliverFbsSupply failed',
    );
    return JSON.stringify({
      status: 'failed',
      error: err.message || 'Ошибка отгрузки FBS-поставки',
    });
  }
}
