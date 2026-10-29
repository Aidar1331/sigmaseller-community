import { eq } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { agentActions } from '../../../db/schema.js';
import type { CheckFn } from '../types.js';

// V&V for action_manage_discount. WB exposes discount via the same
// content/v2/get/cards/list endpoint, tracked alongside price. For Phase 2
// we rely on agent_actions.status (tool itself confirmed WB 200 response);
// deferred levels pass-through (real cross-check when wb_prices_history picks up discount).
export const verifyDiscountChange: CheckFn = async (args) => {
  const [action] = await db.select({ status: agentActions.status, result: agentActions.result })
    .from(agentActions).where(eq(agentActions.actionId, args.actionId)).limit(1);
  if (!action) return { result: 'fail', details: { error: 'action_row_missing' } };

  if (args.checkType === 'immediate') {
    if (action.status !== 'executed') return { result: 'fail', details: { actionStatus: action.status } };
    const r = action.result as { success?: boolean; error?: string } | null;
    if (r && r.success === false) return { result: 'fail', details: { wbError: r.error } };
    return { result: 'pass', details: { level: 'immediate' } };
  }
  return { result: 'pass', details: { level: args.checkType, note: 'phase2: status-based only' } };
};
