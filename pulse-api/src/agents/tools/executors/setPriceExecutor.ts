/**
 * `set_price` executor — runs inside pulse-workers when an action_set_price
 * row was enqueued (ENABLE_ACTION_QUEUE=1 path).
 *
 * Mirrors the legacy `actionSetPrice` business logic, minus the new INSERT
 * into agent_actions: the row already exists (created by enqueueAction);
 * the worker has flipped it to status='running' and will mark terminal in
 * agentActionRunner. We just do the WB call here and return success/error.
 *
 * Lock semantics:
 *   - In the legacy inline path, `graph.executeNode` acquired a lock for the
 *     tool name before calling the tool. With queue mode, that lock would
 *     release the instant enqueueAction() returns — race window.
 *   - So this executor re-acquires the lock here, scoped to nmId, for the
 *     duration of the WB call.
 *
 * Retry classification:
 *   - 5xx / network errors / WB 429 → retryable (sweeper / pg-boss retries).
 *   - 4xx / business rejection / "товар не найден" → permanent.
 */

import { wbSetPrice } from '../../../integrations/wb/wbActions.js';
import { acquireLock, releaseLock, assertAgentAuth } from '../locks.js';
import { getCurrentPriceInfo, computeNewFinalKop } from '../priceInfo.js';
import type { ActionExecutor } from '../actionQueue.js';
import { logAgent as logger } from '../../../lib/logger.js';

const MIN_PRICE_KOP = 100;
const MAX_PRICE_KOP = 50_000_000;
const LOCK_RESOURCE_TYPE = 'action_set_price';

interface SetPriceArgs {
  nmId: number;
  newPriceKop: number;
  newDiscountPct?: number | null;
  rationale?: string;
}

function classifyRetryable(msg: string): boolean {
  const lower = msg.toLowerCase();
  if (/\b5\d\d\b/.test(lower)) return true;
  if (lower.includes('timeout') || lower.includes('econn') || lower.includes('etimedout')) return true;
  if (lower.includes('rate-limit') || lower.includes('429')) return true;
  if (lower.includes('socket hang up') || lower.includes('network')) return true;
  return false;
}

export const setPriceExecutor: ActionExecutor = async (args, ctx) => {
  const a = args as unknown as SetPriceArgs;

  // Defence in depth: re-validate even though actionSetPrice already did.
  // A stored row could in theory be replayed days later, so don't trust the
  // payload blindly.
  if (!Number.isFinite(a.newPriceKop) || a.newPriceKop < MIN_PRICE_KOP || a.newPriceKop > MAX_PRICE_KOP) {
    return { status: 'error', error: 'price out of range', retryable: false };
  }
  if (!a.nmId || a.nmId <= 0) {
    return { status: 'error', error: 'bad nmId', retryable: false };
  }
  if (ctx.shopId == null) {
    return { status: 'error', error: 'shop_id missing — cannot resolve WB key', retryable: false };
  }

  // User membership check. If user was removed between enqueue and run,
  // refuse rather than acting on behalf of a stranger.
  try {
    await assertAgentAuth(ctx.userId ?? undefined, ctx.workspaceId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'error', error: `auth: ${msg}`, retryable: false };
  }

  const lockResource = `${ctx.shopId}:${a.nmId}`;
  const lockOwner = `worker:setPriceExecutor:action=${ctx.actionId}`;
  const lockAcquired = await acquireLock(ctx.workspaceId, LOCK_RESOURCE_TYPE, lockResource, lockOwner);
  if (!lockAcquired) {
    // Lock is held by another in-flight action on the same nmId. Retry later.
    return {
      status: 'error',
      error: `locked: another set_price action is already running for nmId=${a.nmId}`,
      retryable: true,
    };
  }

  try {
    const newPriceRub = Math.round(a.newPriceKop / 100);
    const current = await getCurrentPriceInfo(ctx.workspaceId, ctx.shopId, a.nmId);
    if (!current) {
      return {
        status: 'error',
        error: `Товар ${a.nmId} не найден в магазине. Проверьте принадлежность артикула выбранному магазину.`,
        retryable: false,
      };
    }

    const newCalc = computeNewFinalKop(a.newPriceKop, a.newDiscountPct ?? undefined, current.discountPct ?? null);
    const newFinalRub = Math.round(newCalc.finalKop / 100);

    const result = await wbSetPrice(
      ctx.workspaceId,
      ctx.shopId,
      a.nmId,
      newPriceRub,
      a.newDiscountPct ?? undefined,
    );

    if (!result.success) {
      const errMsg = result.error ?? 'wbSetPrice failed with unknown reason';
      logger.warn({ actionId: ctx.actionId, nmId: a.nmId, errMsg }, 'set_price executor: WB API rejected');
      return { status: 'error', error: errMsg, retryable: classifyRetryable(errMsg) };
    }

    return {
      status: 'success',
      result: {
        nmId: a.nmId,
        uploadId: result.data?.uploadId ?? null,
        wbResponse: result.wbResponse ?? null,
        newPriceRub,
        newFinalRub,
        newFinalKop: newCalc.finalKop,
        message: `✅ Цена товара ${a.nmId} изменена на ${newPriceRub} ₽ (со скидкой ~${newFinalRub} ₽)`,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'error', error: msg, retryable: classifyRetryable(msg) };
  } finally {
    await releaseLock(ctx.workspaceId, LOCK_RESOURCE_TYPE, lockResource);
  }
};
