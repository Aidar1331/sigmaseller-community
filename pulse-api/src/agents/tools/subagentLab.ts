/**
 * subagent_lab — delegate correlation / elasticity / lag analysis.
 *
 * The AI assistant calls this tool when a user asks WHY metrics move
 * together, WHICH actions would shift KPIs, or WHETHER ad spend actually
 * drives orders. The tool returns a compact structured insight bundle;
 * presentation is the agent's job.
 *
 * Shop isolation: _shopId is mandatory (injected by executeNode). Without
 * it the lab refuses to run — we will not correlate across shops.
 *
 * Safe query — no mutations, not in DANGEROUS_TOOLS.
 */

import { runMatrix } from '../../services/lab/runMatrix.js';
import { rankInsights } from '../../services/lab/insightEngine.js';
import { runPair } from '../../services/lab/runPair.js';
import { buildMetricSeries } from '../../services/lab/buildMetricSeries.js';
import { advisePeriod, countDays } from '../../services/lab/periodAdvisor.js';
import { DEFAULT_MATRIX_METRICS, METRICS, type MetricKey } from '../../services/lab/metrics.js';
import { priceElasticity } from '../../lib/stat/elasticity.js';
import { alignPair } from '../../lib/stat/series.js';
import { HYPOTHESES } from '../../services/lab/hypothesisRegistry.js';
import { log as rootLog } from '../../lib/logger.js';

const log = rootLog.child({ module: 'subagentLab' });

export interface SubagentLabArgs {
  /** User's question — used only for logs. */
  userIntent?: string;
  /** Required nm_id. Correlation on shop aggregate exists but usually less useful. */
  nmId?: number;
  /** YYYY-MM-DD */
  from: string;
  /** YYYY-MM-DD inclusive */
  to: string;
  /** Narrow the scan. 'all' = default matrix. */
  focus?: 'price' | 'ads' | 'seo' | 'stock' | 'all';
  /** Drop holiday/promo days. Default true. */
  excludeHolidays?: boolean;
  // magic args
  _workspaceId?: number;
  _shopId?: number;
  _userId?: number;
}

const FOCUS_METRICS: Record<NonNullable<SubagentLabArgs['focus']>, MetricKey[]> = {
  all:   DEFAULT_MATRIX_METRICS,
  price: ['finishedPriceRub', 'sppPct', 'sellerDiscountPct', 'ordersCount', 'marginPct'],
  ads:   ['advSpendRub', 'drrPercent', 'viewCount', 'ordersCount'],
  seo:   ['positionBest', 'viewCount', 'ordersCount', 'keywordsInTop10'],
  stock: ['stockQty', 'daysOfStock', 'ordersCount', 'marginPct'],
};

/**
 * Entry point. Returns a JSON string — the LangGraph harness expects string
 * tool outputs.
 */
export async function subagentLab(args: SubagentLabArgs): Promise<string> {
  const wsId = args._workspaceId;
  const shopId = args._shopId;
  if (!wsId || !shopId) {
    return JSON.stringify({
      error: 'missing_context',
      message: 'Лаборатория требует workspace + shop. Попросите пользователя выбрать магазин.',
    });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.from) || !/^\d{4}-\d{2}-\d{2}$/.test(args.to)) {
    return JSON.stringify({
      error: 'invalid_period',
      message: 'Период должен быть в формате YYYY-MM-DD.',
    });
  }

  const focus = args.focus ?? 'all';
  const nmId = args.nmId ? BigInt(args.nmId) : null;
  // price_locf metrics (list price / SPP / seller discount) are per-nmId only —
  // LOCF at shop-aggregate is meaningless. Drop them when no nmId provided.
  const metrics = FOCUS_METRICS[focus].filter(m => {
    if (nmId !== null) return true;
    return METRICS[m].source !== 'price_locf';
  });
  const excludeHolidays = args.excludeHolidays ?? true;
  const n = countDays(args.from, args.to);
  const advice = advisePeriod(n);

  log.info({
    wsId, shopId, nmId: args.nmId, from: args.from, to: args.to,
    focus, metricsCount: metrics.length, userIntent: args.userIntent,
  }, 'subagent_lab invoked');

  if (advice.badge === 'red') {
    return JSON.stringify({
      status: 'period_too_short',
      advice,
      message: 'Период слишком короткий — корреляции будут шумом. Расширьте до 30+ дней.',
    });
  }

  try {
    // Matrix scan (fast, one fetch per metric)
    const matrix = await runMatrix({
      workspaceId: wsId,
      shopId,
      nmId,
      dateFrom: args.from,
      dateTo: args.to,
      metrics,
      excludeHolidays,
    });

    // Rebuild runPair results for each MVP-relevant hypothesis so
    // insightEngine can produce narratives. Only pairs inside our metric set.
    const relevantPairs: Array<[MetricKey, MetricKey]> = [];
    const seen = new Set<string>();
    for (const h of HYPOTHESES) {
      if (!h.mvpEnabled) continue;
      const [a, b] = h.metricsPair;
      if (!metrics.includes(a) || !metrics.includes(b)) continue;
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      relevantPairs.push([a, b]);
    }

    const pairResults = (await Promise.all(
      relevantPairs.map(([x, y]) =>
        runPair({
          workspaceId: wsId, shopId, nmId,
          dateFrom: args.from, dateTo: args.to,
          x, y,
          excludeHolidays,
          withLag: true,
        }).catch(err => {
          log.warn({ err: err.message, x, y }, 'runPair failed; skipping');
          return null;
        })),
    )).filter(Boolean) as Array<Exclude<Awaited<ReturnType<typeof runPair>>, null>>;

    const insights = rankInsights(pairResults);
    const critical = insights.filter(i => i.category === 'critical').slice(0, 3);
    const growth   = insights.filter(i => i.category === 'growth_point').slice(0, 5);
    const falseAlarms = insights.filter(i => i.category === 'false_alarm').slice(0, 3);

    // Elasticity — only meaningful at nmId level, and only when price focus
    // is in scope.
    let elasticity: Awaited<ReturnType<typeof priceElasticity>> | null = null;
    if (nmId !== null && (focus === 'all' || focus === 'price')) {
      const priceSeries = await buildMetricSeries({
        workspaceId: wsId, shopId, nmId,
        dateFrom: args.from, dateTo: args.to,
        metric: 'finishedPriceRub',
      });
      const qtySeries = await buildMetricSeries({
        workspaceId: wsId, shopId, nmId,
        dateFrom: args.from, dateTo: args.to,
        metric: 'ordersCount',
      });
      const aligned = alignPair(priceSeries.values, qtySeries.values);
      elasticity = priceElasticity(aligned.x, aligned.y);
    }

    // Compact summary — the agent will format this for the user.
    // Additionally, build a `widgets` array for inline rendering in AI chat
    // (WIDGET_REGISTRY['lab_insight'] picks them up). Pair it with each
    // insight so the chat shows 1-3 cards вместо портянки JSON.
    const topInsights = [...critical, ...growth, ...falseAlarms].slice(0, 3);
    const widgets = topInsights.map(i => ({
      type: 'lab_insight',
      props: {
        insight: {
          hypothesisId: i.hypothesisId,
          category: i.category,
          hypothesisText: i.hypothesisText,
          hypothesisCategory: i.hypothesisCategory,
          bucket: i.bucket,
          r: i.r,
          p: i.p,
          n: i.n,
          method: i.method,
          interpretation: i.interpretation,
          decision: i.decision,
          noiseRisk: i.noiseRisk,
          flags: i.flags,
          confidence: i.confidence,
          bestLag: i.bestLag,
        },
        nmId: args.nmId ?? null,
      },
    }));

    return JSON.stringify({
      status: 'ok',
      period: { from: args.from, to: args.to, n },
      advice: {
        badge: advice.badge,
        message: advice.message,
      },
      shopId,
      nmId: args.nmId ?? null,
      focus,
      matrix: {
        metrics: matrix.metrics,
        significantPairs: matrix.significantCells.slice(0, 8).map(c => ({
          x: c.x, y: c.y, r: round3(c.r), p: round3(c.p), q: round3(c.q), n: c.n, method: c.method,
        })),
        totalPairs: matrix.cells.length,
      },
      insights: {
        critical: critical.map(compressInsight),
        growth: growth.map(compressInsight),
        falseAlarms: falseAlarms.map(compressInsight),
      },
      elasticity: elasticity && elasticity.status === 'ok' ? {
        E: round3(elasticity.E),
        classification: elasticity.classification,
        r2: round3(elasticity.r2),
        ci95: { lower: round3(elasticity.ci95.lower), upper: round3(elasticity.ci95.upper) },
        n: elasticity.n,
      } : elasticity ? {
        status: elasticity.status,
        reasons: elasticity.reasons,
      } : null,
      widgets,
      widgetHint: pickWidgetHint(critical, growth, elasticity),
    });
  } catch (err: any) {
    log.error({ err: err?.message, stack: err?.stack }, 'subagent_lab failed');
    return JSON.stringify({
      error: 'lab_failure',
      message: err?.message ?? 'Unknown error in lab pipeline',
    });
  }
}

// ---------------------------------------------------------------------------

function round3(x: number | null | undefined): number | null {
  if (x === null || x === undefined || !Number.isFinite(x)) return null;
  return Math.round(x * 1000) / 1000;
}

function compressInsight(i: ReturnType<typeof rankInsights>[number]) {
  return {
    id: i.hypothesisId,
    category: i.hypothesisCategory,
    hypothesis: i.hypothesisText,
    r: round3(i.r),
    p: round3(i.p),
    n: i.n,
    method: i.method,
    interpretation: i.interpretation,
    decision: i.decision,
    noiseRisk: i.noiseRisk,
    confidence: i.confidence,
    bestLag: i.bestLag,
  };
}

type Insight = ReturnType<typeof rankInsights>[number];

function pickWidgetHint(
  critical: Insight[],
  growth: Insight[],
  elasticity: Awaited<ReturnType<typeof priceElasticity>> | null,
): string {
  if (critical.length > 0) return 'HypothesisCardWidget';
  if (elasticity && elasticity.status === 'ok') return 'ElasticityCardWidget';
  if (growth.length > 0) return 'CorrelationMatrixWidget';
  return 'HypothesisCardWidget';
}
