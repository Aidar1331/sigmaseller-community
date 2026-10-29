/**
 * Multiple-testing corrections for correlation matrices.
 *
 * When we compute an N×N correlation matrix (N=8 → 28 pairs), running each
 * pair against α=0.05 independently guarantees ~1–2 false discoveries even
 * under the null. Benjamini–Hochberg controls the False Discovery Rate —
 * the expected proportion of false positives among rejections — at a chosen
 * level q (default 0.1).
 *
 * Reference: Benjamini, Hochberg (1995), JRSS-B 57(1):289–300.
 */

/**
 * Benjamini–Hochberg step-up procedure.
 *
 * Input:   p-values p₁, …, pₘ (any order, NaN allowed — propagated)
 * Output:  q-values (adjusted p-values) in the original order.
 *
 * Algorithm:
 *   1. Sort p ascending: p₍₁₎ ≤ p₍₂₎ ≤ … ≤ p₍ₘ₎
 *   2. Compute raw adjusted p̃₍ᵢ₎ = p₍ᵢ₎ · m / i
 *   3. Enforce monotonicity from largest rank down: q₍ᵢ₎ = min(p̃₍ᵢ₎, q₍ᵢ₊₁₎)
 *   4. Cap at 1, unsort.
 *
 * NaN p-values stay NaN in output and are excluded from the rank count (m
 * counts only finite p-values) — this matches how scipy's multipletests
 * behaves with np.nan (after masking).
 *
 * The BH procedure is valid under independence and positive regression
 * dependence (PRDS), which covers correlation matrices in our setting.
 */
export function benjaminiHochberg(pValues: readonly number[]): number[] {
  const m = pValues.length;
  if (m === 0) return [];

  // Collect finite p-values with original index, excluding NaN.
  const finite: Array<{ p: number; idx: number }> = [];
  for (let i = 0; i < m; i++) {
    if (Number.isFinite(pValues[i])) finite.push({ p: pValues[i], idx: i });
  }
  const mEff = finite.length;
  const out = new Array<number>(m).fill(NaN);
  if (mEff === 0) return out;

  // Sort ascending
  finite.sort((a, b) => a.p - b.p);

  // Raw BH adjustment + monotonicity from the top
  const adj = new Array<number>(mEff);
  for (let i = 0; i < mEff; i++) {
    adj[i] = (finite[i].p * mEff) / (i + 1);
  }
  // Monotone from right: q[i] = min(q[i], q[i+1])
  for (let i = mEff - 2; i >= 0; i--) {
    if (adj[i + 1] < adj[i]) adj[i] = adj[i + 1];
  }
  // Cap at 1 and scatter back to original order
  for (let i = 0; i < mEff; i++) {
    out[finite[i].idx] = Math.min(1, adj[i]);
  }
  return out;
}

/**
 * Return boolean rejection mask at FDR level q (default 0.1).
 * NaN p-values are never rejected.
 */
export function rejectFDR(pValues: readonly number[], q = 0.1): boolean[] {
  const qs = benjaminiHochberg(pValues);
  return qs.map(v => Number.isFinite(v) && v <= q);
}

/**
 * Bonferroni adjustment — ultra-conservative, offered as an alternative for
 * small matrices where we want strong FWER control rather than FDR.
 * q_i = min(1, m · p_i)
 */
export function bonferroni(pValues: readonly number[]): number[] {
  const m = pValues.filter(Number.isFinite).length;
  return pValues.map(p => (Number.isFinite(p) ? Math.min(1, p * m) : NaN));
}
