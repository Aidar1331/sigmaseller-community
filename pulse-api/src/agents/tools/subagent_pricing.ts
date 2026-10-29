// Multi-Agent v2 — Pricing subagent tool.
//
// Wraps the existing runPricingAgent() into a LangChain tool that the
// supervisor or main agent can call. Returns analysis + recommendations.
// Does NOT execute price changes — those still go through action_set_price
// with the confirmation flow.
//
// Fallback: if runPricingAgent yields no evaluations (no user-configured
// strategies or empty prices_history), we run a lightweight heuristic scan
// over wbCards + orders/finance for the workspace so the subagent still
// returns actionable hints instead of an empty "no_data" response.

import { db } from '../../db/client.js';
import {
  agentExecutionRuns,
  wbCards,
  wbFunnelDailyProducts,
  wbFinanceDailyProducts,
} from '../../db/schema.js';
import { and, eq, gte, sql } from 'drizzle-orm';
import { logAgent as logger } from '../../lib/logger.js';
import { runPricingAgent } from '../specialized/pricingAgent.js';
import { randomUUID } from 'node:crypto';

export interface SubagentPricingInput {
  userIntent: string;
  targetNmIds?: number[];
  detailLevel?: 'quick' | 'thorough';
  _workspaceId?: number;
  _shopId?: number | null;
  _correlationId?: string;
}

export interface SubagentPricingOutput {
  status: 'ok' | 'error' | 'no_data';
  agentName: 'pricing';
  summary: string;
  recommendations: Array<{
    nmId: number;
    productTitle: string;
    currentPriceRub: number;
    proposedPriceRub: number;
    strategy: string;
    reason: string;
    priority: number;
  }>;
  runId?: string;
  error?: string;
}

export async function subagentPricing(input: SubagentPricingInput): Promise<string> {
  const wsId = input._workspaceId;
  if (!wsId) {
    return JSON.stringify({ status: 'error', agentName: 'pricing', error: 'workspace_id missing' });
  }

  const correlationId = input._correlationId ?? randomUUID();
  const runId = randomUUID();

  await db.insert(agentExecutionRuns).values({
    runId,
    agentName: 'pricing',
    workspaceId: wsId,
    shopId: input._shopId ?? null,
    correlationId,
    status: 'running',
    inputSnapshot: {
      userIntent: input.userIntent,
      targetNmIds: input.targetNmIds ?? null,
      detailLevel: input.detailLevel ?? 'quick',
    },
  });

  try {
    // Pass shopId so specialized agent scopes to the single shop —
    // otherwise it would analyse all shops of the workspace.
    const result = await runPricingAgent(wsId, input._shopId ?? undefined);

    const filtered = input.targetNmIds?.length
      ? result.evaluations.filter((e) => input.targetNmIds!.includes(e.nmId))
      : result.evaluations;

    // Fallback: strategies + prices_history empty → run heuristic scan so the
    // caller still gets actionable hints. Only triggered when the primary
    // engine produced zero evaluations AND no targetNmIds filter was applied.
    let heuristicRecs: SubagentPricingOutput['recommendations'] = [];
    let usedFallback = false;
    if (filtered.length === 0 && !input.targetNmIds?.length) {
      heuristicRecs = await runHeuristicPricingScan(wsId, input._shopId ?? null);
      usedFallback = heuristicRecs.length > 0;
    }

    const finalRecs = filtered.length > 0
      ? filtered.map((e) => ({
          nmId: e.nmId,
          productTitle: e.productTitle,
          currentPriceRub: e.currentPriceRub,
          proposedPriceRub: e.proposedPriceRub,
          strategy: e.strategy,
          reason: e.reason,
          priority: e.priority,
        }))
      : heuristicRecs;

    const output: SubagentPricingOutput = {
      status: finalRecs.length > 0 ? 'ok' : 'no_data',
      agentName: 'pricing',
      summary: usedFallback
        ? `${result.summary} Применён эвристический анализ (${heuristicRecs.length} рекомендаций).`
        : result.summary,
      recommendations: finalRecs,
      runId,
    };

    await db.update(agentExecutionRuns)
      .set({
        status: 'done',
        finishedAt: new Date(),
        output: output as unknown as Record<string, unknown>,
      })
      .where(eq(agentExecutionRuns.runId, runId));

    return JSON.stringify(output);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, wsId, runId }, 'subagentPricing failed');

    await db.update(agentExecutionRuns)
      .set({
        status: 'failed',
        finishedAt: new Date(),
        error: msg,
      })
      .where(eq(agentExecutionRuns.runId, runId));

    return JSON.stringify({ status: 'error', agentName: 'pricing', error: msg, runId });
  }
}

// Heuristic fallback: for workspaces without pricingStrategies or an empty
// wb_prices_history, derive hints from sales/finance aggregates over the last
// 14 days. Rules (all returned rules are low-priority, non-blocking hints):
//  - margin < 10% → "Маржа < 10% — проверьте, не работаете ли в убыток"
//  - sales = 0 и 14+ дней → "Нет продаж за 14д — подумайте о скидке или выходе из ассортимента"
//  - margin > 40% AND sales < 3 / 30 days → "Высокая маржа при низком обороте — тест снижения цены"
async function runHeuristicPricingScan(wsId: number, shopId: number | null): Promise<SubagentPricingOutput['recommendations']> {
  const days = 14;
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const cardsCond = shopId != null
    ? and(eq(wbCards.workspaceId, wsId), eq(wbCards.shopId, shopId))
    : eq(wbCards.workspaceId, wsId);
  const cards = await db
    .select({ nmId: wbCards.nmId, title: wbCards.title })
    .from(wbCards)
    .where(cardsCond)
    .limit(200);

  if (cards.length === 0) return [];

  // Aggregated sales and finance per nmId. Источник — funnel (WB Analytics),
  // совпадает с дашбордом и WB ЛК. funnel.buyoutSum в рублях, поэтому *100.
  const ordersAgg = await db
    .select({
      nmId: wbFunnelDailyProducts.nmId,
      totalOrders: sql<number>`coalesce(sum(${wbFunnelDailyProducts.orderCount}), 0)`.mapWith(Number),
      totalRevenueKop: sql<number>`coalesce(sum(${wbFunnelDailyProducts.buyoutSum}) * 100, 0)`.mapWith(Number),
    })
    .from(wbFunnelDailyProducts)
    .where(and(
      eq(wbFunnelDailyProducts.workspaceId, wsId),
      gte(wbFunnelDailyProducts.date, since),
    ))
    .groupBy(wbFunnelDailyProducts.nmId);

  const financeAgg = await db
    .select({
      nmId: wbFinanceDailyProducts.nmId,
      // net payout ≈ income_from_sales - logistics - commission (approx)
      netPayoutKop: sql<number>`coalesce(sum(${wbFinanceDailyProducts.incomeFromSalesKopecks} - ${wbFinanceDailyProducts.logisticsKopecks} - ${wbFinanceDailyProducts.commissionKopecks}), 0)`.mapWith(Number),
      revenueKop: sql<number>`coalesce(sum(${wbFinanceDailyProducts.revenueKopecks}), 0)`.mapWith(Number),
    })
    .from(wbFinanceDailyProducts)
    .where(and(
      eq(wbFinanceDailyProducts.workspaceId, wsId),
      gte(wbFinanceDailyProducts.date, since),
    ))
    .groupBy(wbFinanceDailyProducts.nmId);

  const ordersByNm = new Map(ordersAgg.map((r) => [Number(r.nmId), r]));
  const financeByNm = new Map(financeAgg.map((r) => [Number(r.nmId), r]));

  const recs: SubagentPricingOutput['recommendations'] = [];
  for (const c of cards) {
    const o = ordersByNm.get(Number(c.nmId));
    const f = financeByNm.get(Number(c.nmId));
    const orders = o?.totalOrders ?? 0;
    const revenueKop = o?.totalRevenueKop ?? 0;
    const payoutKop = f?.netPayoutKop ?? 0;
    const marginPct = revenueKop > 0 ? (payoutKop / revenueKop) * 100 : null;
    const avgPriceKop = orders > 0 ? Math.round(revenueKop / orders) : 0;
    const avgPriceRub = avgPriceKop / 100;

    if (orders === 0 && revenueKop === 0) {
      if (cards.length <= 30) {
        recs.push({
          nmId: Number(c.nmId), productTitle: c.title ?? `${c.nmId}`,
          currentPriceRub: 0, proposedPriceRub: 0,
          strategy: 'no_sales', reason: `Нет продаж за ${days}д — рассмотрите скидку или временный вывод из ассортимента`, priority: 2,
        });
      }
      continue;
    }
    if (marginPct != null && marginPct < 10) {
      recs.push({
        nmId: Number(c.nmId), productTitle: c.title ?? `${c.nmId}`,
        currentPriceRub: avgPriceRub, proposedPriceRub: Math.round(avgPriceRub * 1.1),
        strategy: 'low_margin', reason: `Маржа ${marginPct.toFixed(1)}% — ниже порога. Попробуйте поднять цену на ~10%`, priority: 1,
      });
    } else if (marginPct != null && marginPct > 40 && orders < 3) {
      recs.push({
        nmId: Number(c.nmId), productTitle: c.title ?? `${c.nmId}`,
        currentPriceRub: avgPriceRub, proposedPriceRub: Math.round(avgPriceRub * 0.95),
        strategy: 'high_margin_low_velocity', reason: `Маржа ${marginPct.toFixed(1)}%, но продаж ${orders}/${days}д. Возможно, цена высока — тест -5%`, priority: 3,
      });
    }
  }
  // Return up to 15 recommendations sorted by priority (1=highest)
  return recs.sort((a, b) => a.priority - b.priority).slice(0, 15);
}
