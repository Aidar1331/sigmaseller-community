/**
 * Tool: action_set_price — Change product price on WB.
 * DANGEROUS: must be invoked ONLY through executeNode after user confirmation.
 *
 * Calls WB API to actually set the price after confirmation.
 *
 * Security contract:
 *  - `_confirmed`/`_userId`/`_shopId`/`_workspaceId` are SERVER-injected by
 *    `graph.ts:executeNode` after `classifyUserDecision` passes. They MUST NOT
 *    appear in the public Zod schema. The failsafe below rejects any direct
 *    invocation that bypasses the graph.
 *  - Lock acquisition lives at graph level (`executeNode` → `acquireLock`),
 *    so this tool no longer manages locks itself. That fixes the prior race
 *    where the per-tool lock was released before WB API confirmation.
 *  - Ownership check via `getCurrentPriceInfo`: if the SKU is not present in
 *    WB API live nor in local price history nor in orders for this
 *    workspace+shop, refuse — prevents acting on a foreign nmId.
 */

import { db } from '../../db/client.js';
import { agentActions } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { wbSetPrice } from '../../integrations/wb/wbActions.js';
import { assertAgentAuth } from './locks.js';
import { getCurrentPriceInfo, computeNewFinalKop } from './priceInfo.js';
import { env } from '../../env.js';
import { enqueueAction } from './actionQueue.js';

interface ActionSetPriceArgs {
  nmId: number;
  newPriceKop: number;      // Price in kopecks (internal format)
  rationale: string;
  /**
   * Optional new seller discount %. WB API accepts price + discount independently.
   * If omitted, the existing discount on the item is preserved (WB applies the
   * last-known discount to the new base price).
   */
  newDiscountPct?: number;
  // Server-injected by executeNode — never trust values supplied by the LLM.
  _workspaceId?: number;
  _shopId?: number;
  _userId?: number;
  _confirmed?: boolean;
}

const MIN_PRICE_KOP = 100;       // 1 ₽ minimum
const MAX_PRICE_KOP = 50_000_000; // 500 000 ₽ maximum

export async function actionSetPrice(args: ActionSetPriceArgs): Promise<string> {
  // Failsafe: this tool must only be reached via graph.executeNode, which sets
  // _confirmed=true after the user explicitly approved the action. Any other
  // call path (direct invoke, tools-node leak, LLM-generated _confirmed in args
  // arriving without going through confirm/execute) is refused.
  if (args._confirmed !== true) {
    return JSON.stringify({
      status: 'error',
      error: 'action_set_price must be confirmed by the user via executeNode',
    });
  }

  const wsId = args._workspaceId;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });
  await assertAgentAuth(args._userId, wsId);

  // Business rule validation
  if (!Number.isFinite(args.newPriceKop) || args.newPriceKop < MIN_PRICE_KOP) {
    return JSON.stringify({ error: `Цена не может быть меньше ${MIN_PRICE_KOP / 100} ₽` });
  }
  if (args.newPriceKop > MAX_PRICE_KOP) {
    return JSON.stringify({ error: `Цена не может превышать ${MAX_PRICE_KOP / 100} ₽` });
  }
  if (!args.nmId || args.nmId <= 0) {
    return JSON.stringify({ error: 'Некорректный артикул товара' });
  }

  // ─── Action Queue path (feature-flagged) ────────────────────────────────
  // When ENABLE_ACTION_QUEUE=1, we persist the command durably and let the
  // background worker hit WB. Tool returns IMMEDIATELY with the actionId —
  // this is what unblocks "5 цен + 10 отзывов" batches: the LLM doesn't wait
  // 15× WB latency before continuing.
  //
  // When the flag is off (default in prod for now), we fall through to the
  // legacy inline path below: WB call + INSERT/UPDATE happen here, same as before.
  if (env.ENABLE_ACTION_QUEUE === '1') {
    const enq = await enqueueAction({
      workspaceId: wsId,
      shopId: args._shopId ?? null,
      userId: args._userId ?? null,
      // Graph state does not currently carry conversationId; UI polls by
      // actionId list anyway. Plumb this through when /ai/chat exposes it.
      conversationId: null,
      actionType: 'set_price',
      toolArgs: {
        nmId: args.nmId,
        newPriceKop: args.newPriceKop,
        newDiscountPct: args.newDiscountPct ?? null,
      },
      rationale: args.rationale,
    });
    return JSON.stringify({
      status: enq.reused ? 'already_queued' : 'queued',
      actionId: enq.actionId,
      // UI parses `[actionId:N]` from the assistant's final message and renders
      // <ActionQueueStatus> with live polling. The model is asked (in the
      // tool description) to surface this token in its reply.
      message: enq.reused
        ? `Команда уже в очереди [actionId:${enq.actionId}]. Статус обновится после исполнения.`
        : `✓ Команда поставлена в очередь [actionId:${enq.actionId}]. Цена применится в ближайшие секунды.`,
    });
  }
  // ────────────────────────────────────────────────────────────────────────

  const newPriceRub = Math.round(args.newPriceKop / 100);
  const current = await getCurrentPriceInfo(wsId, args._shopId ?? null, args.nmId);

  // Ownership check: getCurrentPriceInfo probes WB API live + local history +
  // orders. If all three fail → SKU is not in this workspace/shop. Refuse.
  if (!current) {
    return JSON.stringify({
      status: 'error',
      error: `Товар ${args.nmId} не найден в магазине. Проверьте что артикул принадлежит выбранному магазину.`,
    });
  }

  const newCalc = computeNewFinalKop(args.newPriceKop, args.newDiscountPct, current.discountPct ?? null);
  const newFinalRub = Math.round(newCalc.finalKop / 100);

  // Log action as pending
  const [action] = await db.insert(agentActions).values({
    workspaceId: wsId,
    shopId: args._shopId ?? null,
    actionType: 'set_price',
    status: 'pending',
    payload: {
      nmId: args.nmId,
      newPriceKop: args.newPriceKop,
      newPriceRub,
      newDiscountPct: args.newDiscountPct ?? null,
      newFinalPriceKop: newCalc.finalKop,
      currentPrice: current,
    },
    rationale: args.rationale,
    decidedBy: args._userId ? BigInt(args._userId) as any : null,
    decidedAt: new Date(),
  }).returning();

  try {
    // Call WB API (expects rubles). Pass discount only when caller asked to
    // change it — omitting keeps WB's last-applied discount on the new base.
    const result = await wbSetPrice(
      wsId,
      args._shopId!,
      args.nmId,
      newPriceRub,
      args.newDiscountPct,
    );

    if (!result.success) {
      await db.update(agentActions)
        .set({
          status: 'failed',
          result: { success: false, error: result.error, wbResponse: result.wbResponse },
          executedAt: new Date(),
        })
        .where(eq(agentActions.actionId, action.actionId));

      return JSON.stringify({
        status: 'error',
        actionId: action.actionId,
        message: `Не удалось изменить цену: ${result.error}`,
      });
    }

    await db.update(agentActions)
      .set({
        status: 'executed',
        result: { success: true, wbResponse: result.wbResponse },
        executedAt: new Date(),
        completedAt: new Date(),
      })
      .where(eq(agentActions.actionId, action.actionId));

    return JSON.stringify({
      status: 'success',
      actionId: action.actionId,
      uploadId: result.data?.uploadId,
      message: `✅ Цена товара ${args.nmId} изменена на ${newPriceRub} ₽ (со скидкой ~${newFinalRub} ₽)`,
    });

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';

    await db.update(agentActions)
      .set({
        status: 'failed',
        result: { success: false, error: errorMsg },
        executedAt: new Date(),
      })
      .where(eq(agentActions.actionId, action.actionId));

    return JSON.stringify({
      status: 'error',
      actionId: action.actionId,
      message: `Ошибка при изменении цены: ${errorMsg}`,
    });
  }
}
