// Multi-Agent v2 Phase 4 — Supervisor risk assessor.
//
// Deterministic pre-execute checks for DANGEROUS_TOOLS. Called from
// graph.executeNode before WB API call. Result: green (execute), yellow
// (show confirmation with extra rationale) or red (block with reason).
//
// Only active when ENABLE_MULTI_AGENT=1; default build never reaches this path.

import { and, eq, gte, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { agentActions, agentSettings, wbFunnelDailyProducts } from '../../db/schema.js';

export type RiskVerdict = 'green' | 'yellow' | 'red';

export interface RiskCheckResult {
  verdict: RiskVerdict;
  reason?: string;
  rule?: string;
  meta?: Record<string, unknown>;
}

export interface RiskCheckInput {
  toolName: string; // 'action_set_price' etc.
  toolArgs: Record<string, unknown>;
  workspaceId: number;
  userId?: number | null;
}

// Entry point — used by graph.executeNode.
export async function assessRisk(input: RiskCheckInput): Promise<RiskCheckResult> {
  switch (input.toolName) {
    case 'action_set_price':
      return assessSetPrice(input);
    case 'action_pause_campaign':
    case 'action_start_campaign':
      return assessCampaignState(input);
    case 'action_update_bid':
      return assessBidChange(input);
    default:
      // Fallback: rate-limit spam check across any dangerous tool
      return assessGenericRate(input);
  }
}

// Pricing: big swing, loss-leader, margin floor.
async function assessSetPrice(input: RiskCheckInput): Promise<RiskCheckResult> {
  const args = input.toolArgs as { nmId?: number; newPriceKop?: number };
  const newPriceKop = Number(args.newPriceKop);
  if (!newPriceKop || newPriceKop < 0) {
    return { verdict: 'red', rule: 'invalid_price', reason: 'newPriceKop must be positive' };
  }

  const [settings] = await db.select({ minMargin: agentSettings.minMarginPct, maxChange: agentSettings.maxPriceChangePct })
    .from(agentSettings).where(eq(agentSettings.workspaceId, input.workspaceId)).limit(1);

  // Historical: recent set_price actions for same nmId
  const oneHour = new Date(Date.now() - 60 * 60 * 1000);
  const [{ recentCount }] = await db
    .select({ recentCount: sql<number>`count(*)`.mapWith(Number) })
    .from(agentActions)
    .where(and(
      eq(agentActions.workspaceId, input.workspaceId),
      eq(agentActions.actionType, 'set_price'),
      gte(agentActions.createdAt, oneHour),
    ));

  if (recentCount > 10) {
    return { verdict: 'yellow', rule: 'price_changes_spike', reason: `>10 price changes in last hour (${recentCount})`, meta: { recentCount } };
  }

  // Max single-step change % requires "previous price" — we don't have cheap
  // access here, so stricter guards are applied downstream in action tool.
  const maxChangePct = settings?.maxChange ?? 30;
  if (maxChangePct < 100 && newPriceKop < 10_00) {
    // newPrice < 10 rubles almost certainly wrong
    return { verdict: 'red', rule: 'price_too_low', reason: `Price ${newPriceKop/100}₽ below sanity threshold` };
  }

  // Absolute upper sanity cap. A >500 000 ₽ price on a WB marketplace item is
  // almost always an off-by-zero typo or LLM hallucination. Hard-block.
  if (newPriceKop > 500_000_00) {
    return { verdict: 'red', rule: 'price_too_high', reason: `Price ${newPriceKop/100}₽ exceeds absolute cap 500 000 ₽` };
  }

  // Relative cap — if recent sales velocity for this nmId exists, compare the
  // new price to the trailing average selling price. A >5× jump is almost
  // certainly wrong (saw this in session 26 when agent executed 100 000 ₽ on
  // a ~1 400 ₽ item). Yellow → arbiter; arbiter can greenlight a deliberate
  // relaunch or downgrade to red.
  if (args.nmId) {
    const thirty = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    // Источник — funnel (WB Analytics). Раньше Statistics, но для price
    // guard'а важен единый источник со всем сервисом. order_sum в funnel
    // в РУБЛЯХ → *100 чтобы avgKop остался копейками (контракт ниже).
    const [row] = await db
      .select({
        orders: sql<number>`coalesce(sum(order_count),0)`.mapWith(Number),
        rub: sql<number>`coalesce(sum(order_sum) * 100, 0)`.mapWith(Number),
      })
      .from(wbFunnelDailyProducts)
      .where(and(
        eq(wbFunnelDailyProducts.workspaceId, input.workspaceId),
        eq(wbFunnelDailyProducts.nmId, args.nmId as number),
        gte(wbFunnelDailyProducts.date, thirty),
      ));
    if (row && row.orders > 0 && row.rub > 0) {
      // avg = rub_kop / orders_count → копейки/штука, прямо сравнимо с newPriceKop.
      const avgKop = Math.round(row.rub / row.orders);
      if (avgKop > 0 && newPriceKop > avgKop * 5) {
        return {
          verdict: 'yellow',
          rule: 'price_deviation_5x',
          reason: `Price ${newPriceKop/100}₽ is >5× avg ${(avgKop/100).toFixed(0)}₽ over last 30d`,
          meta: { avgKop, newPriceKop, multiplier: (newPriceKop / avgKop).toFixed(1) },
        };
      }
    }
  }

  return { verdict: 'green' };
}

async function assessCampaignState(input: RiskCheckInput): Promise<RiskCheckResult> {
  const oneHour = new Date(Date.now() - 60 * 60 * 1000);
  const [{ recentCount }] = await db
    .select({ recentCount: sql<number>`count(*)`.mapWith(Number) })
    .from(agentActions)
    .where(and(
      eq(agentActions.workspaceId, input.workspaceId),
      gte(agentActions.createdAt, oneHour),
    ));

  if (recentCount > 30) {
    return { verdict: 'yellow', rule: 'campaign_ops_spike', reason: `${recentCount} agent actions in last hour`, meta: { recentCount } };
  }
  return { verdict: 'green' };
}

async function assessBidChange(input: RiskCheckInput): Promise<RiskCheckResult> {
  const args = input.toolArgs as { newBid?: number };
  const newBid = Number(args.newBid);
  if (!newBid || newBid < 0) {
    return { verdict: 'red', rule: 'invalid_bid', reason: 'newBid must be positive' };
  }
  const [settings] = await db.select({ maxBid: agentSettings.maxBidRub })
    .from(agentSettings).where(eq(agentSettings.workspaceId, input.workspaceId)).limit(1);
  if (settings?.maxBid && newBid > settings.maxBid * 100) {
    return { verdict: 'red', rule: 'bid_above_cap', reason: `Bid ${newBid/100}₽ > cap ${settings.maxBid}₽` };
  }
  return { verdict: 'green' };
}

async function assessGenericRate(input: RiskCheckInput): Promise<RiskCheckResult> {
  const tenMin = new Date(Date.now() - 10 * 60 * 1000);
  const [{ recentCount }] = await db
    .select({ recentCount: sql<number>`count(*)`.mapWith(Number) })
    .from(agentActions)
    .where(and(
      eq(agentActions.workspaceId, input.workspaceId),
      gte(agentActions.createdAt, tenMin),
    ));
  if (recentCount > 50) {
    return { verdict: 'yellow', rule: 'agent_action_rate_spike', reason: `${recentCount} actions in last 10min`, meta: { recentCount } };
  }
  return { verdict: 'green' };
}
