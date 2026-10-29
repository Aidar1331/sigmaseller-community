/**
 * `reply_feedback` executor — runs inside pulse-workers when an
 * action_reply_feedback row was enqueued (ENABLE_ACTION_QUEUE=1 path).
 *
 * Mirrors the inline `actionReplyFeedback` business logic minus the
 * agent_actions INSERT (the row already exists from enqueueAction).
 *
 * Re-validates ownership at execute time because:
 *   - The row may sit `queued` for many minutes after the user's confirm,
 *     during which the feedback could be deleted (e.g. WB hid it for
 *     moderation, or another tool removed it).
 *   - Defence in depth — never call WB with a feedbackId we can't prove ours.
 *
 * Retry classification: same as setPriceExecutor (5xx / network / throttle).
 */

import { sql } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { wbReplyFeedback } from '../../../integrations/wb/wbActions.js';
import { assertAgentAuth } from '../locks.js';
import type { ActionExecutor } from '../actionQueue.js';
import { logAgent as logger } from '../../../lib/logger.js';

interface ReplyFeedbackArgs {
  feedbackId: string;
  replyText: string;
}

function classifyRetryable(msg: string): boolean {
  const lower = msg.toLowerCase();
  if (/\b5\d\d\b/.test(lower)) return true;
  if (lower.includes('timeout') || lower.includes('econn') || lower.includes('etimedout')) return true;
  if (lower.includes('rate-limit') || lower.includes('429')) return true;
  return false;
}

export const replyFeedbackExecutor: ActionExecutor = async (args, ctx) => {
  const a = args as unknown as ReplyFeedbackArgs;

  if (!a.feedbackId || typeof a.feedbackId !== 'string') {
    return { status: 'error', error: 'bad feedbackId', retryable: false };
  }
  if (!a.replyText || a.replyText.trim().length === 0) {
    return { status: 'error', error: 'empty replyText', retryable: false };
  }
  if (ctx.shopId == null) {
    return { status: 'error', error: 'shop_id missing — cannot resolve WB key', retryable: false };
  }

  try {
    await assertAgentAuth(ctx.userId ?? undefined, ctx.workspaceId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'error', error: `auth: ${msg}`, retryable: false };
  }

  // Re-check ownership at execute time (defence in depth).
  const owned = await db.execute<{ exists: number }>(sql`
    SELECT 1 AS exists
    FROM marketplace_feedback_items
    WHERE workspace_id = ${ctx.workspaceId}
      AND marketplace = 'wb'
      AND item_type = 'feedback'
      AND item_id = ${a.feedbackId}
    LIMIT 1
  `);
  const ownedRows = (owned as any).rows ?? owned;
  if (!Array.isArray(ownedRows) || ownedRows.length === 0) {
    return {
      status: 'error',
      error: `feedbackId=${a.feedbackId} no longer belongs to workspace=${ctx.workspaceId}`,
      retryable: false,
    };
  }

  try {
    const result = await wbReplyFeedback(ctx.workspaceId, ctx.shopId, a.feedbackId, a.replyText);
    if (!result.success) {
      const errMsg = result.error ?? 'wbReplyFeedback failed with unknown reason';
      logger.warn({ actionId: ctx.actionId, feedbackId: a.feedbackId, errMsg }, 'reply_feedback: WB API rejected');
      return { status: 'error', error: errMsg, retryable: classifyRetryable(errMsg) };
    }
    return {
      status: 'success',
      result: {
        feedbackId: a.feedbackId,
        message: `✅ Ответ на отзыв ${a.feedbackId} отправлен`,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'error', error: msg, retryable: classifyRetryable(msg) };
  }
};
