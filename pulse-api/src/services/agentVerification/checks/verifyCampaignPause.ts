// V&V for action_pause_campaign. Expects status == 11 (paused).

import { eq } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { agentActions, wbCampaigns } from '../../../db/schema.js';
import type { CheckFn } from '../types.js';

export const verifyCampaignPause: CheckFn = async (args) => {
  const { actionId, checkType, payload } = args;

  const [action] = await db
    .select({ status: agentActions.status, payload: agentActions.payload })
    .from(agentActions)
    .where(eq(agentActions.actionId, actionId))
    .limit(1);
  if (!action) return { result: 'fail', details: { error: 'action_row_missing' } };

  const campaignId = Number((payload as { campaignId?: number })?.campaignId ?? (action.payload as { campaignId?: number })?.campaignId);
  if (!campaignId) return { result: 'fail', details: { error: 'missing_campaignId' } };

  if (checkType === 'immediate') {
    if (action.status !== 'executed') return { result: 'fail', details: { actionStatus: action.status } };
    return { result: 'pass', details: { level: 'immediate' } };
  }

  const [row] = await db
    .select({ status: wbCampaigns.status })
    .from(wbCampaigns)
    .where(eq(wbCampaigns.campaignId, campaignId))
    .limit(1);
  if (!row) return { result: 'timeout', details: { note: 'campaign not synced', campaignId } };
  if (row.status === 11) return { result: 'pass', details: { level: checkType, wbStatus: row.status } };
  if (row.status === 9) {
    return checkType === 'deferred_30s'
      ? { result: 'timeout', details: { note: 'still active, awaiting WB sync lag' } }
      : { result: 'drift', details: { level: checkType, wbStatus: row.status, note: 'expected paused(11), got active(9)' } };
  }
  return { result: 'pass', details: { level: checkType, wbStatus: row.status, note: 'campaign not-active (ok for pause)' } };
};
