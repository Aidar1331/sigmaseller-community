// V&V for action_set_price — 4 check levels.
//
// T+0 immediate: agent_actions.status == 'executed' and action.result.success == true
// T+30s / T+5m deferred: wb_prices_history latest record for nmId matches expected newPriceKop
// T+24h impact: orders/sales delta (stub for Phase 1 — real velocity analysis in Phase 6)

import { and, desc, eq, gte } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { agentActions, wbPricesHistory, wbOrdersSalesDailyProducts } from '../../../db/schema.js';
import type { CheckFn } from '../types.js';

export const verifyPriceChange: CheckFn = async (args) => {
  const { actionId, checkType, payload } = args;

  // Pull the action row to inspect status and result
  const [action] = await db
    .select({
      status: agentActions.status,
      result: agentActions.result,
      payload: agentActions.payload,
    })
    .from(agentActions)
    .where(eq(agentActions.actionId, actionId))
    .limit(1);

  if (!action) {
    return { result: 'fail', details: { error: 'action_row_missing' } };
  }

  // Expected values from the original action payload
  const expectedNmId = Number((payload as { nmId?: number })?.nmId ?? (action.payload as { nmId?: number })?.nmId);
  const expectedPriceKop = Number((payload as { newPriceKop?: number })?.newPriceKop ?? (action.payload as { newPriceKop?: number })?.newPriceKop);

  if (!expectedNmId || !expectedPriceKop) {
    return { result: 'fail', details: { error: 'missing_expectations', payload } };
  }

  // Level 1 — immediate: did the tool itself report success?
  if (checkType === 'immediate') {
    if (action.status !== 'executed') {
      return { result: 'fail', details: { actionStatus: action.status, note: 'action not marked executed' } };
    }
    const res = action.result as { success?: boolean; error?: string } | null;
    if (res && res.success === false) {
      return { result: 'fail', details: { wbError: res.error } };
    }
    return { result: 'pass', details: { level: 'immediate', actionStatus: action.status } };
  }

  // Levels 2 & 3 — deferred: confirm wb_prices_history picked up the new price
  if (checkType === 'deferred_30s' || checkType === 'deferred_5min') {
    const [latest] = await db
      .select({ priceKop: wbPricesHistory.price, date: wbPricesHistory.date })
      .from(wbPricesHistory)
      .where(eq(wbPricesHistory.nmId, expectedNmId))
      .orderBy(desc(wbPricesHistory.date))
      .limit(1);

    if (!latest || !latest.priceKop) {
      // No price history yet — WB sync likely hasn't run. Not drift, just lag.
      return { result: 'timeout', details: { note: 'no price history yet, WB sync lag', checkType } };
    }

    // Compare with tolerance (kopeck rounding + SPP)
    const diffPct = Math.abs(latest.priceKop - expectedPriceKop) / expectedPriceKop * 100;
    if (diffPct <= 5) {
      return { result: 'pass', details: { level: checkType, observedPriceKop: latest.priceKop, expectedPriceKop, diffPct } };
    }
    if (diffPct <= 15 && checkType === 'deferred_30s') {
      // Under 15% within 30s may be SPP timing — wait for 5min check
      return { result: 'timeout', details: { note: 'diff within SPP tolerance, awaiting 5min check', diffPct } };
    }
    return { result: 'drift', details: { level: checkType, observedPriceKop: latest.priceKop, expectedPriceKop, diffPct } };
  }

  // Level 4 — impact_24h: statistical drift detection via 14-day baseline.
  // Z-score against the 14d pre-change orders/day distribution. |z|>2 → drift.
  if (checkType === 'impact_24h') {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const fifteenDaysAgo = new Date(Date.now() - 15 * 86400000).toISOString().slice(0, 10);
    const oneDayAgo = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    const rows = await db
      .select({ date: wbOrdersSalesDailyProducts.date, orders: wbOrdersSalesDailyProducts.ordersCount })
      .from(wbOrdersSalesDailyProducts)
      .where(and(eq(wbOrdersSalesDailyProducts.nmId, expectedNmId), gte(wbOrdersSalesDailyProducts.date, fifteenDaysAgo)));

    const baseline = rows.filter((r) => r.date < oneDayAgo).map((r) => Number(r.orders ?? 0));
    const afterValue = Number(rows.find((r) => r.date === yesterday)?.orders ?? 0);

    if (baseline.length < 7) {
      return {
        result: 'pass',
        details: { level: 'impact_24h', note: 'insufficient baseline (<7d), cannot judge significance', afterValue, baselineDays: baseline.length },
      };
    }

    const mean = baseline.reduce((s, v) => s + v, 0) / baseline.length;
    const variance = baseline.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, baseline.length - 1);
    const stddev = Math.sqrt(variance);
    const zScore = stddev > 0 ? (afterValue - mean) / stddev : 0;
    const deltaPct = mean > 0 ? ((afterValue - mean) / mean) * 100 : null;

    // Classify: |z|>2 = drift (2+ sigma departure). z<-2 = significant drop.
    const verdict: 'pass' | 'drift' = Math.abs(zScore) > 2 ? 'drift' : 'pass';

    return {
      result: verdict,
      details: {
        level: 'impact_24h',
        baselineMean: Number(mean.toFixed(2)),
        baselineStddev: Number(stddev.toFixed(2)),
        baselineDays: baseline.length,
        afterValue,
        zScore: Number(zScore.toFixed(2)),
        deltaPct: deltaPct != null ? Number(deltaPct.toFixed(1)) : null,
        note: verdict === 'drift' ? `|z|>2 — significant deviation from 14d baseline` : 'within 2-sigma band',
      },
    };
  }

  return { result: 'fail', details: { error: 'unknown_check_type', checkType } };
};
