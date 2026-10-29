/**
 * `reply_question` executor. Ownership in marketplace_feedback_items
 * (item_type='question'). Call sendWbQuestionAnswer; retryable on transient.
 */

import { sql } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { sendWbQuestionAnswer } from '../../../integrations/wb/feedbacks.js';
import { assertAgentAuth } from '../locks.js';
import type { ActionExecutor } from '../actionQueue.js';
import { logAgent as logger } from '../../../lib/logger.js';

interface ReplyQuestionArgs { questionId: string; replyText: string; }

const retryable = (msg: string): boolean => {
  const m = msg.toLowerCase();
  return /\b5\d\d\b/.test(m) || m.includes('timeout') || m.includes('econn') || m.includes('rate-limit') || m.includes('429');
};

export const replyQuestionExecutor: ActionExecutor = async (args, ctx) => {
  const a = args as unknown as ReplyQuestionArgs;
  if (!a.questionId) return { status: 'error', error: 'bad questionId', retryable: false };
  if (!a.replyText?.trim()) return { status: 'error', error: 'empty replyText', retryable: false };
  try { await assertAgentAuth(ctx.userId ?? undefined, ctx.workspaceId); }
  catch (err) { return { status: 'error', error: `auth: ${err instanceof Error ? err.message : err}`, retryable: false }; }

  const ownedRes = await db.execute<{ exists: number }>(sql`
    SELECT 1 AS exists FROM marketplace_feedback_items
    WHERE workspace_id = ${ctx.workspaceId} AND marketplace = 'wb' AND item_type = 'question' AND item_id = ${a.questionId}
    LIMIT 1
  `);
  if (!Array.isArray(((ownedRes as any).rows ?? ownedRes)) || (((ownedRes as any).rows ?? ownedRes) as any[]).length === 0) {
    return { status: 'error', error: `questionId=${a.questionId} not in workspace=${ctx.workspaceId}`, retryable: false };
  }

  try {
    await sendWbQuestionAnswer(ctx.workspaceId, ctx.shopId, a.questionId, a.replyText);
    return { status: 'success', result: { questionId: a.questionId, message: `✅ Ответ на вопрос ${a.questionId} отправлен` } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ actionId: ctx.actionId, questionId: a.questionId, errMsg: msg }, 'reply_question: WB rejected');
    return { status: 'error', error: msg, retryable: retryable(msg) };
  }
};
