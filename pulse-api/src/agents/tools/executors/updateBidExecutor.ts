/**
 * `update_bid` executor — runs inside pulse-workers when an
 * action_update_bid row was enqueued (ENABLE_ACTION_QUEUE=1 path).
 *
 * Mirrors the legacy inline path minus agent_actions INSERT (row exists from
 * enqueueAction). Re-validates ownership at execute time: a nmId that was
 * yours at enqueue could theoretically move (rare on WB but happens — card
 * transferred between merchants, marketplace ownership changes).
 *
 * Retry classification: 5xx / timeout / 429 → retryable. Anything else → terminal.
 */

import { sql } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { wbUpdateCampaignBid } from '../../../integrations/wb/wbActions.js';
import { assertAgentAuth } from '../locks.js';
import type { ActionExecutor } from '../actionQueue.js';
import { logAgent as logger } from '../../../lib/logger.js';

interface UpdateBidArgs {
  campaignId: number;
  nmId: number;
  bidKopecks: number;
}

function classifyRetryable(msg: string): boolean {
  const lower = msg.toLowerCase();
  if (/\b5\d\d\b/.test(lower)) return true;
  if (lower.includes('timeout') || lower.includes('econn') || lower.includes('etimedout')) return true;
  if (lower.includes('rate-limit') || lower.includes('429')) return true;
  return false;
}

export const updateBidExecutor: ActionExecutor = async (args, ctx) => {
  const a = args as unknown as UpdateBidArgs;

  if (!a.nmId || a.nmId <= 0) return { status: 'error', error: 'bad nmId', retryable: false };
  if (!a.campaignId || a.campaignId <= 0) return { status: 'error', error: 'bad campaignId', retryable: false };
  if (!Number.isFinite(a.bidKopecks) || a.bidKopecks <= 0) {
    return { status: 'error', error: 'bid must be > 0', retryable: false };
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
  const ownedRes = await db.execute<{ exists: number }>(sql`
    SELECT 1 AS exists
    FROM wb_cards
    WHERE workspace_id = ${ctx.workspaceId}
      AND nm_id = ${a.nmId}
      AND (shop_id = ${ctx.shopId} OR shop_id IS NULL)
    LIMIT 1
  `);
  const ownedRows = (ownedRes as any).rows ?? ownedRes;
  if (!Array.isArray(ownedRows) || ownedRows.length === 0) {
    return {
      status: 'error',
      error: `nmId=${a.nmId} no longer in workspace=${ctx.workspaceId}/shop=${ctx.shopId}`,
      retryable: false,
    };
  }

  try {
    const result = await wbUpdateCampaignBid(
      ctx.workspaceId,
      ctx.shopId,
      a.campaignId,
      a.nmId,
      a.bidKopecks,
    );
    if (!result.success) {
      const errMsg = result.error ?? 'wbUpdateCampaignBid failed with unknown reason';
      logger.warn({ actionId: ctx.actionId, nmId: a.nmId, campaignId: a.campaignId, errMsg }, 'update_bid: WB API rejected');
      return { status: 'error', error: errMsg, retryable: classifyRetryable(errMsg) };
    }
    const bidRub = (a.bidKopecks / 100).toFixed(2);
    return {
      status: 'success',
      result: {
        campaignId: a.campaignId,
        nmId: a.nmId,
        bidRub,
        bidKopecks: a.bidKopecks,
        message: `✅ Ставка для товара ${a.nmId} в кампании ${a.campaignId} изменена на ${bidRub} ₽`,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'error', error: msg, retryable: classifyRetryable(msg) };
  }
};
