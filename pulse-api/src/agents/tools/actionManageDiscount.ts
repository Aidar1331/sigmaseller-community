/**
 * Tool: action_manage_discount — Управление скидками на WB.
 * DANGEROUS: must be invoked ONLY through executeNode after user confirmation.
 *
 * Security contract:
 *  - `_confirmed`/`_userId`/`_shopId`/`_workspaceId` are SERVER-injected by
 *    `graph.ts:executeNode` after `classifyUserDecision` passes.
 *  - Lock acquisition lives at graph level (`executeNode` → `acquireLock`),
 *    so this tool no longer manages locks itself. Fixes the prior race where
 *    the per-tool lock was released before WB API confirmation.
 */

import { db } from '../../db/client.js';
import { agentActions, marketplaceShops } from '../../db/schema.js';
import { eq, sql } from 'drizzle-orm';
import { assertAgentAuth } from './locks.js';
import { env } from '../../env.js';
import { enqueueAction } from './actionQueue.js';

interface ActionManageDiscountArgs {
  nmId: number;
  discountPct: number;      // 0-100
  action: 'set' | 'remove';
  rationale: string;
  _workspaceId?: number;
  _shopId?: number;
  _userId?: number;
  // Server-injected by executeNode — never trust values supplied by the LLM.
  _confirmed?: boolean;
}

export async function actionManageDiscount(args: ActionManageDiscountArgs): Promise<string> {
  // Failsafe: must only be reached via graph.executeNode.
  if (args._confirmed !== true) {
    return JSON.stringify({
      status: 'error',
      error: 'action_manage_discount must be confirmed by the user via executeNode',
    });
  }

  const wsId = args._workspaceId;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });
  await assertAgentAuth(args._userId, wsId);

  // Business rule validation
  if (!args.nmId || args.nmId <= 0) {
    return JSON.stringify({ error: 'Некорректный артикул товара' });
  }
  if (args.action === 'set') {
    if (!Number.isFinite(args.discountPct) || args.discountPct < 0 || args.discountPct > 100) {
      return JSON.stringify({ error: 'Скидка должна быть от 0% до 100%' });
    }
  }

  // Ownership: nmId must be in wb_cards for this workspace (and shop if given).
  const ownedRes = await db.execute<{ exists: number }>(sql`
    SELECT 1 AS exists FROM wb_cards
    WHERE workspace_id = ${wsId} AND nm_id = ${args.nmId}
      ${args._shopId ? sql`AND (shop_id = ${args._shopId} OR shop_id IS NULL)` : sql``}
    LIMIT 1
  `);
  if (!Array.isArray(((ownedRes as any).rows ?? ownedRes)) || (((ownedRes as any).rows ?? ownedRes) as any[]).length === 0) {
    return JSON.stringify({ status: 'error', error: `Артикул ${args.nmId} не найден в карточках этого workspace.` });
  }

  // Action Queue path
  if (env.ENABLE_ACTION_QUEUE === '1') {
    const enq = await enqueueAction({
      workspaceId: wsId, shopId: args._shopId ?? null, userId: args._userId ?? null, conversationId: null,
      actionType: 'manage_discount',
      toolArgs: { nmId: args.nmId, discountPct: args.discountPct, operation: args.action },
      rationale: args.rationale,
    });
    return JSON.stringify({
      status: enq.reused ? 'already_queued' : 'queued',
      actionId: enq.actionId,
      message: enq.reused
        ? `Изменение скидки для ${args.nmId} уже в очереди [actionId:${enq.actionId}].`
        : `✓ Изменение скидки для ${args.nmId} поставлено в очередь [actionId:${enq.actionId}].`,
    });
  }

  // Get shop API key
  const [shop] = await db
    .select({ apiKey: marketplaceShops.apiKey })
    .from(marketplaceShops)
    .where(eq(marketplaceShops.workspaceId, wsId))
    .limit(1);

  if (!shop?.apiKey) {
    return JSON.stringify({ status: 'error', message: 'API ключ магазина не найден' });
  }

  // Log action
  const [action] = await db.insert(agentActions).values({
    workspaceId: wsId,
    shopId: args._shopId ?? null,
    actionType: 'manage_discount',
    status: 'pending',
    payload: { nmId: args.nmId, discountPct: args.discountPct, operation: args.action },
    rationale: args.rationale,
    decidedBy: args._userId ? BigInt(args._userId) as any : null,
    decidedAt: new Date(),
  }).returning();

  try {
    const url = args.action === 'set'
      ? 'https://discounts-prices-api.wildberries.ru/api/v2/upload/task'
      : 'https://discounts-prices-api.wildberries.ru/api/v2/upload/task';

    const payload = {
      data: [{
        nmID: args.nmId,
        discount: args.action === 'set' ? args.discountPct : 0,
      }],
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: shop.apiKey,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errText = await response.text();
      await db.update(agentActions)
        .set({ status: 'failed', result: { error: errText }, executedAt: new Date() })
        .where(eq(agentActions.actionId, action.actionId));

      return JSON.stringify({ status: 'error', message: `WB API ошибка: ${errText}` });
    }

    await db.update(agentActions)
      .set({ status: 'executed', result: { success: true }, executedAt: new Date(), completedAt: new Date() })
      .where(eq(agentActions.actionId, action.actionId));

    const successMsg = args.action === 'set'
      ? `Скидка ${args.discountPct}% установлена на товар ${args.nmId}`
      : `Скидка убрана с товара ${args.nmId}`;

    return JSON.stringify({ status: 'success', actionId: action.actionId, message: successMsg });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    await db.update(agentActions)
      .set({ status: 'failed', result: { error: errorMsg }, executedAt: new Date() })
      .where(eq(agentActions.actionId, action.actionId));

    return JSON.stringify({ status: 'error', message: `Ошибка: ${errorMsg}` });
  }
}
