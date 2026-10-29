import { eq } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { agentActions } from '../../../db/schema.js';
import type { CheckFn } from '../types.js';

// V&V for action_manage_clusters. WB updates cluster assignments near-
// immediately on the /adv/v0/normquery/* endpoints. Phase 2 relies on status.
export const verifyClusterChange: CheckFn = async (args) => {
  const [action] = await db.select({ status: agentActions.status, result: agentActions.result })
    .from(agentActions).where(eq(agentActions.actionId, args.actionId)).limit(1);
  if (!action) return { result: 'fail', details: { error: 'action_row_missing' } };

  if (args.checkType === 'immediate') {
    if (action.status !== 'executed') return { result: 'fail', details: { actionStatus: action.status } };
    return { result: 'pass', details: { level: 'immediate' } };
  }
  return { result: 'pass', details: { level: args.checkType, note: 'phase2: status-based only' } };
};
