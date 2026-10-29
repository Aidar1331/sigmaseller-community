// V&V for action_update_bid. Compares wbCampaigns.currentBid with expected.

import { eq } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { agentActions, wbCampaigns } from '../../../db/schema.js';
import type { CheckFn } from '../types.js';

export const verifyBidChange: CheckFn = async (args) => {
  const { actionId, checkType, payload } = args;

  const [action] = await db
    .select({ status: agentActions.status, payload: agentActions.payload })
    .from(agentActions)
    .where(eq(agentActions.actionId, actionId))
    .limit(1);
  if (!action) return { result: 'fail', details: { error: 'action_row_missing' } };

  const campaignId = Number((payload as { campaignId?: number })?.campaignId ?? (action.payload as { campaignId?: number })?.campaignId);
  const expectedBid = Number((payload as { newBid?: number })?.newBid ?? (action.payload as { newBid?: number })?.newBid);
  if (!campaignId || !expectedBid) return { result: 'fail', details: { error: 'missing_expectations', payload } };

  if (checkType === 'immediate') {
    if (action.status !== 'executed') return { result: 'fail', details: { actionStatus: action.status } };
    return { result: 'pass', details: { level: 'immediate' } };
  }

  const [row] = await db
    .select({ currentBid: wbCampaigns.currentBid })
    .from(wbCampaigns)
    .where(eq(wbCampaigns.campaignId, campaignId))
    .limit(1);
  if (!row || row.currentBid == null) return { result: 'timeout', details: { note: 'bid not synced', campaignId } };

  const diffPct = Math.abs(row.currentBid - expectedBid) / expectedBid * 100;
  if (diffPct <= 5) return { result: 'pass', details: { level: checkType, observedBid: row.currentBid, expectedBid, diffPct } };
  if (checkType === 'deferred_30s' && diffPct <= 15) {
    return { result: 'timeout', details: { note: 'within WB sync tolerance, awaiting 5min check', diffPct } };
  }
  return { result: 'drift', details: { level: checkType, observedBid: row.currentBid, expectedBid, diffPct } };
};
