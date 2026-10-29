/**
 * Correlation primitives — Pearson, Spearman, Kendall τ-b + significance tests.
 *
 * All functions assume x.length === y.length and inputs are pre-aligned (no
 * NaN/null) — the caller (runPair in services/lab) uses series.alignPair first.
 *
 * Sparsity guard is a SEPARATE concern (series.sparsityCheck). This file
 * computes numbers; it does not decide whether the numbers are trustworthy.
 */

import { mean, std } from './series.js';

// ---------------------------------------------------------------------------
// Pearson product-moment r
// ---------------------------------------------------------------------------

/**
 * Pearson correlation. Returns NaN when either series is constant (undefined).
 *
 * r = Σ(xᵢ − x̄)(yᵢ − ȳ) / √[Σ(xᵢ − x̄)² · Σ(yᵢ − ȳ)²]
 */
export function pearson(x: readonly number[], y: readonly number[]): number {
  assertSameLength(x, y);
  const n = x.length;
  if (n < 2) return NaN;
  const mx = mean(x);
  const my = mean(y);
  let num = 0;
  let dx2 = 0;
  let dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  if (denom < 1e-15) return NaN;
  return num / denom;
}

// ---------------------------------------------------------------------------
// Spearman ρ  (Pearson over ranks with proper mid-ranks for ties)
// ---------------------------------------------------------------------------

export function spearman(x: readonly number[], y: readonly number[]): number {
  assertSameLength(x, y);
  if (x.length < 2) return NaN;
  return pearson(rank(x), rank(y));
}

/**
 * Assign ranks using average-rank for ties (fractional midranks).
 * E.g. [10, 20, 20, 30] → [1, 2.5, 2.5, 4].
 */
export function rank(values: readonly number[]): number[] {
  const n = values.length;
  const idx = Array.from({ length: n }, (_, i) => i);
  idx.sort((a, b) => values[a] - values[b]);
  const ranks = new Array<number>(n);
  let i = 0;
  while (i < n) {
    let j = i;
    // walk across a run of ties
    while (j + 1 < n && values[idx[j + 1]] === values[idx[i]]) j++;
    const avg = (i + j) / 2 + 1; // 1-based average rank
    for (let k = i; k <= j; k++) ranks[idx[k]] = avg;
    i = j + 1;
  }
  return ranks;
}

// ---------------------------------------------------------------------------
// Kendall τ-b (tie-adjusted). O(n²) — fine for our n ≤ 365.
// ---------------------------------------------------------------------------

export function kendall(x: readonly number[], y: readonly number[]): number {
  assertSameLength(x, y);
  const n = x.length;
  if (n < 2) return NaN;
  let concordant = 0;
  let discordant = 0;
  let tiesX = 0;
  let tiesY = 0;
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = x[j] - x[i];
      const dy = y[j] - y[i];
      if (dx === 0 && dy === 0) continue; // joint tie — τ-b excludes entirely
      if (dx === 0) { tiesX++; continue; }
      if (dy === 0) { tiesY++; continue; }
      if (dx * dy > 0) concordant++;
      else discordant++;
    }
  }
  const n0 = (n * (n - 1)) / 2;
  const denom = Math.sqrt((n0 - tiesX) * (n0 - tiesY));
  if (denom < 1e-15) return NaN;
  return (concordant - discordant) / denom;
}

// ---------------------------------------------------------------------------
// Significance — t-test for Pearson/Spearman, asymptotic z for Kendall
// ---------------------------------------------------------------------------

/**
 * Two-sided p-value for Pearson/Spearman r with Student's-t approximation.
 *   t = r·√((n−2)/(1−r²)),  df = n − 2
 */
export function pValueTTest(r: number, n: number): number {
  if (!Number.isFinite(r) || n < 3) return NaN;
  const rClamped = Math.max(-0.999999, Math.min(0.999999, r));
  const t = rClamped * Math.sqrt((n - 2) / (1 - rClamped * rClamped));
  const df = n - 2;
  return 2 * (1 - studentTcdf(Math.abs(t), df));
}

/**
 * Two-sided p-value for Kendall τ using the normal approximation
 *   z = 3·τ·√(n(n−1)) / √(2(2n+5))
 */
export function pValueKendall(tau: number, n: number): number {
  if (!Number.isFinite(tau) || n < 4) return NaN;
  const z = (3 * tau * Math.sqrt(n * (n - 1))) / Math.sqrt(2 * (2 * n + 5));
  return 2 * (1 - normalCdf(Math.abs(z)));
}

// ---------------------------------------------------------------------------
// Confidence intervals
// ---------------------------------------------------------------------------

export interface CI { lower: number; upper: number; level: number }

/**
 * Fisher z-transform CI95 for Pearson r (also a fair approximation for Spearman).
 *   z = atanh(r),  SE = 1/√(n−3),  CI on z, then tanh back.
 */
export function fisherCI(r: number, n: number, level = 0.95): CI {
  if (!Number.isFinite(r) || n < 4) return { lower: NaN, upper: NaN, level };
  const z = Math.atanh(Math.max(-0.999999, Math.min(0.999999, r)));
  const se = 1 / Math.sqrt(n - 3);
  const crit = normalInv(0.5 + level / 2); // 1.959964 for 95%
  return { lower: Math.tanh(z - crit * se), upper: Math.tanh(z + crit * se), level };
}

// ---------------------------------------------------------------------------
// Report builder
// ---------------------------------------------------------------------------

export type CorrelationMethod = 'pearson' | 'spearman' | 'kendall';

export interface CorrelationReport {
  method: CorrelationMethod;
  r: number;
  /** p-value (two-sided, appropriate to method) */
  p: number;
  n: number;
  ci95: CI;
  /** Rough strength label ignoring significance — UI fallback when p is N/A. */
  strength: 'none' | 'weak' | 'moderate' | 'strong';
  /** sign ignoring magnitude */
  direction: 'positive' | 'negative' | 'zero';
}

export function correlationReport(
  x: readonly number[],
  y: readonly number[],
  method: CorrelationMethod,
): CorrelationReport {
  const n = x.length;
  let r: number;
  let p: number;
  if (method === 'pearson') {
    r = pearson(x, y);
    p = pValueTTest(r, n);
  } else if (method === 'spearman') {
    r = spearman(x, y);
    p = pValueTTest(r, n);
  } else {
    r = kendall(x, y);
    p = pValueKendall(r, n);
  }
  return {
    method,
    r,
    p,
    n,
    ci95: fisherCI(r, n),
    strength: strengthLabel(r),
    direction: r > 0 ? 'positive' : r < 0 ? 'negative' : 'zero',
  };
}

export function strengthLabel(r: number): 'none' | 'weak' | 'moderate' | 'strong' {
  if (!Number.isFinite(r)) return 'none';
  const a = Math.abs(r);
  if (a < 0.3) return 'weak';
  if (a < 0.7) return 'moderate';
  return 'strong';
}

// ---------------------------------------------------------------------------
// Auto-method selection via simple normality heuristic (Shapiro substitute)
// ---------------------------------------------------------------------------

/**
 * Pick correlation method for a pair given sparsity permissions and a
 * lightweight symmetry/tail heuristic. NOT a real Shapiro–Wilk — that would
 * be a 200-line port; for our purposes (n ≤ 365) skewness + excess kurtosis
 * suffice:
 *
 *   "approximately normal"  ⇔  |skew| < 1  AND  |excessKurt| < 1.5
 *
 * - If caller passes `allowPearson=false` (from sparsityCheck) we never pick Pearson.
 * - If n < 15 we prefer Kendall (more stable for tiny n).
 */
export function pickMethod(
  x: readonly number[],
  y: readonly number[],
  allow: { pearson: boolean; spearman: boolean; kendall: boolean },
): CorrelationMethod {
  const n = x.length;
  if (n < 15) {
    if (allow.kendall) return 'kendall';
    if (allow.spearman) return 'spearman';
    return 'pearson';
  }
  const xNormal = isApproxNormal(x);
  const yNormal = isApproxNormal(y);
  if (xNormal && yNormal && allow.pearson) return 'pearson';
  if (allow.spearman) return 'spearman';
  if (allow.kendall) return 'kendall';
  return 'pearson'; // last resort
}

export function isApproxNormal(values: readonly number[]): boolean {
  if (values.length < 8) return false;
  const m = mean(values);
  const s = std(values);
  if (s < 1e-12) return false;
  let m3 = 0;
  let m4 = 0;
  for (const v of values) {
    const z = (v - m) / s;
    m3 += z * z * z;
    m4 += z * z * z * z;
  }
  const n = values.length;
  const skew = m3 / n;
  const excessKurt = m4 / n - 3;
  return Math.abs(skew) < 1 && Math.abs(excessKurt) < 1.5;
}

// ---------------------------------------------------------------------------
// Distribution helpers (self-contained — no scipy, no jstat)
// ---------------------------------------------------------------------------

/**
 * CDF of standard normal. Abramowitz & Stegun 7.1.26 via erf.
 * Accuracy ≈ 1.5e-7 — sufficient for p-value reporting.
 */
export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/**
 * Quantile function of standard normal (inverse CDF).
 * Beasley–Springer–Moro algorithm, accuracy ≈ 4.5e-4 in the tails, 1e-8 in
 * the body — plenty for CI critical values.
 */
export function normalInv(p: number): number {
  if (p <= 0 || p >= 1) return p <= 0 ? -Infinity : Infinity;
  // Rational approximation (Peter J. Acklam 2003)
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
             1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
             6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
             -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
             3.754408661907416e+00];
  const plow = 0.02425;
  const phigh = 1 - plow;
  let q: number;
  let r: number;
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
           ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
  if (p <= phigh) {
    q = p - 0.5;
    r = q * q;
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5]) * q /
           (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
          ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
}

/**
 * Student's t CDF via incomplete beta.
 *   F(t; ν) = 1 − ½·I_{ν/(ν+t²)}(ν/2, 1/2)   for t ≥ 0
 */
export function studentTcdf(t: number, df: number): number {
  if (df <= 0) return NaN;
  const x = df / (df + t * t);
  const p = 0.5 * incompleteBeta(x, df / 2, 0.5);
  return t >= 0 ? 1 - p : p;
}

// ----- Special functions ---------------------------------------------------

/** erf via Abramowitz & Stegun 7.1.26, max error ≈ 1.5e-7. */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t
                  - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return sign * y;
}

/**
 * Regularised incomplete beta function I_x(a, b) via Lentz's continued
 * fraction. Numerically stable for 0 < x < 1, a,b > 0.
 */
function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbeta = logGamma(a) + logGamma(b) - logGamma(a + b);
  const bt = Math.exp(-lbeta + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) {
    return (bt * betaCF(x, a, b)) / a;
  }
  return 1 - (bt * betaCF(1 - x, b, a)) / b;
}

function betaCF(x: number, a: number, b: number): number {
  const MAX = 200;
  const EPS = 3e-10;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < 1e-30) d = 1e-30;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAX; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + aa / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + aa / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Lanczos approximation for ln Γ(x), accurate to ≈ 1e-15 for x > 0. */
function logGamma(x: number): number {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091,
             -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += g[j] / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertSameLength(x: readonly number[], y: readonly number[]): void {
  if (x.length !== y.length) {
    throw new Error(`correlation: length mismatch ${x.length} vs ${y.length}`);
  }
}
