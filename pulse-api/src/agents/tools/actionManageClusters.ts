/**
 * Tool: action_manage_clusters — Управление поисковыми кластерами рекламы.
 * DANGEROUS: must be invoked ONLY through executeNode after user confirmation.
 * Manages minus-phrases and cluster bids for ad campaigns.
 *
 * Security contract:
 *  - `_confirmed`/`_userId`/`_shopId`/`_workspaceId` are SERVER-injected by
 *    `graph.ts:executeNode` after `classifyUserDecision` passes.
 *  - Lock acquisition lives at graph level (see `tools/locks.ts`), so this
 *    tool no longer manages locks itself.
 */

import { db } from '../../db/client.js';
import { agentActions, marketplaceShops, wbCampaigns } from '../../db/schema.js';
import { eq, and, sql } from 'drizzle-orm';
import { assertAgentAuth } from './locks.js';
import { env } from '../../env.js';
import { enqueueAction } from './actionQueue.js';

interface ActionManageClustersArgs {
  campaignId: number;
  action: 'set_minus' | 'set_bid';
  minusPhrases?: string[];          // For set_minus
  clusterBids?: Array<{ cluster: string; bidKop: number }>; // For set_bid
  rationale: string;
  _workspaceId?: number;
  _shopId?: number;
  _userId?: number;
  // Server-injected by executeNode — never trust values supplied by the LLM.
  _confirmed?: boolean;
}

export async function actionManageClusters(args: ActionManageClustersArgs): Promise<string> {
  // Failsafe: must only be reached via graph.executeNode (sets _confirmed=true
  // after the user explicitly approved). Direct invocation is refused.
  if (args._confirmed !== true) {
    return JSON.stringify({
      status: 'error',
      error: 'action_manage_clusters must be confirmed by the user via executeNode',
    });
  }

  const wsId = args._workspaceId;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });
  await assertAgentAuth(args._userId, wsId);

  // Ownership: campaign must belong to this workspace.
  const ownedCamp = await db
    .select({ campaignId: wbCampaigns.campaignId })
    .from(wbCampaigns)
    .where(and(eq(wbCampaigns.workspaceId, wsId), eq(wbCampaigns.campaignId, args.campaignId)))
    .limit(1);
  if (ownedCamp.length === 0) {
    return JSON.stringify({ status: 'error', error: `Кампания ${args.campaignId} не найдена в этом workspace.` });
  }

  // Action Queue path
  if (env.ENABLE_ACTION_QUEUE === '1') {
    const enq = await enqueueAction({
      workspaceId: wsId, shopId: args._shopId ?? null, userId: args._userId ?? null, conversationId: null,
      actionType: 'manage_clusters',
      toolArgs: { campaignId: args.campaignId, action: args.action, minusPhrases: args.minusPhrases, clusterBids: args.clusterBids },
      rationale: args.rationale,
    });
    return JSON.stringify({
      status: enq.reused ? 'already_queued' : 'queued',
      actionId: enq.actionId,
      message: enq.reused
        ? `Управление кластерами кампании ${args.campaignId} уже в очереди [actionId:${enq.actionId}].`
        : `✓ Управление кластерами (${args.action}) кампании ${args.campaignId} поставлено в очередь [actionId:${enq.actionId}].`,
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
  const [actionRecord] = await db.insert(agentActions).values({
    workspaceId: wsId,
    shopId: args._shopId ?? null,
    actionType: 'manage_clusters',
    status: 'pending',
    payload: {
      campaignId: args.campaignId,
      operation: args.action,
      minusPhrases: args.minusPhrases,
      clusterBids: args.clusterBids,
    },
    rationale: args.rationale,
    decidedBy: args._userId ? BigInt(args._userId) as any : null,
    decidedAt: new Date(),
  }).returning();

  try {
    let url: string;
    let body: any;

    if (args.action === 'set_minus') {
      url = 'https://advert-api.wildberries.ru/adv/v0/normquery/set-minus';
      body = {
        id: args.campaignId,
        phrases: args.minusPhrases ?? [],
      };
    } else {
      url = 'https://advert-api.wildberries.ru/adv/v0/normquery/bids';
      body = {
        id: args.campaignId,
        bids: (args.clusterBids ?? []).map((b) => ({
          normquery: b.cluster,
          bid: b.bidKop,
        })),
      };
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: shop.apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      await db.update(agentActions)
        .set({ status: 'failed', result: { error: errText }, executedAt: new Date() })
        .where(eq(agentActions.actionId, actionRecord.actionId));

      return JSON.stringify({ status: 'error', message: `WB API ошибка: ${errText}` });
    }

    await db.update(agentActions)
      .set({ status: 'executed', result: { success: true }, executedAt: new Date(), completedAt: new Date() })
      .where(eq(agentActions.actionId, actionRecord.actionId));

    const successMsg = args.action === 'set_minus'
      ? `Минус-фразы установлены для кампании ${args.campaignId}`
      : `Ставки кластеров обновлены для кампании ${args.campaignId}`;

    return JSON.stringify({ status: 'success', actionId: actionRecord.actionId, message: successMsg });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    await db.update(agentActions)
      .set({ status: 'failed', result: { error: errorMsg }, executedAt: new Date() })
      .where(eq(agentActions.actionId, actionRecord.actionId));

    return JSON.stringify({ status: 'error', message: `Ошибка: ${errorMsg}` });
  }
}
