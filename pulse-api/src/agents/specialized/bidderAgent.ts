/**
 * Bidder Agent -- 4 bidding strategies for WB advertising.
 * Strategies from MarketGuru competitive analysis.
 */

import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../env.js';
import { db } from '../../db/client.js';
import { wbAdvDailyProducts, agentSettings } from '../../db/schema.js';
import { eq, and, gte, sql } from 'drizzle-orm';
import { computeCostMicros, recordAiUsage } from '../../services/aiSettings.js';

type BidStrategy = 'maximize_position' | 'optimize_drr' | 'budget_saver' | 'aggressive_growth';

interface BidRecommendation {
  campaignId: number;
  nmId: number;
  currentBidKop: number;
  proposedBidKop: number;
  strategy: BidStrategy;
  reason: string;
}

export async function runBidderAgent(wsId: number, strategy: BidStrategy = 'optimize_drr', shopId?: number): Promise<{
  summary: string;
  recommendations: BidRecommendation[];
}> {
  const d7ago = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

  // Get settings
  const [settings] = await db.select().from(agentSettings).where(eq(agentSettings.workspaceId, wsId)).limit(1);
  const maxBidKop = ((settings as any)?.maxBidRub ?? 500) * 100;

  // Get active campaigns with metrics (scoped to shop when provided)
  const campaigns = await db.select({
    campaignId: wbAdvDailyProducts.nmId, // grouped by nmId as campaign proxy
    nmId: wbAdvDailyProducts.nmId,
    totalSpend: sql<number>`coalesce(sum(${wbAdvDailyProducts.spendKopecks}), 0)`.mapWith(Number),
    totalOrders: sql<number>`coalesce(sum(${wbAdvDailyProducts.ordersCount}), 0)`.mapWith(Number),
    totalRevenue: sql<number>`coalesce(sum(${wbAdvDailyProducts.sumPriceKopecks}), 0)`.mapWith(Number),
    totalClicks: sql<number>`coalesce(sum(${wbAdvDailyProducts.clicksCount}), 0)`.mapWith(Number),
    totalViews: sql<number>`coalesce(sum(${wbAdvDailyProducts.viewsCount}), 0)`.mapWith(Number),
  })
  .from(wbAdvDailyProducts)
  .where(and(
    eq(wbAdvDailyProducts.workspaceId, wsId),
    gte(wbAdvDailyProducts.date, d7ago),
    ...(shopId != null ? [eq(wbAdvDailyProducts.shopId, shopId)] : []),
  ))
  .groupBy(wbAdvDailyProducts.nmId);

  const recommendations: BidRecommendation[] = [];

  for (const c of campaigns.slice(0, 30)) {
    const drr = c.totalRevenue > 0 ? (c.totalSpend / c.totalRevenue) * 100 : 100;
    const cpc = c.totalClicks > 0 ? c.totalSpend / c.totalClicks : 0;
    const ctr = c.totalViews > 0 ? (c.totalClicks / c.totalViews) * 100 : 0;
    const currentBid = cpc; // approximate from CPC

    let proposedBid = currentBid;
    let reason = '';

    switch (strategy) {
      case 'maximize_position':
        proposedBid = Math.round(currentBid * 1.15);
        reason = `Повышение ставки на 15% для роста позиции (CTR: ${ctr.toFixed(1)}%)`;
        break;
      case 'optimize_drr':
        if (drr > 15) {
          proposedBid = Math.round(currentBid * 0.85);
          reason = `ДРР ${drr.toFixed(1)}% > 15%. Снижение ставки на 15%`;
        } else if (drr < 5 && c.totalOrders > 0) {
          proposedBid = Math.round(currentBid * 1.1);
          reason = `ДРР ${drr.toFixed(1)}% < 5%. Есть возможность для роста`;
        } else {
          continue; // DRR is fine
        }
        break;
      case 'budget_saver':
        if (c.totalOrders === 0 && c.totalSpend > 0) {
          proposedBid = Math.round(currentBid * 0.5);
          reason = `0 заказов, расход ${(c.totalSpend / 100).toFixed(0)} руб. Снижение 50%`;
        } else if (drr > 20) {
          proposedBid = Math.round(currentBid * 0.7);
          reason = `ДРР ${drr.toFixed(1)}% критичен. Снижение 30%`;
        } else {
          continue;
        }
        break;
      case 'aggressive_growth':
        if (ctr > 3 && drr < 20) {
          proposedBid = Math.round(currentBid * 1.3);
          reason = `CTR ${ctr.toFixed(1)}% высокий, ДРР ${drr.toFixed(1)}% в норме. Рост +30%`;
        } else {
          continue;
        }
        break;
    }

    if (proposedBid !== currentBid && proposedBid > 0) {
      recommendations.push({
        campaignId: c.campaignId,
        nmId: c.nmId,
        currentBidKop: Math.round(currentBid),
        proposedBidKop: Math.min(Math.round(proposedBid), maxBidKop),
        strategy,
        reason,
      });
    }
  }

  const summary = recommendations.length > 0
    ? `Ставочный агент (${strategy}): ${recommendations.length} рекомендаций по ставкам`
    : `Ставочный агент (${strategy}): все ставки в норме`;

  return { summary, recommendations };
}
