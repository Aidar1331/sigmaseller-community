/**
 * Price elasticity of demand — log-log OLS with White HC1 robust SEs.
 *
 *   ln(Q_i + 1) = a + E · ln(P_i) + ε_i
 *
 * Interpretation of E:
 *   E < -1           elastic      (снижение цены → рост выручки)
 *   -1 < E < 0       inelastic    (снижение цены → падение выручки)
 *   E ≈ 0            no response  (цена не драйвер — смотри CTR/позиции)
 *   E > 0            paradox      (Veblen/статусный товар, или спайк по внешней
 *                                  причине совпал с повышением цены)
 *
 * Heteroscedasticity is the norm in e-commerce daily data (variance scales
 * with volume), so we report White HC1 SEs rather than classical OLS SEs.
 *
 * Plan guards (§1.5):
 *   - std(ln P) ≥ 0.02     (≈2% relative price variation — OLS has something to chew)
 *   - nonZeroCount(Q) ≥ 20 (enough real signal)
 *   - uniqueValues(P) ≥ 4  (not a 2-level A/B)
 *   - n ≥ 30               (minimum for OLS inference)
 */

import { nonZeroCount, std as stdev, uniqueValueCount } from './series.js';
import { normalCdf, fisherCI } from './correlation.js';
import { solveLinear } from './lag.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type ElasticityStatus =
  | 'ok'
  | 'insufficient_n'
  | 'insufficient_price_variation'
  | 'insufficient_order_signal'
  | 'insufficient_price_cardinality'
  | 'degenerate_fit';

export interface ElasticityReport {
  status: ElasticityStatus;
  /** Point estimate of E (NaN when status !== 'ok') */
  E: number;
  /** White HC1 robust standard error for E */
  seRobust: number;
  /** Classical (non-robust) SE, exposed for comparison only */
  seClassical: number;
  /** Two-sided p-value for H0: E = 0 using robust SE */
  p: number;
  /** R² of the log-log fit */
  r2: number;
  /** Number of observations that survived filters */
  n: number;
  /** 95% CI for E from robust SE (normal approximation) */
  ci95: { lower: number; upper: number };
  /** Intercept a in ln(Q+1) = a + E·ln(P) */
  intercept: number;
  /** Human readable one-liner classifying E — empty when status != 'ok' */
  classification:
    | 'elastic'
    | 'unit_elastic'
    | 'inelastic'
    | 'no_response'
    | 'paradox'
    | 'n/a';
  /** Machine-readable reasons when status != 'ok' */
  reasons: string[];
}

export interface ElasticityOptions {
  /** Minimum observations. Default 30. */
  minN?: number;
  /** Minimum std(lnP) — roughly the relative price variation in percent/100. Default 0.02 (≈2%). */
  minLogPriceStd?: number;
  /** Minimum non-zero orders. Default 20. */
  minNonZeroOrders?: number;
  /** Minimum distinct prices. Default 4. */
  minUniquePrices?: number;
}

const DEFAULTS: Required<ElasticityOptions> = {
  minN: 30,
  minLogPriceStd: 0.02,
  minNonZeroOrders: 20,
  minUniquePrices: 4,
};

/**
 * Compute price elasticity with full diagnostic report.
 *
 * @param price   Daily price per unit (rubles). Values ≤ 0 are skipped.
 * @param orders  Daily orders count. Zeros allowed (use ln(Q+1) transform).
 */
export function priceElasticity(
  price: readonly number[],
  orders: readonly number[],
  opts: ElasticityOptions = {},
): ElasticityReport {
  if (price.length !== orders.length) {
    throw new Error(`priceElasticity: length mismatch ${price.length} vs ${orders.length}`);
  }
  const o = { ...DEFAULTS, ...opts };
  const reasons: string[] = [];

  // ----- Pair-wise filter: drop non-positive prices / non-finite -----
  const P: number[] = [];
  const Q: number[] = [];
  for (let i = 0; i < price.length; i++) {
    const p = price[i];
    const q = orders[i];
    if (!Number.isFinite(p) || !Number.isFinite(q) || p <= 0 || q < 0) continue;
    P.push(p);
    Q.push(q);
  }
  const n = P.length;

  if (n < o.minN) {
    reasons.push(`n=${n} < ${o.minN}`);
    return emptyReport('insufficient_n', n, reasons);
  }

  const nonZeroQ = nonZeroCount(Q);
  if (nonZeroQ < o.minNonZeroOrders) {
    reasons.push(`non_zero_orders=${nonZeroQ} < ${o.minNonZeroOrders}`);
    return emptyReport('insufficient_order_signal', n, reasons);
  }

  const uniqueP = uniqueValueCount(P);
  if (uniqueP < o.minUniquePrices) {
    reasons.push(`unique_prices=${uniqueP} < ${o.minUniquePrices}`);
    return emptyReport('insufficient_price_cardinality', n, reasons);
  }

  // ----- Variation of log-price -----
  // std(ln P) ≈ relative price variation; 0.02 ≈ 2% spread is the floor below
  // which OLS cannot resolve elasticity with any useful precision.
  const lnP = P.map(p => Math.log(p));
  const sLnP = stdev(lnP);
  if (!Number.isFinite(sLnP) || sLnP < o.minLogPriceStd) {
    reasons.push(`std(lnP)=${sLnP.toFixed(4)} < ${o.minLogPriceStd}`);
    return emptyReport('insufficient_price_variation', n, reasons);
  }

  // ----- OLS with intercept: y = [1, lnP] · β -----
  const lnQ = Q.map(q => Math.log(q + 1));
  const X: number[][] = P.map((_, i) => [1, lnP[i]]);
  const fit = olsFit(X, lnQ);
  if (!fit) {
    reasons.push('ols_singular');
    return emptyReport('degenerate_fit', n, reasons);
  }
  const { beta, residuals, rss, tss } = fit;

  const intercept = beta[0];
  const E = beta[1];
  const r2 = tss < 1e-15 ? 0 : 1 - rss / tss;

  // ----- SE (classical + HC1 robust) -----
  const k = 2; // intercept + slope
  const dfDenom = n - k;
  const sigma2 = rss / dfDenom;

  // (X'X)^-1
  const XtX = matMulT(X, X);       // k×k
  const XtXinv = inv2x2(XtX);
  if (!XtXinv) {
    reasons.push('xtx_singular');
    return emptyReport('degenerate_fit', n, reasons);
  }

  const seClassical = Math.sqrt(sigma2 * XtXinv[1][1]);

  // White HC1: V = (X'X)^-1 · Σ (e_i² x_i x_i') · (X'X)^-1 · n/(n-k)
  // Compute meat Σ e_i² x_i x_i'
  const meat: number[][] = [[0, 0], [0, 0]];
  for (let i = 0; i < n; i++) {
    const e2 = residuals[i] * residuals[i];
    const xi = X[i];
    meat[0][0] += e2 * xi[0] * xi[0];
    meat[0][1] += e2 * xi[0] * xi[1];
    meat[1][0] += e2 * xi[1] * xi[0];
    meat[1][1] += e2 * xi[1] * xi[1];
  }
  const bread = XtXinv;
  const sandwich = matMul(matMul(bread, meat), bread);
  const hc1Factor = n / dfDenom;
  const varE_HC1 = sandwich[1][1] * hc1Factor;
  const seRobust = Math.sqrt(Math.max(0, varE_HC1));

  // ----- p-value on E≠0 using robust SE -----
  const z = seRobust < 1e-15 ? 0 : E / seRobust;
  const p = 2 * (1 - normalCdf(Math.abs(z)));

  const ci95 = {
    lower: E - 1.959964 * seRobust,
    upper: E + 1.959964 * seRobust,
  };

  return {
    status: 'ok',
    E,
    seRobust,
    seClassical,
    p,
    r2,
    n,
    ci95,
    intercept,
    classification: classify(E),
    reasons: [],
  };
}

function classify(E: number): ElasticityReport['classification'] {
  if (!Number.isFinite(E)) return 'n/a';
  if (E > 0.1) return 'paradox';
  if (E > -0.1) return 'no_response';
  if (E > -0.9) return 'inelastic';
  if (E > -1.1) return 'unit_elastic';
  return 'elastic';
}

function emptyReport(
  status: ElasticityStatus,
  n: number,
  reasons: string[],
): ElasticityReport {
  return {
    status,
    E: NaN,
    seRobust: NaN,
    seClassical: NaN,
    p: NaN,
    r2: NaN,
    n,
    ci95: { lower: NaN, upper: NaN },
    intercept: NaN,
    classification: 'n/a',
    reasons,
  };
}

// ---------------------------------------------------------------------------
// Small matrix helpers (2×2 is enough for our single-regressor OLS)
// ---------------------------------------------------------------------------

interface OlsFit {
  beta: number[];
  residuals: number[];
  rss: number;
  tss: number;
}

function olsFit(X: number[][], y: number[]): OlsFit | null {
  const k = X[0].length;
  const XtX: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty: number[] = new Array(k).fill(0);
  for (let i = 0; i < X.length; i++) {
    for (let a = 0; a < k; a++) {
      Xty[a] += X[i][a] * y[i];
      for (let b = 0; b < k; b++) XtX[a][b] += X[i][a] * X[i][b];
    }
  }
  const beta = solveLinear(XtX, Xty);
  if (!beta) return null;

  const yMean = y.reduce((s, v) => s + v, 0) / y.length;
  const residuals: number[] = [];
  let rss = 0;
  let tss = 0;
  for (let i = 0; i < X.length; i++) {
    let yhat = 0;
    for (let a = 0; a < k; a++) yhat += X[i][a] * beta[a];
    const e = y[i] - yhat;
    residuals.push(e);
    rss += e * e;
    tss += (y[i] - yMean) ** 2;
  }
  return { beta, residuals, rss, tss };
}

function matMulT(A: number[][], B: number[][]): number[][] {
  // returns A^T · B for A shape n×k, B shape n×k → k×k
  const n = A.length;
  const k = A[0].length;
  const out: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < k; a++) {
      for (let b = 0; b < k; b++) out[a][b] += A[i][a] * B[i][b];
    }
  }
  return out;
}

function matMul(A: number[][], B: number[][]): number[][] {
  const n = A.length;
  const m = B[0].length;
  const k = A[0].length;
  const out: number[][] = Array.from({ length: n }, () => new Array(m).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      for (let p = 0; p < k; p++) out[i][j] += A[i][p] * B[p][j];
    }
  }
  return out;
}

function inv2x2(M: number[][]): number[][] | null {
  const det = M[0][0] * M[1][1] - M[0][1] * M[1][0];
  if (Math.abs(det) < 1e-15) return null;
  const inv = 1 / det;
  return [
    [M[1][1] * inv, -M[0][1] * inv],
    [-M[1][0] * inv, M[0][0] * inv],
  ];
}

// Tagged unused imports to keep module surface declared
void fisherCI;
