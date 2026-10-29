/**
 * runMatrix — pairwise correlation matrix across a metric set.
 *
 * Design choices:
 *   - We do NOT run runPair for each of the N(N-1)/2 pairs because that
 *     refetches every series N-1 times. Instead, buildMetricSeries runs
 *     once per metric, then pairs are computed in-memory.
 *   - BH-FDR correction is applied across all N(N-1)/2 p-values — without
 *     it one spurious "significant" pair appears by chance at α=0.05 for
 *     every ~20 tests (28 pairs at N=8 → 1.4 false positives under H0).
 *   - Sparsity guard runs per-metric, then pair-wise combines via worst-of.
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
  type CorrelationMethod,
} from '../../lib/stat/correlation.js';
import { benjaminiHochberg } from '../../lib/stat/multipleTest.js';

export interface RunMatrixArgs {
  workspaceId: number;
  shopId: number;
  nmId: bigint | null;
  dateFrom: string;
  dateTo: string;
  metrics: MetricKey[];
  excludeHolidays?: boolean;
  /** FDR level for the `significant` flag. Default 0.1. */
  fdrQ?: number;
}

export interface MatrixCell {
  x: MetricKey;
  y: MetricKey;
  /** Null when the pair is sparsity-blocked. */
  r: number | null;
  /** Raw p-value (uncorrected). Null if r is null. */
  p: number | null;
  /** BH-corrected q-value over the triangular matrix. Null if r is null. */
  q: number | null;
  n: number;
  method: CorrelationMethod | null;
  sparsity: SparsityReport['verdict'];
  /** True iff q ≤ fdrQ (default 0.1). Conservative: NaN q → false. */
  significant: boolean;
}

export interface RunMatrixResult {
  metrics: MetricKey[];
  /** All N(N-1)/2 unique cells (upper triangle only). */
  cells: MatrixCell[];
  /** Cells that passed BH-FDR, sorted by |r| descending. */
  significantCells: MatrixCell[];
  /** FDR level applied. */
  fdrQ: number;
  /** Days in period. */
  n: number;
}

export async function runMatrix(args: RunMatrixArgs): Promise<RunMatrixResult> {
  const excludeHolidays = args.excludeHolidays ?? true;
  const fdrQ = args.fdrQ ?? 0.1;
  const uniq = Array.from(new Set(args.metrics));

  // 1. Fetch every series once.
  const seriesByKey = new Map<MetricKey, Awaited<ReturnType<typeof buildMetricSeries>>>();
  const fetched = await Promise.all(
    uniq.map(m => buildMetricSeries({
      workspaceId: args.workspaceId,
      shopId: args.shopId,
      nmId: args.nmId,
      dateFrom: args.dateFrom,
      dateTo: args.dateTo,
      metric: m,
    })),
  );
  for (let i = 0; i < uniq.length; i++) seriesByKey.set(uniq[i], fetched[i]);

  // 2. Build upper-triangle cells
  const cells: MatrixCell[] = [];
  for (let i = 0; i < uniq.length; i++) {
    for (let j = i + 1; j < uniq.length; j++) {
      const a = uniq[i];
      const b = uniq[j];
      cells.push(computeCell(a, b, seriesByKey, excludeHolidays));
    }
  }

  // 3. BH-FDR correction across ALL pair p-values
  const pVec = cells.map(c => c.p == null ? NaN : c.p);
  const qVec = benjaminiHochberg(pVec);
  for (let i = 0; i < cells.length; i++) {
    cells[i].q = Number.isFinite(qVec[i]) ? qVec[i] : null;
    cells[i].significant = Number.isFinite(qVec[i]) && qVec[i] <= fdrQ;
  }

  const significantCells = cells
    .filter(c => c.significant)
    .sort((x, y) => Math.abs((y.r ?? 0)) - Math.abs((x.r ?? 0)));

  return {
    metrics: uniq,
    cells,
    significantCells,
    fdrQ,
    n: fetched[0]?.dates.length ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Per-cell computation
// ---------------------------------------------------------------------------

function computeCell(
  a: MetricKey,
  b: MetricKey,
  series: Map<MetricKey, Awaited<ReturnType<typeof buildMetricSeries>>>,
  excludeHolidays: boolean,
): MatrixCell {
  const sa = series.get(a)!;
  const sb = series.get(b)!;
  const aligned = alignPair(sa.values, sb.values);
  const mask = aligned.keptIdx.map(i => sa.isHoliday[i]);

  let xArr = aligned.x;
  let yArr = aligned.y;
  if (excludeHolidays && mask.some(Boolean)) {
    xArr = applyMask(aligned.x, mask);
    yArr = applyMask(aligned.y, mask);
  }

  const spX = sparsityCheck(xArr);
  const spY = sparsityCheck(yArr);
  const sp = sparsityPair(spX, spY);

  if (sp.verdict === 'blocked') {
    return {
      x: a, y: b, r: null, p: null, q: null,
      n: xArr.length, method: null, sparsity: 'blocked', significant: false,
    };
  }

  const method = pickMethod(xArr, yArr, {
    pearson: sp.allowPearson,
    spearman: sp.allowSpearman,
    kendall: sp.allowKendall,
  });
  const report = correlationReport(xArr, yArr, method);

  return {
    x: a, y: b,
    r: Number.isFinite(report.r) ? report.r : null,
    p: Number.isFinite(report.p) ? report.p : null,
    q: null,  // filled after BH pass
    n: xArr.length,
    method,
    sparsity: sp.verdict,
    significant: false,
  };
}
