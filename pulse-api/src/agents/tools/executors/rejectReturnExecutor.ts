/**
 * `reject_return` executor — runs inside pulse-workers when an
 * action_reject_return row was enqueued (ENABLE_ACTION_QUEUE=1 path).
 */

import { eq, and } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { wbReturns } from '../../../db/schema.js';
import { rejectReturn } from '../../../integrations/wb/returns.js';
import { getWbApiKey } from '../../../integrations/wb/wbClient.js';
import { assertAgentAuth } from '../locks.js';
import type { ActionExecutor } from '../actionQueue.js';
import { logAgent as logger } from '../../../lib/logger.js';

interface RejectReturnArgs {
  returnId: number;
  reason: string;
  comment?: string | null;
}

function classifyRetryable(msg: string): boolean {
  const lower = msg.toLowerCase();
  if (/\b5\d\d\b/.test(lower)) return true;
  if (lower.includes('timeout') || lower.includes('econn') || lower.includes('etimedout')) return true;
  if (lower.includes('rate-limit') || lower.includes('429')) return true;
  return false;
}

export const rejectReturnExecutor: ActionExecutor = async (args, ctx) => {
  const a = args as unknown as RejectReturnArgs;

  if (!Number.isFinite(a.returnId) || a.returnId <= 0) {
    return { status: 'error', error: 'bad returnId', retryable: false };
  }
  if (!a.reason || a.reason.trim().length < 3) {
    return { status: 'error', error: 'reason required (min 3 chars)', retryable: false };
  }

  try {
    await assertAgentAuth(ctx.userId ?? undefined, ctx.workspaceId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'error', error: `auth: ${msg}`, retryable: false };
  }

  const owned = await db
    .select({ id: wbReturns.id, shopId: wbReturns.shopId, status: wbReturns.status })
    .from(wbReturns)
    .where(and(eq(wbReturns.workspaceId, ctx.workspaceId), eq(wbReturns.returnId, a.returnId)))
    .limit(1);

  if (owned.length === 0) {
    return {
      status: 'error',
      error: `returnId=${a.returnId} no longer belongs to workspace=${ctx.workspaceId}`,
      retryable: false,
    };
  }
  if (owned[0].status === 'rejected') {
    return { status: 'success', result: { returnId: a.returnId, message: 'already rejected' } };
  }

  const resolvedShopId = owned[0].shopId ?? ctx.shopId ?? null;
  if (resolvedShopId == null) {
    return { status: 'error', error: 'shop_id missing — cannot resolve WB key', retryable: false };
  }

  try {
    const apiKey = await getWbApiKey(ctx.workspaceId, resolvedShopId);
    if (!apiKey) {
      return { status: 'error', error: 'WB API key not found for this shop', retryable: false };
    }
    const result = await rejectReturn(apiKey, {
      returnId: a.returnId,
      reason: a.reason,
      comment: a.comment ?? undefined,
    });
    if (!result.success) {
      logger.warn({ actionId: ctx.actionId, returnId: a.returnId }, 'reject_return: WB rejected');
      return { status: 'error', error: 'WB returned success=false', retryable: false };
    }

    await db
      .update(wbReturns)
      .set({ status: 'rejected', rejectedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(wbReturns.workspaceId, ctx.workspaceId), eq(wbReturns.returnId, a.returnId)));

    return {
      status: 'success',
      result: {
        returnId: a.returnId,
        message: `✅ Возврат ${a.returnId} отклонён (${a.reason})`,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'error', error: msg, retryable: classifyRetryable(msg) };
  }
};
