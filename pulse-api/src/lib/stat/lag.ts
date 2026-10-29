/**
 * Lag-cross-correlation + Granger causality.
 *
 * Use cases for Pulse Analytics:
 *   - "When does ad spend today translate into orders?" (lag 0..+7)
 *   - "Does SEO position lead/follow orders?" (bidirectional)
 *   - "Is my bid change reaction to drops in DRR or the cause?" (Granger)
 *
 * Small-n friendly: we refuse to compute when effective n (after shift) drops
 * below 20, returning the slot with NaN. Caller (runPair) surfaces this to UI.
 */

import { pearson, pValueTTest, studentTcdf } from './correlation.js';
import { mean } from './series.js';

// ---------------------------------------------------------------------------
// Cross-correlation at a shift of `k` days
// ---------------------------------------------------------------------------

/**
 * Shift y by k and align. Positive k means "x leads y by k days"
 * (y_{t+k} paired with x_t). Negative k means "y leads x".
 */
export function shiftAlign(
  x: readonly number[],
  y: readonly number[],
  k: number,
): { xAligned: number[]; yAligned: number[] } {
  const n = Math.min(x.length, y.length);
  const xa: number[] = [];
  const ya: number[] = [];
  if (k >= 0) {
    for (let i = 0; i < n - k; i++) {
      xa.push(x[i]);
      ya.push(y[i + k]);
    }
  } else {
    const ak = -k;
    for (let i = 0; i < n - ak; i++) {
      xa.push(x[i + ak]);
      ya.push(y[i]);
    }
  }
  return { xAligned: xa, yAligned: ya };
}

export interface LagPoint {
  lag: number;
  r: number;
  p: number;
  n: number;
}

export interface LagCrossCorrReport {
  series: LagPoint[];
  bestLag: number;
  /** |r| at bestLag */
  bestR: number;
  bestP: number;
  /**
   * Hint about who leads:
   *   'x_leads_y'   — best |r| at positive lag and r significant
   *   'y_leads_x'   — at negative lag
   *   'synchronous' — at lag 0
   *   'no_signal'   — best |r| below noise threshold or not significant
   */
  leader: 'x_leads_y' | 'y_leads_x' | 'synchronous' | 'no_signal';
}

/**
 * Full cross-correlation profile across lags in [-maxLag..+maxLag].
 * Requires effective n ≥ minEffectiveN for each lag — undersized lags emit NaN.
 */
export function lagCrossCorr(
  x: readonly number[],
  y: readonly number[],
  maxLag = 14,
  minEffectiveN = 20,
): LagCrossCorrReport {
  const series: LagPoint[] = [];
  for (let k = -maxLag; k <= maxLag; k++) {
    const { xAligned, yAligned } = shiftAlign(x, y, k);
    const n = xAligned.length;
    if (n < minEffectiveN) {
      series.push({ lag: k, r: NaN, p: NaN, n });
      continue;
    }
    const r = pearson(xAligned, yAligned);
    const p = pValueTTest(r, n);
    series.push({ lag: k, r, p, n });
  }
  // Pick best by |r| among finite entries
  let bestLag = 0;
  let bestAbs = -Infinity;
  let bestR = NaN;
  let bestP = NaN;
  for (const pt of series) {
    if (!Number.isFinite(pt.r)) continue;
    const a = Math.abs(pt.r);
    if (a > bestAbs) {
      bestAbs = a;
      bestLag = pt.lag;
      bestR = pt.r;
      bestP = pt.p;
    }
  }
  let leader: LagCrossCorrReport['leader'] = 'no_signal';
  if (Number.isFinite(bestR) && Math.abs(bestR) >= 0.2 && Number.isFinite(bestP) && bestP < 0.1) {
    if (bestLag > 0) leader = 'x_leads_y';
    else if (bestLag < 0) leader = 'y_leads_x';
    else leader = 'synchronous';
  }
  return { series, bestLag, bestR, bestP, leader };
}

// ---------------------------------------------------------------------------
// Granger causality via F-test on VAR(p)
// ---------------------------------------------------------------------------

export interface GrangerReport {
  /** H0: x does NOT Granger-cause y. Lower p → reject → x leads y in predictive sense. */
  pXcausesY: number;
  /** H0: y does NOT Granger-cause x. */
  pYcausesX: number;
  /** F-statistic for x→y */
  Fxy: number;
  /** F-statistic for y→x */
  Fyx: number;
  /** Number of lags used */
  lags: number;
  /** Effective sample size after trimming lags */
  n: number;
  /**
   * Verdict combining both directions:
   *   'x_drives_y' — only x→y rejects at α=0.05
   *   'y_drives_x' — only y→x rejects
   *   'bidirectional' — both reject (feedback loop — common for ads↔orders)
   *   'independent' — neither rejects
   *   'insufficient' — n too small
   */
  verdict: 'x_drives_y' | 'y_drives_x' | 'bidirectional' | 'independent' | 'insufficient';
}

/**
 * Granger-causality test with p lags, default p=2 (captures weekly micro-trends
 * while staying frugal on df). Requires n ≥ 4·(p+1) after trimming.
 *
 * Model (restricted):    yₜ = α₀ + Σᵢ αᵢ·yₜ₋ᵢ                         + εᵣ
 * Model (unrestricted):  yₜ = α₀ + Σᵢ αᵢ·yₜ₋ᵢ + Σᵢ βᵢ·xₜ₋ᵢ           + εᵤ
 * F = [(RSSᵣ − RSSᵤ)/p] / [RSSᵤ/(n − 2p − 1)]   ~  F(p, n − 2p − 1)
 */
export function grangerCausality(
  x: readonly number[],
  y: readonly number[],
  lags = 2,
): GrangerReport {
  if (x.length !== y.length) {
    throw new Error(`grangerCausality: length mismatch ${x.length} vs ${y.length}`);
  }
  const n = x.length - lags;
  const dfDenom = n - 2 * lags - 1;
  if (n < 4 * (lags + 1) || dfDenom <= 0) {
    return {
      pXcausesY: NaN, pYcausesX: NaN, Fxy: NaN, Fyx: NaN,
      lags, n, verdict: 'insufficient',
    };
  }
  const Fxy = fStatGranger(x, y, lags); // does x help predict y?
  const Fyx = fStatGranger(y, x, lags); // does y help predict x?
  const pXcausesY = fCdfUpperTail(Fxy, lags, dfDenom);
  const pYcausesX = fCdfUpperTail(Fyx, lags, dfDenom);
  let verdict: GrangerReport['verdict'] = 'independent';
  const sigXY = pXcausesY < 0.05;
  const sigYX = pYcausesX < 0.05;
  if (sigXY && sigYX) verdict = 'bidirectional';
  else if (sigXY) verdict = 'x_drives_y';
  else if (sigYX) verdict = 'y_drives_x';
  return { pXcausesY, pYcausesX, Fxy, Fyx, lags, n, verdict };
}

/**
 * Does `cause` Granger-cause `effect`?  Returns the F-statistic.
 * NaN if either model is degenerate (e.g. constant effect series).
 */
function fStatGranger(
  cause: readonly number[],
  effect: readonly number[],
  p: number,
): number {
  const n = effect.length - p;
  // Build design matrices
  const yVec: number[] = [];
  const Xr: number[][] = []; // restricted: 1 + p lags of effect
  const Xu: number[][] = []; // unrestricted: 1 + p lags of effect + p lags of cause
  for (let t = p; t < effect.length; t++) {
    yVec.push(effect[t]);
    const rowR = [1];
    const rowU = [1];
    for (let k = 1; k <= p; k++) {
      rowR.push(effect[t - k]);
      rowU.push(effect[t - k]);
    }
    for (let k = 1; k <= p; k++) {
      rowU.push(cause[t - k]);
    }
    Xr.push(rowR);
    Xu.push(rowU);
  }
  const rssR = olsRSS(Xr, yVec);
  const rssU = olsRSS(Xu, yVec);
  if (!Number.isFinite(rssR) || !Number.isFinite(rssU) || rssU < 1e-15) return NaN;
  const dfDenom = n - (2 * p + 1);
  if (dfDenom <= 0) return NaN;
  return ((rssR - rssU) / p) / (rssU / dfDenom);
}

// ---------------------------------------------------------------------------
// OLS via normal equations + Gauss-Jordan (small design matrices only)
// ---------------------------------------------------------------------------

/**
 * Solve β = (XᵀX)⁻¹ Xᵀy and return RSS = ||y − Xβ||². O(k³ + n·k²) where k is
 * the number of predictors. For our lag k≤4 this is trivial.
 */
function olsRSS(X: number[][], y: number[]): number {
  const n = X.length;
  const k = X[0].length;
  // XtX (k×k) and Xty (k)
  const XtX: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty: number[] = new Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < k; a++) {
      Xty[a] += X[i][a] * y[i];
      for (let b = 0; b < k; b++) {
        XtX[a][b] += X[i][a] * X[i][b];
      }
    }
  }
  const beta = solveLinear(XtX, Xty);
  if (!beta) return NaN;
  let rss = 0;
  for (let i = 0; i < n; i++) {
    let yhat = 0;
    for (let a = 0; a < k; a++) yhat += X[i][a] * beta[a];
    const e = y[i] - yhat;
    rss += e * e;
  }
  return rss;
}

/** Gauss–Jordan with partial pivoting. Returns null on singular A. */
export function solveLinear(A: number[][], b: number[]): number[] | null {
  const k = A.length;
  // Augment
  const M: number[][] = A.map((row, i) => [...row, b[i]]);
  for (let i = 0; i < k; i++) {
    // pivot
    let piv = i;
    for (let r = i + 1; r < k; r++) {
      if (Math.abs(M[r][i]) > Math.abs(M[piv][i])) piv = r;
    }
    if (Math.abs(M[piv][i]) < 1e-12) return null;
    if (piv !== i) [M[i], M[piv]] = [M[piv], M[i]];
    // normalize
    const pivVal = M[i][i];
    for (let c = i; c <= k; c++) M[i][c] /= pivVal;
    // eliminate
    for (let r = 0; r < k; r++) {
      if (r === i) continue;
      const f = M[r][i];
      if (f === 0) continue;
      for (let c = i; c <= k; c++) M[r][c] -= f * M[i][c];
    }
  }
  return M.map(row => row[k]);
}

// ---------------------------------------------------------------------------
// F-distribution upper tail via incomplete beta
// ---------------------------------------------------------------------------

/**
 * P(F > f) for F~F(d1,d2). Uses the identity
 *   P(F > f) = I_{d2/(d2 + d1·f)}(d2/2, d1/2)
 * We compute it via Student-t's machinery: specifically, for d1=p, d2=large,
 * we route through the same incomplete-beta that lives in correlation.ts —
 * but to avoid cross-module plumbing we reuse studentTcdf indirectly.
 *
 * Direct route: we use the same betaCF via a local helper — but to keep this
 * file lean we implement P(F > f) in closed form using a well-known identity
 * and the regularised incomplete beta function. We provide a self-contained
 * I_x(a,b) below.
 */
export function fCdfUpperTail(f: number, d1: number, d2: number): number {
  if (!Number.isFinite(f) || f <= 0) return 1;
  if (d1 <= 0 || d2 <= 0) return NaN;
  const x = d2 / (d2 + d1 * f);
  return incompleteBeta(x, d2 / 2, d1 / 2);
}

// --- Self-contained regularised incomplete beta (duplicated for module isolation) ---

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
    d = 1 + aa * d; if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + aa / c; if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + aa / c; if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

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

// Tag studentTcdf as used (keeps import surface consistent) — internal reserved export.
void studentTcdf;
void mean;
