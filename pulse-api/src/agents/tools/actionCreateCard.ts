/**
 * Tool: action_create_card — Create new card on WB.
 * DANGEROUS: must be invoked ONLY through executeNode after user confirmation.
 *
 * Security contract:
 *  - `_confirmed`/`_userId`/`_shopId`/`_workspaceId` are SERVER-injected by
 *    `graph.ts:executeNode`.
 *  - Lock acquisition lives at graph level — no per-tool locks here.
 *  - No nmId yet (creating new), so ownership check is N/A.
 */

import { db } from '../../db/client.js';
import { agentActions } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { getWbApiKey } from '../../integrations/wb/wbClient.js';
import { createCard, getCardLimits } from '../../integrations/wb/content.js';
import { assertAgentAuth } from './locks.js';
import { env } from '../../env.js';
import { enqueueAction } from './actionQueue.js';

interface ActionCreateCardArgs {
  subjectID: number;
  vendorCode: string;
  title: string;
  description: string;
  brand: string;
  dimensions: { length: number; width: number; height: number };
  characteristics: Array<{ id: number; value: string | string[] }>;
  sizes: Array<{ techSize: string; wbSize?: string; skus: string[] }>;
  rationale: string;
  _workspaceId?: number;
  _shopId?: number;
  _userId?: number;
  // Server-injected by executeNode — never trust values supplied by the LLM.
  _confirmed?: boolean;
}

export async function actionCreateCard(args: ActionCreateCardArgs): Promise<string> {
  // Failsafe: must only be reached via graph.executeNode.
  if (args._confirmed !== true) {
    return JSON.stringify({
      status: 'error',
      error: 'action_create_card must be confirmed by the user via executeNode',
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

  // Action Queue path (no ownership check — we're creating a new card; lim
  // check happens inside executor at run-time).
  if (env.ENABLE_ACTION_QUEUE === '1') {
    const enq = await enqueueAction({
      workspaceId: wsId, shopId: args._shopId ?? null, userId: args._userId ?? null, conversationId: null,
      actionType: 'create_card',
      toolArgs: {
        subjectID: args.subjectID,
        vendorCode: args.vendorCode,
        title: args.title,
        description: args.description,
        brand: args.brand,
        dimensions: args.dimensions,
        characteristics: args.characteristics,
        sizes: args.sizes,
      },
      rationale: args.rationale,
      // Different cards with the same vendorCode in the same conversation
      // should each create a row, so include vendorCode in the hash domain.
      turnId: args.vendorCode,
    });
    return JSON.stringify({
      status: enq.reused ? 'already_queued' : 'queued',
      actionId: enq.actionId,
      message: enq.reused
        ? `Создание карточки "${args.title}" уже в очереди [actionId:${enq.actionId}].`
        : `✓ Создание карточки "${args.title}" (${args.vendorCode}) поставлено в очередь [actionId:${enq.actionId}].`,
    });
  }

  try {
    const apiKey = await getWbApiKey(wsId, shopId);
    if (!apiKey) return JSON.stringify({ error: 'WB API ключ не настроен' });

    // Check limits
    const limits = await getCardLimits(apiKey);
    const total = (limits.freeLimits ?? 0) + (limits.paidLimits ?? 0);
    if (total <= 0) {
      return JSON.stringify({ status: 'failed', error: 'Лимит создания карточек исчерпан (0 доступных).' });
    }

    const [action] = await db.insert(agentActions).values({
      workspaceId: wsId,
      shopId: args._shopId ?? null,
      actionType: 'create_card',
      status: 'pending',
      payload: { vendorCode: args.vendorCode, subjectID: args.subjectID, title: args.title },
      rationale: args.rationale,
      decidedBy: args._userId ? (BigInt(args._userId) as any) : null,
      decidedAt: new Date(),
    }).returning();

    const result = await createCard(apiKey, {
      subjectID: args.subjectID,
      variants: [{
        vendorCode: args.vendorCode,
        title: args.title,
        description: args.description,
        brand: args.brand,
        dimensions: args.dimensions,
        characteristics: args.characteristics,
        sizes: args.sizes,
      }],
    });

    if (result.error) {
      await db.update(agentActions).set({ status: 'failed' }).where(eq(agentActions.actionId, action.actionId));
      return JSON.stringify({ status: 'failed', error: result.errorText || 'Ошибка создания карточки' });
    }

    await db.update(agentActions).set({ status: 'executed', executedAt: new Date(), completedAt: new Date() }).where(eq(agentActions.actionId, action.actionId));

    return JSON.stringify({
      status: 'success',
      actionId: Number(action.actionId),
      message: `Карточка "${args.title}" (${args.vendorCode}) создана успешно.`,
    });
  } catch (err: any) {
    return JSON.stringify({ status: 'failed', error: err.message || 'Ошибка создания карточки' });
  }
}
