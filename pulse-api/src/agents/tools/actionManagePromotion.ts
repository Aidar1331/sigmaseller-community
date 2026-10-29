/**
 * Tool: action_manage_promotion — Add/remove products from a WB promotion.
 * DANGEROUS: must be invoked ONLY through executeNode after user confirmation.
 *
 * Security contract:
 *  - `_confirmed`/`_userId`/`_shopId`/`_workspaceId` are SERVER-injected by
 *    `graph.ts:executeNode`.
 *  - Lock acquisition lives at graph level — no per-tool locks here.
 */

import { db } from '../../db/client.js';
import { agentActions } from '../../db/schema.js';
import { eq, sql, inArray } from 'drizzle-orm';
import { getWbApiKey } from '../../integrations/wb/wbClient.js';
import { addProductsToPromotion, removeProductsFromPromotion } from '../../integrations/wb/promotions.js';
import { assertAgentAuth } from './locks.js';
import { env } from '../../env.js';
import { enqueueAction } from './actionQueue.js';
import { wbCards } from '../../db/schema.js';

interface ActionManagePromotionArgs {
  promotionId: number;
  action: 'add' | 'remove';
  nmIds: number[];
  rationale: string;
  _workspaceId?: number;
  _shopId?: number;
  _userId?: number;
  // Server-injected by executeNode — never trust values supplied by the LLM.
  _confirmed?: boolean;
}

export async function actionManagePromotion(args: ActionManagePromotionArgs): Promise<string> {
  // Failsafe: must only be reached via graph.executeNode.
  if (args._confirmed !== true) {
    return JSON.stringify({
      status: 'error',
      error: 'action_manage_promotion must be confirmed by the user via executeNode',
    });
  }

  const wsId = args._workspaceId;
  const shopId = args._shopId as number | undefined;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });

  try { await assertAgentAuth(args._userId, wsId); } catch (err: any) { return JSON.stringify({ error: err.message }); }

  // Ownership: every nmId must be in wb_cards for this workspace.
  if (Array.isArray(args.nmIds) && args.nmIds.length > 0) {
    const owned = await db
      .select({ nmId: wbCards.nmId })
      .from(wbCards)
      .where(sql`${wbCards.workspaceId} = ${wsId} AND ${wbCards.nmId} IN ${args.nmIds}`);
    const ownedSet = new Set(owned.map((r) => Number(r.nmId)));
    const foreign = args.nmIds.filter((id) => !ownedSet.has(id));
    if (foreign.length > 0) {
      return JSON.stringify({
        status: 'error',
        error: `Артикулы не найдены в этом workspace: ${foreign.slice(0, 5).join(', ')}${foreign.length > 5 ? '…' : ''}`,
      });
    }
  }

  // Action Queue path
  if (env.ENABLE_ACTION_QUEUE === '1') {
    const enq = await enqueueAction({
      workspaceId: wsId, shopId: args._shopId ?? null, userId: args._userId ?? null, conversationId: null,
      actionType: 'manage_promotion',
      toolArgs: { promotionId: args.promotionId, action: args.action, nmIds: args.nmIds },
      rationale: args.rationale,
    });
    const verb = args.action === 'add' ? 'добавление' : 'удаление';
    return JSON.stringify({
      status: enq.reused ? 'already_queued' : 'queued',
      actionId: enq.actionId,
      message: enq.reused
        ? `Операция уже в очереди [actionId:${enq.actionId}].`
        : `✓ ${verb} ${args.nmIds.length} товар(ов) в акции #${args.promotionId} поставлено в очередь [actionId:${enq.actionId}].`,
    });
  }

  let actionRow: any = null;
  try {
    const apiKey = await getWbApiKey(wsId, shopId);
    if (!apiKey) return JSON.stringify({ error: 'WB API ключ не настроен' });

    [actionRow] = await db.insert(agentActions).values({
      workspaceId: wsId, shopId: args._shopId ?? null, actionType: 'manage_promotion', status: 'pending',
      payload: { promotionId: args.promotionId, action: args.action, nmIds: args.nmIds },
      rationale: args.rationale,
      decidedBy: args._userId ? (BigInt(args._userId) as any) : null, decidedAt: new Date(),
    }).returning();

    if (args.action === 'add') {
      await addProductsToPromotion(apiKey, args.promotionId, args.nmIds);
    } else {
      await removeProductsFromPromotion(apiKey, args.promotionId, args.nmIds);
    }

    await db.update(agentActions).set({ status: 'executed', executedAt: new Date(), completedAt: new Date() }).where(eq(agentActions.actionId, actionRow.actionId));

    const actionText = args.action === 'add' ? 'добавлено в' : 'убрано из';
    return JSON.stringify({
      status: 'success', actionId: Number(actionRow.actionId),
      message: `${args.nmIds.length} товар(ов) ${actionText} акции #${args.promotionId}.`,
    });
  } catch (err: any) {
    if (actionRow?.actionId) {
      await db.update(agentActions).set({ status: 'failed' }).where(eq(agentActions.actionId, actionRow.actionId)).catch(() => {});
    }
    return JSON.stringify({ status: 'failed', error: err.message || 'Ошибка управления акцией' });
  }
}
