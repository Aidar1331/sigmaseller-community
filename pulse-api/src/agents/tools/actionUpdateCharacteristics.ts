/**
 * Tool: action_update_characteristics — Update card characteristics on WB.
 * DANGEROUS: must be invoked ONLY through executeNode after user confirmation.
 *
 * Security contract:
 *  - `_confirmed`/`_userId`/`_shopId`/`_workspaceId` are SERVER-injected by
 *    `graph.ts:executeNode`.
 *  - Lock acquisition lives at graph level — no per-tool locks here.
 */

import { db } from '../../db/client.js';
import { agentActions, wbCards } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { getWbApiKey } from '../../integrations/wb/wbClient.js';
import { safeUpdateCard } from '../../integrations/wb/content.js';
import { assertAgentAuth } from './locks.js';
import { env } from '../../env.js';
import { enqueueAction } from './actionQueue.js';

interface ActionUpdateCharacteristicsArgs {
  nmId: number;
  characteristics: Array<{ id: number; value: string | string[] }>;
  title?: string;
  description?: string;
  rationale: string;
  _workspaceId?: number;
  _shopId?: number;
  _userId?: number;
  // Server-injected by executeNode — never trust values supplied by the LLM.
  _confirmed?: boolean;
}

export async function actionUpdateCharacteristics(args: ActionUpdateCharacteristicsArgs): Promise<string> {
  // Failsafe: must only be reached via graph.executeNode.
  if (args._confirmed !== true) {
    return JSON.stringify({
      status: 'error',
      error: 'action_update_characteristics must be confirmed by the user via executeNode',
    });
  }

  const wsId = args._workspaceId;
  const shopId = args._shopId as number | undefined;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });

  try {
    await assertAgentAuth(args._userId, wsId);
  } catch (err: any) {
    return JSON.stringify({ error: err.message });
  }

  // Ownership: nmId must exist in wb_cards for this workspace.
  const ownedCard = await db
    .select({ nmId: wbCards.nmId })
    .from(wbCards)
    .where(and(eq(wbCards.workspaceId, wsId), eq(wbCards.nmId, args.nmId)))
    .limit(1);
  if (ownedCard.length === 0) {
    return JSON.stringify({ status: 'error', error: `Карточка ${args.nmId} не найдена в этом workspace.` });
  }

  // Action Queue path
  if (env.ENABLE_ACTION_QUEUE === '1') {
    const enq = await enqueueAction({
      workspaceId: wsId, shopId: args._shopId ?? null, userId: args._userId ?? null, conversationId: null,
      actionType: 'update_characteristics',
      toolArgs: { nmId: args.nmId, characteristics: args.characteristics, title: args.title, description: args.description },
      rationale: args.rationale,
    });
    return JSON.stringify({
      status: enq.reused ? 'already_queued' : 'queued',
      actionId: enq.actionId,
      message: enq.reused
        ? `Обновление характеристик ${args.nmId} уже в очереди [actionId:${enq.actionId}].`
        : `✓ Обновление характеристик ${args.nmId} (${args.characteristics.length} полей) поставлено в очередь [actionId:${enq.actionId}].`,
    });
  }

  try {
    const apiKey = await getWbApiKey(wsId, shopId);
    if (!apiKey) return JSON.stringify({ error: 'WB API ключ не настроен' });

    const [action] = await db.insert(agentActions).values({
      workspaceId: wsId,
      shopId: args._shopId ?? null,
      actionType: 'update_characteristics',
      status: 'pending',
      payload: { nmId: args.nmId, characteristicsCount: args.characteristics.length, title: args.title },
      rationale: args.rationale,
      decidedBy: args._userId ? (BigInt(args._userId) as any) : null,
      decidedAt: new Date(),
    }).returning();

    const patch: any = { characteristics: args.characteristics };
    if (args.title) patch.title = args.title;
    if (args.description) patch.description = args.description;

    const result = await safeUpdateCard(apiKey, args.nmId, patch);

    if (result.error) {
      await db.update(agentActions).set({ status: 'failed' }).where(eq(agentActions.actionId, action.actionId));
      return JSON.stringify({ status: 'failed', error: result.errorText || 'Ошибка обновления карточки' });
    }

    await db.update(agentActions).set({ status: 'executed', executedAt: new Date(), completedAt: new Date() }).where(eq(agentActions.actionId, action.actionId));

    return JSON.stringify({
      status: 'success',
      actionId: Number(action.actionId),
      message: `Карточка ${args.nmId} обновлена: ${args.characteristics.length} характеристик(и).`,
    });
  } catch (err: any) {
    return JSON.stringify({ status: 'failed', error: err.message || 'Ошибка обновления' });
  }
}
