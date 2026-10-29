/**
 * Tool `action_create_fbs_supply` — создаёт FBS-поставку на WB
 * (POST /api/v3/supplies на marketplace-api) и сразу добавляет в неё
 * перечисленные `orderIds` через `PUT /api/v3/supplies/{id}/orders/{orderId}`.
 *
 * DANGEROUS: must be invoked ONLY through executeNode after user confirmation.
 *
 * После успеха AI может вызвать:
 *  - action_get_fbs_supply_barcode → штрихкод поставки (для печати)
 *  - action_deliver_fbs_supply → закрыть на отправку
 *
 * Security contract: `_confirmed`/`_userId`/`_shopId`/`_workspaceId` server-injected.
 */

import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  agentActions,
  wbFbsSupplies,
  wbFbsSupplyOrders,
} from '../../db/schema.js';
import { getWbApiKey } from '../../integrations/wb/wbClient.js';
import {
  createSupply as marketplaceCreateSupply,
  addOrderToSupply,
} from '../../integrations/wb/marketplace/client.js';
import { assertAgentAuth } from './locks.js';
import { env } from '../../env.js';
import { enqueueAction } from './actionQueue.js';
import { log } from '../../lib/logger.js';

const logger = log.child({ module: 'actionCreateFbsSupply' });

export interface ActionCreateFbsSupplyArgs {
  /** Имя поставки (опционально). Если пусто — WB присвоит дату. */
  name?: string;
  /** Список FBS-orderId, которые нужно добавить в поставку. */
  orderIds: number[];
  rationale: string;
  _workspaceId?: number;
  _shopId?: number;
  _userId?: number;
  _confirmed?: boolean;
}

export async function actionCreateFbsSupply(
  args: ActionCreateFbsSupplyArgs,
): Promise<string> {
  if (args._confirmed !== true) {
    return JSON.stringify({
      status: 'error',
      error: 'action_create_fbs_supply must be confirmed by the user via executeNode',
    });
  }

  const wsId = args._workspaceId;
  const shopId = args._shopId as number | undefined;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });
  // shopId обязателен — иначе getWbApiKey(ws) возьмёт ЛЮБОЙ токен workspace'а
  // и WB вернёт заказы другого магазина → shop-leak.
  if (!shopId) {
    return JSON.stringify({
      error: 'shopId is required. Ask the user to select a shop before creating FBS supply.',
    });
  }
  if (!args.orderIds || args.orderIds.length === 0) {
    return JSON.stringify({ error: 'orderIds is required and must contain at least 1 element' });
  }
  if (args.orderIds.length > 1000) {
    return JSON.stringify({ error: 'WB FBS supply supports up to 1000 orders per supply' });
  }

  try {
    await assertAgentAuth(args._userId, wsId);
  } catch (err: any) {
    return JSON.stringify({ error: err.message });
  }

  // Queue path
  if (env.ENABLE_ACTION_QUEUE === '1') {
    const enq = await enqueueAction({
      workspaceId: wsId,
      shopId: shopId,
      userId: args._userId ?? null,
      conversationId: null,
      actionType: 'create_fbs_supply',
      toolArgs: { name: args.name, orderIds: args.orderIds },
      rationale: args.rationale,
      turnId: `fbs-${args.orderIds.slice(0, 3).join('-')}-${args.orderIds.length}`,
    });
    return JSON.stringify({
      status: enq.reused ? 'already_queued' : 'queued',
      actionId: enq.actionId,
      message: enq.reused
        ? `Создание FBS-поставки уже в очереди [actionId:${enq.actionId}].`
        : `✓ Создание FBS-поставки (${args.orderIds.length} заказов) поставлено в очередь [actionId:${enq.actionId}].`,
    });
  }

  // Inline path
  let action: any = null;
  let supplyId: string | null = null;
  try {
    const apiKey = await getWbApiKey(wsId, shopId);
    if (!apiKey) return JSON.stringify({ error: 'WB API ключ не настроен' });

    [action] = await db
      .insert(agentActions)
      .values({
        workspaceId: wsId,
        shopId: shopId,
        actionType: 'create_fbs_supply',
        status: 'pending',
        payload: {
          name: args.name,
          ordersCount: args.orderIds.length,
        },
        rationale: args.rationale,
        decidedBy: args._userId ? (BigInt(args._userId) as any) : null,
        decidedAt: new Date(),
      })
      .returning();

    // 1) Create empty supply
    const supplyName = args.name ?? new Date().toISOString().slice(0, 10);
    const created = await marketplaceCreateSupply(apiKey, supplyName);
    supplyId = (created as any).id ?? (created as any).supplyId ?? null;
    if (!supplyId) {
      throw new Error(`WB вернул supply без id: ${JSON.stringify(created).slice(0, 200)}`);
    }

    // 2) Mirror in DB
    const [mirror] = await db
      .insert(wbFbsSupplies)
      .values({
        workspaceId: wsId,
        shopId: shopId,
        wbSupplyId: supplyId,
        name: supplyName,
        ordersCount: 0,
      })
      .returning();

    // 3) Add orders (sequential to avoid burst; WB лимит 100/min на endpoint).
    const addedOrders: number[] = [];
    const errors: Array<{ orderId: number; error: string }> = [];
    for (const orderId of args.orderIds) {
      try {
        await addOrderToSupply(apiKey, supplyId, orderId);
        addedOrders.push(orderId);
      } catch (err: any) {
        errors.push({ orderId, error: String(err?.message ?? err) });
        logger.warn(
          { wsId, shopId, supplyId, orderId, err: err?.message },
          'addOrderToSupply failed (continuing)',
        );
      }
    }

    // 4) Mirror orders
    if (addedOrders.length > 0) {
      await db
        .insert(wbFbsSupplyOrders)
        .values(
          addedOrders.map((orderId) => ({
            fbsSupplyPk: mirror.id,
            wbOrderId: orderId,
            status: 'added',
          })),
        )
        .onConflictDoNothing();
      await db
        .update(wbFbsSupplies)
        .set({ ordersCount: addedOrders.length, updatedAt: new Date() })
        .where(eq(wbFbsSupplies.id, mirror.id));
    }

    await db
      .update(agentActions)
      .set({
        status: 'executed',
        executedAt: new Date(),
        completedAt: new Date(),
        result: {
          wbSupplyId: supplyId,
          fbsSupplyPk: mirror.id,
          addedCount: addedOrders.length,
          errorsCount: errors.length,
        },
      })
      .where(eq(agentActions.actionId, action.actionId));

    const message =
      errors.length === 0
        ? `✅ FBS-поставка ${supplyId} создана, добавлено ${addedOrders.length} заказов. Следующий шаг — action_get_fbs_supply_barcode для печати или action_deliver_fbs_supply для отгрузки.`
        : `⚠️ FBS-поставка ${supplyId} создана. Успешно добавлено ${addedOrders.length} из ${args.orderIds.length} заказов. ${errors.length} не добавились.`;

    return JSON.stringify({
      status: errors.length === 0 ? 'success' : 'partial',
      actionId: Number(action.actionId),
      wbSupplyId: supplyId,
      fbsSupplyPk: mirror.id,
      addedCount: addedOrders.length,
      errors: errors.slice(0, 10),
      message,
    });
  } catch (err: any) {
    if (action?.actionId) {
      await db
        .update(agentActions)
        .set({ status: 'failed' })
        .where(eq(agentActions.actionId, action.actionId))
        .catch(() => {});
    }
    logger.error({ err: err.message, wsId, shopId }, 'actionCreateFbsSupply failed');
    return JSON.stringify({
      status: 'failed',
      error: err.message || 'Ошибка создания FBS-поставки',
    });
  }
}
