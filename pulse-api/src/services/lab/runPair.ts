/**
 * runPair — end-to-end analysis for one metric pair (x, y).
 *
 * Orchestrates:
 *   1. buildMetricSeries for x and y (shop-scoped)
 *   2. alignPair + optional holiday mask
 *   3. sparsityCheck on both — early exit if blocked
 *   4. pickMethod + correlationReport (honours sparsity permissions)
 *   5. Winsorized re-run → noiseDelta
 *   6. Optional lagCrossCorr when pair is a recognised "causal" candidate
 */

import { buildMetricSeries } from './buildMetricSeries.js';
import type { MetricKey } from './metrics.js';
import {
  alignPair,
  applyMask,
  sparsityCheck,
  sparsityPair,
  type SparsityReport,
} from '../../lib/stat/series.js';
import {
  correlationReport,
  pickMethod,
  type CorrelationReport,
} from '../../lib/stat/correlation.js';
import { winsorize } from '../../lib/calc/winsorize.js';
import { lagCrossCorr, type LagCrossCorrReport } from '../../lib/stat/lag.js';

export interface RunPairArgs {
  workspaceId: number;
  shopId: number;
  nmId: bigint | null;
  dateFrom: string;
  dateTo: string;
  x: MetricKey;
  y: MetricKey;
  /** Default true — exclude holiday_calendar days. */
  excludeHolidays?: boolean;
  /** Default true — include lag cross-correlation (±14 days). */
  withLag?: boolean;
}

export interface PairExamples {
  medianX: number;
  medianY: number;
  iqrX: { p25: number; p75: number };
  iqrY: { p25: number; p75: number };
  /** День с максимальным y (при равных y берём более позднюю дату). */
  bestByY: { date: string; x: number; y: number } | null;
  /** День с минимальным y, при условии y > 0. */
  worstByY: { date: string; x: number; y: number } | null;
  /** Среднее по дням верхней трети по y (≥30%). */
  topYBucket: { avgX: number; avgY: number; n: number } | null;
  /** Среднее по дням нижней трети по y (≥30%). */
  bottomYBucket: { avgX: number; avgY: number; n: number } | null;
}

export interface RunPairResult {
  x: MetricKey;
  y: MetricKey;
  /** Count of aligned (x,y) pairs after holiday mask. */
  n: number;
  /** Worst-of sparsity verdict across x and y. */
  sparsity: SparsityReport;
  /** null when sparsity is blocked. */
  correlation: CorrelationReport | null;
  /** Effect of winsorize 5/95: |r_wins − r_raw| */
  noiseDelta: number | null;
  /** Correlation after winsorize applied to both sides. */
  correlationWinsorized: CorrelationReport | null;
  /** Share of (aligned) days that fell on a holiday/WB-sale. */
  holidayOverlap: number;
  lag: LagCrossCorrReport | null;
  /** Machine-readable reasons if result carries warnings. */
  flags: PairFlag[];
  /** Конкретные числа товара для подстановки в InsightCard. null если sparsity заблокировал расчёт. */
  examples: PairExamples | null;
}

export type PairFlag =
  | 'sparsity_blocked'
  | 'sparsity_warn'
  | 'sparsity_degraded'
  | 'noise_suspect'          // noiseDelta > 0.15
  | 'high_holiday_overlap';  // > 30%

export async function runPair(args: RunPairArgs): Promise<RunPairResult> {
  const excludeHolidays = args.excludeHolidays ?? true;
  const withLag = args.withLag ?? true;

  const [xs, ys] = await Promise.all([
    buildMetricSeries({
      workspaceId: args.workspaceId,
      shopId: args.shopId,
      nmId: args.nmId,
      dateFrom: args.dateFrom,
      dateTo: args.dateTo,
      metric: args.x,
    }),
    buildMetricSeries({
      workspaceId: args.workspaceId,
      shopId: args.shopId,
      nmId: args.nmId,
      dateFrom: args.dateFrom,
      dateTo: args.dateTo,
      metric: args.y,
    }),
  ]);

  // Align (strip NaN/null on either side)
  const aligned = alignPair(xs.values, ys.values);
  const mask = aligned.keptIdx.map(i => xs.isHoliday[i]);
  const holidayOverlap = mask.length ? mask.filter(Boolean).length / mask.length : 0;

  // Apply holiday mask if requested. Также собираем даты, синхронные xArr/yArr.
  let xArr = aligned.x;
  let yArr = aligned.y;
  let dateArr = aligned.keptIdx.map(i => xs.dates[i]);
  if (excludeHolidays && mask.some(Boolean)) {
    xArr = applyMask(aligned.x, mask);
    yArr = applyMask(aligned.y, mask);
    dateArr = dateArr.filter((_, i) => !mask[i]);
  }

  const examples = buildPairExamples(xArr, yArr, dateArr);

  const spX = sparsityCheck(xArr);
  const spY = sparsityCheck(yArr);
  const sparsity = sparsityPair(spX, spY);
  const flags: PairFlag[] = [];

  if (sparsity.verdict === 'blocked') {
    return {
      x: args.x, y: args.y, n: xArr.length,
      sparsity, correlation: null,
      noiseDelta: null, correlationWinsorized: null,
      holidayOverlap,
      lag: null,
      flags: ['sparsity_blocked'],
      examples: null,
    };
  }
  if (sparsity.verdict === 'warn')     flags.push('sparsity_warn');
  if (sparsity.verdict === 'degraded') flags.push('sparsity_degraded');

  const method = pickMethod(xArr, yArr, {
    pearson: sparsity.allowPearson,
    spearman: sparsity.allowSpearman,
    kendall: sparsity.allowKendall,
  });
  const corr = correlationReport(xArr, yArr, method);

  // Winsorized re-run for noise diagnostics (only if enough data)
  let noiseDelta: number | null = null;
  let corrWins: CorrelationReport | null = null;
  if (xArr.length >= 15 && Number.isFinite(corr.r)) {
    const xw = winsorize(xArr, 5, 95);
    const yw = winsorize(yArr, 5, 95);
    corrWins = correlationReport(xw, yw, method);
    if (Number.isFinite(corrWins.r)) {
      noiseDelta = Math.abs(corrWins.r - corr.r);
      if (noiseDelta > 0.15) flags.push('noise_suspect');
    }
  }

  if (holidayOverlap > 0.3) flags.push('high_holiday_overlap');

  let lag: LagCrossCorrReport | null = null;
  if (withLag && xArr.length >= 35 && sparsity.allowPearson) {
    // Only meaningful with Pearson-grade data; Kendall lag not supported here.
    lag = lagCrossCorr(xArr, yArr, Math.min(14, Math.floor(xArr.length / 3)), 20);
  }

  return {
    x: args.x, y: args.y, n: xArr.length,
    sparsity, correlation: corr,
    noiseDelta, correlationWinsorized: corrWins,
    holidayOverlap,
    lag,
    flags,
    examples,
  };
}

// ---------------------------------------------------------------------------
// Helpers — конкретные числа товара для подстановки в карточки
// ---------------------------------------------------------------------------

function quantile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return NaN;
  const pos = (sortedAsc.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}

function buildPairExamples(xArr: number[], yArr: number[], dateArr: string[]): PairExamples | null {
  if (xArr.length < 5) return null;
  if (xArr.length !== yArr.length || xArr.length !== dateArr.length) return null;

  const xSorted = [...xArr].sort((a, b) => a - b);
  const ySorted = [...yArr].sort((a, b) => a - b);
  const medianX = quantile(xSorted, 0.5);
  const medianY = quantile(ySorted, 0.5);
  const iqrX = { p25: quantile(xSorted, 0.25), p75: quantile(xSorted, 0.75) };
  const iqrY = { p25: quantile(ySorted, 0.25), p75: quantile(ySorted, 0.75) };

  // best/worst по Y
  const triples = xArr.map((x, i) => ({ date: dateArr[i], x, y: yArr[i] }));
  const byY = [...triples].sort((a, b) => b.y - a.y);
  const bestByY = byY.length > 0 && Number.isFinite(byY[0].y) ? byY[0] : null;
  const positiveByY = triples.filter(t => Number.isFinite(t.y) && t.y > 0).sort((a, b) => a.y - b.y);
  const worstByY = positiveByY.length > 0 ? positiveByY[0] : null;

  // Бакеты top-30% и bottom-30% по Y
  const bucketSize = Math.max(2, Math.floor(triples.length * 0.3));
  const top = byY.slice(0, bucketSize);
  const bot = [...byY].reverse().slice(0, bucketSize);
  const avg = (rows: typeof top, key: 'x' | 'y') =>
    rows.reduce((s, r) => s + r[key], 0) / Math.max(1, rows.length);
  const topYBucket = top.length >= 2
    ? { avgX: avg(top, 'x'), avgY: avg(top, 'y'), n: top.length }
    : null;
  const bottomYBucket = bot.length >= 2
    ? { avgX: avg(bot, 'x'), avgY: avg(bot, 'y'), n: bot.length }
    : null;

  return { medianX, medianY, iqrX, iqrY, bestByY, worstByY, topYBucket, bottomYBucket };
}
