/**
 * `pause_campaign` executor. Mirror of start_campaign.
 */

import { sql } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { wbPauseCampaign } from '../../../integrations/wb/wbActions.js';
import { assertAgentAuth } from '../locks.js';
import type { ActionExecutor } from '../actionQueue.js';
import { logAgent as logger } from '../../../lib/logger.js';

interface PauseCampaignArgs { campaignId: number; }

const retryable = (msg: string): boolean => {
  const m = msg.toLowerCase();
  return /\b5\d\d\b/.test(m) || m.includes('timeout') || m.includes('econn') || m.includes('rate-limit') || m.includes('429');
};

export const pauseCampaignExecutor: ActionExecutor = async (args, ctx) => {
  const a = args as unknown as PauseCampaignArgs;
  if (!a.campaignId) return { status: 'error', error: 'bad campaignId', retryable: false };
  if (ctx.shopId == null) return { status: 'error', error: 'shop_id missing', retryable: false };
  try { await assertAgentAuth(ctx.userId ?? undefined, ctx.workspaceId); }
  catch (err) { return { status: 'error', error: `auth: ${err instanceof Error ? err.message : err}`, retryable: false }; }

  const ownedRes = await db.execute<{ exists: number }>(sql`
    SELECT 1 AS exists FROM wb_campaigns
    WHERE workspace_id = ${ctx.workspaceId} AND campaign_id = ${a.campaignId}
      AND (shop_id = ${ctx.shopId} OR shop_id IS NULL)
    LIMIT 1
  `);
  if (!Array.isArray(((ownedRes as any).rows ?? ownedRes)) || (((ownedRes as any).rows ?? ownedRes) as any[]).length === 0) {
    return { status: 'error', error: `campaignId=${a.campaignId} not in workspace=${ctx.workspaceId}`, retryable: false };
  }

  try {
    const result = await wbPauseCampaign(ctx.workspaceId, ctx.shopId, a.campaignId);
    if (!result.success) {
      const errMsg = result.error ?? 'wbPauseCampaign failed';
      logger.warn({ actionId: ctx.actionId, campaignId: a.campaignId, errMsg }, 'pause_campaign: WB rejected');
      return { status: 'error', error: errMsg, retryable: retryable(errMsg) };
    }
    return { status: 'success', result: { campaignId: a.campaignId, message: `✅ Кампания ${a.campaignId} приостановлена` } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'error', error: msg, retryable: retryable(msg) };
  }
};
