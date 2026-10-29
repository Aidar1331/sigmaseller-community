/**
 * Tool: action_queue_supply_autoBook — Queue a preorder for automatic
 * slot-booking when WB acceptance coefficient drops below threshold.
 * DANGEROUS: must be invoked ONLY through executeNode after user confirmation.
 *
 * Cron `supplyBookingQueueProcessor` checks `supply_booking_queue` every
 * 10 minutes and books the slot when conditions are met.
 *
 * See workspace/PLAN-SUPPLIES-E2E-AGENT-2026-05-23.md B.3.
 */

import { db } from '../../db/client.js';
import { agentActions, supplyBookingQueue } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { assertAgentAuth } from './locks.js';

interface ActionQueueAutoBookArgs {
  preorderID: number;
  warehouseID: number;
  desiredDate: string; // YYYY-MM-DD
  maxCoefficient?: number; // default 1.0
  rationale?: string;
  _workspaceId?: number;
  _shopId?: number;
  _userId?: number;
  _confirmed?: boolean;
}

export async function actionQueueAutoBook(args: ActionQueueAutoBookArgs): Promise<string> {
  if (args._confirmed !== true) {
    return JSON.stringify({
      status: 'error',
      error: 'action_queue_supply_autoBook must be confirmed by the user via executeNode',
    });
  }

  const wsId = args._workspaceId;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });

  if (!Number.isFinite(args.preorderID) || args.preorderID <= 0) {
    return JSON.stringify({ status: 'error', error: 'preorderID must be a positive number' });
  }
  if (!Number.isFinite(args.warehouseID) || args.warehouseID <= 0) {
    return JSON.stringify({ status: 'error', error: 'warehouseID must be a positive number' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.desiredDate)) {
    return JSON.stringify({ status: 'error', error: 'desiredDate must be YYYY-MM-DD' });
  }

  const maxCoefficient = args.maxCoefficient ?? 1.0;
  if (maxCoefficient < 0 || maxCoefficient > 100) {
    return JSON.stringify({
      status: 'error',
      error: 'maxCoefficient must be between 0 and 100',
    });
  }

  try {
    await assertAgentAuth(args._userId, wsId);
  } catch (err: any) {
    return JSON.stringify({ error: err.message });
  }

  let action: any = null;
  try {
    // Idempotency: if an active queue entry already exists for this preorder
    // + date, return that (don't create a duplicate).
    const [existing] = await db
      .select({ queueId: supplyBookingQueue.queueId, status: supplyBookingQueue.status })
      .from(supplyBookingQueue)
      .where(
        and(
          eq(supplyBookingQueue.workspaceId, wsId),
          eq(supplyBookingQueue.preorderId, args.preorderID),
          eq(supplyBookingQueue.desiredDate, args.desiredDate),
        ),
      )
      .limit(1);

    if (existing && (existing.status === 'waiting' || existing.status === 'processing')) {
      return JSON.stringify({
        status: 'already_queued',
        queueId: Number(existing.queueId),
        message: `Поставка ${args.preorderID} на ${args.desiredDate} уже в очереди автоброни (queueId:${existing.queueId}).`,
      });
    }

    [action] = await db
      .insert(agentActions)
      .values({
        workspaceId: wsId,
        shopId: args._shopId ?? null,
        actionType: 'queue_auto_book',
        status: 'pending',
        payload: {
          preorderID: args.preorderID,
          warehouseID: args.warehouseID,
          desiredDate: args.desiredDate,
          maxCoefficient,
        },
        rationale:
          args.rationale ??
          `Постановка в очередь авто-бронирования (порог коэф ${maxCoefficient}×)`,
        decidedBy: args._userId ? (BigInt(args._userId) as any) : null,
        decidedAt: new Date(),
      })
      .returning();

    const [queued] = await db
      .insert(supplyBookingQueue)
      .values({
        workspaceId: wsId,
        preorderId: args.preorderID,
        warehouseId: args.warehouseID,
        desiredDate: args.desiredDate,
        maxCoefficient: String(maxCoefficient),
        status: 'waiting',
      })
      .returning({ queueId: supplyBookingQueue.queueId });

    await db
      .update(agentActions)
      .set({
        status: 'executed',
        executedAt: new Date(),
        result: { queueId: Number(queued.queueId) },
      })
      .where(eq(agentActions.actionId, action.actionId));

    return JSON.stringify({
      status: 'success',
      actionId: Number(action.actionId),
      queueId: Number(queued.queueId),
      message: `📋 Поставка ${args.preorderID} в очереди авто-бронирования: дата ${args.desiredDate}, порог коэф ${maxCoefficient}×. Уведомим когда забронируем.`,
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
      error: err.message ?? 'Ошибка постановки в очередь',
    });
  }
}
