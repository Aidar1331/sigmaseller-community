/**
 * Series primitives for the Лаборатория (correlation lab).
 *
 * Core responsibilities:
 * 1. Descriptive statistics (mean, variance, std, cv) with NaN-safe behaviour.
 * 2. Pair alignment (drop rows where either side is null/NaN).
 * 3. Holiday/promo mask application.
 * 4. Sparsity guard — THE critical gate. Low-volume SKUs are the dominant
 *    source of false insights in e-commerce analytics. Per project plan
 *    (dazzling-gliding-rivest.md §1.7.1) we prefer a hard block over a
 *    shaky correlation number.
 *
 * All functions are pure and synchronous. No I/O, no DB access — SQL layer
 * delivers aligned daily arrays; this module judges and transforms them.
 */

// ---------------------------------------------------------------------------
// Descriptive stats
// ---------------------------------------------------------------------------

/** Arithmetic mean. Returns 0 for empty arrays (do NOT rely on this for CV — see mustHaveMean). */
export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** Sample variance with Bessel correction (n-1). Returns 0 for n<2. */
export function variance(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  let acc = 0;
  for (const v of values) {
    const d = v - m;
    acc += d * d;
  }
  return acc / (values.length - 1);
}

/** Sample standard deviation (Bessel). */
export function std(values: readonly number[]): number {
  return Math.sqrt(variance(values));
}

/**
 * Coefficient of variation = std / |mean|.
 * Returns Infinity when |mean| is effectively zero — caller decides how to
 * treat that (usually "quasi-constant" warning).
 */
export function cv(values: readonly number[]): number {
  const m = mean(values);
  if (Math.abs(m) < 1e-12) return Infinity;
  return std(values) / Math.abs(m);
}

/** Count of non-zero entries. NaN/null values are ignored. */
export function nonZeroCount(values: readonly number[]): number {
  let c = 0;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v !== 0) c++;
  }
  return c;
}

/** Distinct finite values (cardinality). Used to reject quasi-constant series. */
export function uniqueValueCount(values: readonly number[]): number {
  const set = new Set<number>();
  for (const v of values) {
    if (Number.isFinite(v)) set.add(v);
  }
  return set.size;
}

// ---------------------------------------------------------------------------
// Alignment
// ---------------------------------------------------------------------------

export interface AlignedPair {
  x: number[];
  y: number[];
  /** Indices (into the original length-n input) that survived alignment. */
  keptIdx: number[];
  /** Dropped count. Useful for diagnostics. */
  dropped: number;
}

/**
 * Drop rows where either side is null/NaN/undefined. Preserves order.
 * Arrays MUST be the same length — series.ts only handles pre-aligned daily
 * arrays built by buildMetricSeries (SQL layer).
 */
export function alignPair(
  x: ReadonlyArray<number | null | undefined>,
  y: ReadonlyArray<number | null | undefined>,
): AlignedPair {
  if (x.length !== y.length) {
    throw new Error(`alignPair: length mismatch ${x.length} vs ${y.length}`);
  }
  const xs: number[] = [];
  const ys: number[] = [];
  const kept: number[] = [];
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const yi = y[i];
    if (xi == null || yi == null) continue;
    if (!Number.isFinite(xi) || !Number.isFinite(yi)) continue;
    xs.push(xi as number);
    ys.push(yi as number);
    kept.push(i);
  }
  return { x: xs, y: ys, keptIdx: kept, dropped: x.length - xs.length };
}

/**
 * Apply a boolean mask (e.g. holiday_calendar) — keep only indices where
 * mask[i] === false. Length-checked.
 */
export function applyMask(
  values: readonly number[],
  mask: readonly boolean[],
): number[] {
  if (values.length !== mask.length) {
    throw new Error(`applyMask: length mismatch ${values.length} vs ${mask.length}`);
  }
  const out: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (!mask[i]) out.push(values[i]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sparsity guard — THE MVP critical gate
// ---------------------------------------------------------------------------

export type SparsityVerdict = 'ok' | 'warn' | 'degraded' | 'blocked';

export interface SparsityReport {
  verdict: SparsityVerdict;
  /** share of zero values in [0,1] */
  zeroShare: number;
  /** count of non-zero finite entries */
  nonZeroCount: number;
  /** distinct finite values */
  uniqueValues: number;
  /** coefficient of variation (may be Infinity) */
  cv: number;
  /** number of observations passed in */
  n: number;
  /** machine-readable reasons firing the verdict (at least one for non-ok) */
  reasons: SparsityReason[];
  /** human-readable one-liner for UI banner */
  message: string;
  /** downstream toggles — what correlations may run */
  allowPearson: boolean;
  allowSpearman: boolean;
  allowKendall: boolean;
  /** if verdict === 'blocked', suggest escalating daily → weekly etc. */
  recommendation?: 'aggregate_weekly' | 'extend_period' | 'use_ab_test' | 'use_abc';
}

export type SparsityReason =
  | 'too_many_zeros'
  | 'too_few_nonzero'
  | 'quasi_constant'
  | 'low_cardinality'
  | 'too_few_observations';

export interface SparsityOptions {
  /** Minimum active (non-zero) observations for daily analysis. Default 10. */
  minNonZero?: number;
  /** Minimum unique values (guards against constant/near-constant series). Default 5. */
  minUniqueValues?: number;
  /** Minimum total observations. Default 14 (two WB weeks). */
  minN?: number;
  /** CV below this → quasi-constant warning. Default 0.02 (2%). */
  minCv?: number;
}

const DEFAULTS: Required<SparsityOptions> = {
  minNonZero: 10,
  minUniqueValues: 5,
  minN: 14,
  minCv: 0.02,
};

/**
 * Judge whether a single series is suitable for correlation analysis.
 *
 * Verdict ladder (first matching rule wins):
 *   blocked   → unusable; UI must hide all numbers and offer recommendation
 *   degraded  → Kendall τ only, no p-value/CI, categorical strength label
 *   warn      → Pearson OFF, Spearman primary, yellow banner
 *   ok        → all methods available
 *
 * Per plan §1.7.1 we refuse to emit a number we do not trust.
 */
export function sparsityCheck(
  values: readonly number[],
  opts: SparsityOptions = {},
): SparsityReport {
  const o = { ...DEFAULTS, ...opts };
  const n = values.length;
  const finite = values.filter(Number.isFinite);
  const nz = nonZeroCount(finite);
  const uniq = uniqueValueCount(finite);
  const zeroShare = n === 0 ? 1 : 1 - nz / n;
  const cvValue = finite.length >= 2 ? cv(finite) : Infinity;
  const reasons: SparsityReason[] = [];

  // ----- Hard blocks — insufficient material to even try -----
  if (n < o.minN) {
    reasons.push('too_few_observations');
    return mkReport({
      verdict: 'blocked',
      zeroShare, nonZeroCount: nz, uniqueValues: uniq, cv: cvValue, n, reasons,
      message: `Недостаточно наблюдений: ${n} < ${o.minN} дней. Расширьте период.`,
      allowPearson: false, allowSpearman: false, allowKendall: false,
      recommendation: 'extend_period',
    });
  }
  if (nz < o.minNonZero) {
    reasons.push('too_few_nonzero');
    return mkReport({
      verdict: 'blocked',
      zeroShare, nonZeroCount: nz, uniqueValues: uniq, cv: cvValue, n, reasons,
      message: `Слишком мало активных дней: ${nz} < ${o.minNonZero}. Товар редкий — переключитесь на недельную группировку или ABC-отчёт.`,
      allowPearson: false, allowSpearman: false, allowKendall: false,
      recommendation: n >= o.minN * 4 ? 'aggregate_weekly' : 'use_ab_test',
    });
  }
  if (uniq < o.minUniqueValues) {
    reasons.push('low_cardinality');
    return mkReport({
      verdict: 'blocked',
      zeroShare, nonZeroCount: nz, uniqueValues: uniq, cv: cvValue, n, reasons,
      message: `Слишком мало уникальных значений (${uniq} < ${o.minUniqueValues}) — метрика почти константа, корреляция неопределена.`,
      allowPearson: false, allowSpearman: false, allowKendall: false,
      recommendation: 'use_ab_test',
    });
  }
  if (zeroShare > 0.7) {
    reasons.push('too_many_zeros');
    return mkReport({
      verdict: 'blocked',
      zeroShare, nonZeroCount: nz, uniqueValues: uniq, cv: cvValue, n, reasons,
      message: `В ${Math.round(zeroShare * 100)}% дней значение = 0. Корреляция на таком ряду не имеет смысла.`,
      allowPearson: false, allowSpearman: false, allowKendall: false,
      recommendation: n >= o.minN * 4 ? 'aggregate_weekly' : 'use_abc',
    });
  }

  // ----- Degraded — only categorical Kendall -----
  if (zeroShare > 0.5) {
    reasons.push('too_many_zeros');
    return mkReport({
      verdict: 'degraded',
      zeroShare, nonZeroCount: nz, uniqueValues: uniq, cv: cvValue, n, reasons,
      message: `${Math.round(zeroShare * 100)}% нулевых дней — доступен только категориальный Kendall τ (Слабая/Умеренная/Сильная).`,
      allowPearson: false, allowSpearman: false, allowKendall: true,
    });
  }

  // ----- Warn — Spearman/Kendall OK, Pearson off -----
  if (zeroShare > 0.3) {
    reasons.push('too_many_zeros');
    return mkReport({
      verdict: 'warn',
      zeroShare, nonZeroCount: nz, uniqueValues: uniq, cv: cvValue, n, reasons,
      message: `${Math.round(zeroShare * 100)}% нулевых дней — результат ориентировочный. Pearson отключён, используйте Spearman.`,
      allowPearson: false, allowSpearman: true, allowKendall: true,
    });
  }
  if (Number.isFinite(cvValue) && cvValue < o.minCv) {
    reasons.push('quasi_constant');
    return mkReport({
      verdict: 'warn',
      zeroShare, nonZeroCount: nz, uniqueValues: uniq, cv: cvValue, n, reasons,
      message: `Ряд почти константен (CV=${(cvValue * 100).toFixed(1)}%). Корреляция может быть шумом.`,
      allowPearson: true, allowSpearman: true, allowKendall: true,
    });
  }

  return mkReport({
    verdict: 'ok',
    zeroShare, nonZeroCount: nz, uniqueValues: uniq, cv: cvValue, n, reasons,
    message: 'Ряд пригоден для анализа.',
    allowPearson: true, allowSpearman: true, allowKendall: true,
  });
}

/** Combine two sparsity reports into the worst-of verdict for a pair (x,y). */
export function sparsityPair(a: SparsityReport, b: SparsityReport): SparsityReport {
  const order: Record<SparsityVerdict, number> = { ok: 0, warn: 1, degraded: 2, blocked: 3 };
  const worst = order[a.verdict] >= order[b.verdict] ? a : b;
  return {
    ...worst,
    allowPearson: a.allowPearson && b.allowPearson,
    allowSpearman: a.allowSpearman && b.allowSpearman,
    allowKendall: a.allowKendall && b.allowKendall,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function mkReport(r: Omit<SparsityReport, never>): SparsityReport {
  return r;
}
