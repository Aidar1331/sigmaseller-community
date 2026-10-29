/**
 * Tool: action_update_card — SEO-оптимизация карточки товара на WB.
 * DANGEROUS: must be invoked ONLY through executeNode after user confirmation.
 *
 * Security contract:
 *  - `_confirmed`/`_userId`/`_shopId`/`_workspaceId` are SERVER-injected by
 *    `graph.ts:executeNode`.
 *  - Lock acquisition lives at graph level — no per-tool locks.
 *  - Ownership check: card must exist in this workspace's wbCards.
 */

import { db } from '../../db/client.js';
import { agentActions, marketplaceShops, wbCards } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { assertAgentAuth } from './locks.js';
import { env } from '../../env.js';
import { enqueueAction } from './actionQueue.js';

interface ActionUpdateCardArgs {
  nmId: number;
  title?: string;
  description?: string;
  rationale: string;
  _workspaceId?: number;
  _shopId?: number;
  _userId?: number;
  // Server-injected by executeNode — never trust values supplied by the LLM.
  _confirmed?: boolean;
}

export async function actionUpdateCard(args: ActionUpdateCardArgs): Promise<string> {
  // Failsafe: must only be reached via graph.executeNode.
  if (args._confirmed !== true) {
    return JSON.stringify({
      status: 'error',
      error: 'action_update_card must be confirmed by the user via executeNode',
    });
  }

  const wsId = args._workspaceId;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });
  await assertAgentAuth(args._userId, wsId);

  if (!args.title && !args.description) {
    return JSON.stringify({ error: 'Нужно указать title или description для обновления' });
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

  // Get current card data
  const [card] = await db
    .select({ raw: wbCards.raw })
    .from(wbCards)
    .where(and(eq(wbCards.workspaceId, wsId), eq(wbCards.nmId, args.nmId)))
    .limit(1);

  if (!card) {
    return JSON.stringify({ status: 'error', message: `Карточка ${args.nmId} не найдена` });
  }

  // Action Queue path (ownership already verified above via wb_cards lookup)
  if (env.ENABLE_ACTION_QUEUE === '1') {
    const enq = await enqueueAction({
      workspaceId: wsId, shopId: args._shopId ?? null, userId: args._userId ?? null, conversationId: null,
      actionType: 'update_card',
      toolArgs: { nmId: args.nmId, title: args.title, description: args.description },
      rationale: args.rationale,
    });
    return JSON.stringify({
      status: enq.reused ? 'already_queued' : 'queued',
      actionId: enq.actionId,
      message: enq.reused
        ? `Обновление карточки ${args.nmId} уже в очереди [actionId:${enq.actionId}].`
        : `✓ Обновление карточки ${args.nmId} поставлено в очередь [actionId:${enq.actionId}].`,
    });
  }

  // Log action
  const [action] = await db.insert(agentActions).values({
    workspaceId: wsId,
    shopId: args._shopId ?? null,
    actionType: 'update_card',
    status: 'pending',
    payload: { nmId: args.nmId, title: args.title, description: args.description },
    rationale: args.rationale,
    decidedBy: args._userId ? BigInt(args._userId) as any : null,
    decidedAt: new Date(),
  }).returning();

  try {
    // Build PATCH payload for WB Content API
    const cardData = card.raw as any;
    const patchPayload: any = {
      nmID: args.nmId,
      vendorCode: cardData?.vendorCode,
    };

    if (args.title) patchPayload.title = args.title;
    if (args.description) patchPayload.description = args.description;

    const response = await fetch('https://content-api.wildberries.ru/content/v2/cards/update', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: shop.apiKey,
      },
      body: JSON.stringify([patchPayload]),
    });

    if (!response.ok) {
      const errText = await response.text();
      await db.update(agentActions)
        .set({ status: 'failed', result: { error: errText }, executedAt: new Date() })
        .where(eq(agentActions.actionId, action.actionId));

      return JSON.stringify({ status: 'error', message: `WB API ошибка: ${errText}` });
    }

    // Update local card cache
    const updatedRaw = { ...cardData };
    if (args.title) updatedRaw.title = args.title;
    if (args.description) updatedRaw.description = args.description;

    await db.update(wbCards)
      .set({ raw: updatedRaw, title: args.title ?? cardData.title })
      .where(and(eq(wbCards.workspaceId, wsId), eq(wbCards.nmId, args.nmId)));

    await db.update(agentActions)
      .set({ status: 'executed', result: { success: true }, executedAt: new Date(), completedAt: new Date() })
      .where(eq(agentActions.actionId, action.actionId));

    return JSON.stringify({
      status: 'success',
      actionId: action.actionId,
      message: `Карточка ${args.nmId} обновлена`,
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    await db.update(agentActions)
      .set({ status: 'failed', result: { error: errorMsg }, executedAt: new Date() })
      .where(eq(agentActions.actionId, action.actionId));

    return JSON.stringify({ status: 'error', message: `Ошибка: ${errorMsg}` });
  }
}
