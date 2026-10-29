// V&V for action_reply_feedback.

import { and, eq } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { agentActions, marketplaceFeedbackItems } from '../../../db/schema.js';
import type { CheckFn } from '../types.js';

export const verifyFeedbackReply: CheckFn = async (args) => {
  const { actionId, checkType, payload } = args;

  const [action] = await db
    .select({ status: agentActions.status, result: agentActions.result, payload: agentActions.payload })
    .from(agentActions)
    .where(eq(agentActions.actionId, actionId))
    .limit(1);

  if (!action) return { result: 'fail', details: { error: 'action_row_missing' } };

  const feedbackId = String((payload as { feedbackId?: string })?.feedbackId ?? (action.payload as { feedbackId?: string })?.feedbackId ?? '');
  const expectedReply = String((payload as { replyText?: string })?.replyText ?? (action.payload as { replyText?: string })?.replyText ?? '');

  if (!feedbackId) return { result: 'fail', details: { error: 'missing_feedbackId' } };

  if (checkType === 'immediate') {
    if (action.status !== 'executed') return { result: 'fail', details: { actionStatus: action.status } };
    return { result: 'pass', details: { level: 'immediate' } };
  }

  if (checkType === 'deferred_30s' || checkType === 'deferred_5min') {
    const [row] = await db
      .select({ isAnswered: marketplaceFeedbackItems.isAnswered, answerText: marketplaceFeedbackItems.answerText })
      .from(marketplaceFeedbackItems)
      .where(and(eq(marketplaceFeedbackItems.itemId, feedbackId), eq(marketplaceFeedbackItems.itemType, 'feedback')))
      .limit(1);

    if (!row) return { result: 'timeout', details: { note: 'feedback not synced yet', feedbackId } };
    if (!row.isAnswered) {
      return checkType === 'deferred_30s'
        ? { result: 'timeout', details: { note: 'sync lag, awaiting 5min check' } }
        : { result: 'drift', details: { note: 'answerText not visible after 5min' } };
    }
    // Fuzzy match: first 40 chars of expected should be in actual (WB may strip whitespace)
    const expectedPrefix = expectedReply.slice(0, 40).trim().toLowerCase();
    const actualText = (row.answerText ?? '').trim().toLowerCase();
    if (!expectedPrefix || actualText.includes(expectedPrefix)) {
      return { result: 'pass', details: { level: checkType, matched: true } };
    }
    return { result: 'drift', details: { level: checkType, note: 'actual answer differs from expected' } };
  }

  // impact_24h: did the feedback thread close / new reply etc.
  return { result: 'pass', details: { level: 'impact_24h', note: 'phase2: no automated impact verdict yet' } };
};
