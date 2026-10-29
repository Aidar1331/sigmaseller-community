/**
 * Tool: action_book_supply_slot — Book a specific slot for an existing preorder.
 * DANGEROUS: must be invoked ONLY through executeNode after user confirmation.
 *
 * Used when the user first reviewed slot options (via show_supply_calendar)
 * and then chose a date. For end-to-end "create + book in one go" use
 * action_create_supply with desiredDate parameter.
 *
 * See workspace/PLAN-SUPPLIES-E2E-AGENT-2026-05-23.md A.2.
 */

import { db } from '../../db/client.js';
import { agentActions, supplySlotsCache } from '../../db/schema.js';
import { eq, and, desc } from 'drizzle-orm';
import { getWbApiKey } from '../../integrations/wb/wbClient.js';
import { confirmSupply } from '../../integrations/wb/supplies/client.js';
import { assertAgentAuth } from './locks.js';
import { env } from '../../env.js';
import { enqueueAction } from './actionQueue.js';

interface ActionBookSupplySlotArgs {
  preorderID: number;
  warehouseID: number;
  date: string; // YYYY-MM-DD
  rationale?: string;
  _workspaceId?: number;
  _shopId?: number;
  _userId?: number;
  _confirmed?: boolean;
}

export async function actionBookSupplySlot(args: ActionBookSupplySlotArgs): Promise<string> {
  if (args._confirmed !== true) {
    return JSON.stringify({
      status: 'error',
      error: 'action_book_supply_slot must be confirmed by the user via executeNode',
    });
  }

  const wsId = args._workspaceId;
  const shopId = args._shopId as number | undefined;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });

  if (!Number.isFinite(args.preorderID) || args.preorderID <= 0) {
    return JSON.stringify({ status: 'error', error: 'preorderID must be a positive number' });
  }
  if (!Number.isFinite(args.warehouseID) || args.warehouseID <= 0) {
    return JSON.stringify({ status: 'error', error: 'warehouseID must be a positive number' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
    return JSON.stringify({ status: 'error', error: 'date must be YYYY-MM-DD' });
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
      shopId: args._shopId ?? null,
      userId: args._userId ?? null,
      conversationId: null,
      actionType: 'book_supply_slot',
      toolArgs: {
        preorderID: args.preorderID,
        warehouseID: args.warehouseID,
        date: args.date,
      },
      rationale: args.rationale ?? `Бронирование слота ${args.date}`,
      turnId: `${args.preorderID}-${args.date}`,
    });
    return JSON.stringify({
      status: enq.reused ? 'already_queued' : 'queued',
      actionId: enq.actionId,
      message: enq.reused
        ? `Бронирование уже в очереди [actionId:${enq.actionId}].`
        : `✓ Бронирование слота ${args.date} (preorder ${args.preorderID}) в очереди [actionId:${enq.actionId}].`,
    });
  }

  // Inline path
  let action: any = null;
  try {
    const apiKey = await getWbApiKey(wsId, shopId);
    if (!apiKey) return JSON.stringify({ error: 'WB API ключ не настроен' });

    // Lookup cached coefficient for sanity check + WB confirmSupply payload
    const [slot] = await db
      .select({ coefficient: supplySlotsCache.coefficient })
      .from(supplySlotsCache)
      .where(
        and(
          eq(supplySlotsCache.workspaceId, wsId),
          eq(supplySlotsCache.warehouseId, args.warehouseID),
          eq(supplySlotsCache.date, args.date),
        ),
      )
      .orderBy(desc(supplySlotsCache.fetchedAt))
      .limit(1);

    [action] = await db
      .insert(agentActions)
      .values({
        workspaceId: wsId,
        shopId: args._shopId ?? null,
        actionType: 'book_supply_slot',
        status: 'pending',
        payload: {
          preorderID: args.preorderID,
          warehouseID: args.warehouseID,
          date: args.date,
          cachedCoefficient: slot?.coefficient ?? null,
        },
        rationale: args.rationale ?? `Бронирование слота ${args.date}`,
        decidedBy: args._userId ? (BigInt(args._userId) as any) : null,
        decidedAt: new Date(),
      })
      .returning();

    const result = await confirmSupply(apiKey, args.preorderID, {
      date: args.date,
      coefficient: slot?.coefficient != null ? Number(slot.coefficient) : undefined,
    });

    await db
      .update(agentActions)
      .set({ status: 'executed', executedAt: new Date(), completedAt: new Date(), result: result as any })
      .where(eq(agentActions.actionId, action.actionId));

    return JSON.stringify({
      status: 'success',
      actionId: Number(action.actionId),
      supplyID: result.supplyID ?? null,
      date: result.date ?? args.date,
      coefficient: result.coefficient ?? null,
      message: `✅ Слот забронирован: preorder ${args.preorderID}, дата ${result.date ?? args.date}, коэф ${result.coefficient ?? '?'}×`,
    });
  } catch (err: any) {
    if (action?.actionId) {
      await db
        .update(agentActions)
        .set({ status: 'failed' })
        .where(eq(agentActions.actionId, action.actionId))
        .catch(() => {});
    }
    return JSON.stringify({
      status: 'failed',
      error: err.message ?? 'Ошибка бронирования слота',
    });
  }
}
