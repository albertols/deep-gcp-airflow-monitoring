/**
 * Significance tests for signals that compare samples (spec §8.9 items 2 and 5): the one-sided Mann–Whitney
 * U test and the Benjamini–Hochberg false discovery rate procedure. Pure functions.
 *
 * @implements HM-016 (regression test and FDR control)
 */

/** Coefficients c₀ … c₉ of the `erfcc` polynomial in t, lowest power first. */
const ERFC_COEFFICIENTS = [
  -1.26551223, 1.00002368, 0.37409196, 0.09678418, -0.18628806, 0.27886807, -1.13520398, 1.48851587,
  -0.82215223, 0.17087277,
] as const;

/**
 * Complementary error function, Chebyshev fit with fractional error below 1.2 × 10⁻⁷ everywhere
 * (`erfcc`, Press et al., Numerical Recipes in C, 2nd ed., §6.2): erfc(z) ≈ t · exp(−z² + Σ cᵢ tⁱ),
 * t = 1 ÷ (1 + z/2), for z ≥ 0; erfc(−z) = 2 − erfc(z).
 */
function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  let poly = 0;
  for (let i = ERFC_COEFFICIENTS.length - 1; i >= 0; i--) poly = (ERFC_COEFFICIENTS[i] as number) + t * poly;
  const r = t * Math.exp(-z * z + poly);
  return x >= 0 ? r : 2 - r;
}

/** Standard normal cumulative distribution function Φ(z). */
export function normalCdf(z: number): number {
  return Math.min(1, Math.max(0, 0.5 * erfc(-z / Math.SQRT2)));
}

export interface MannWhitneyResult {
  /** U of the first sample: pairs in which it is larger, ties counting one half. */
  readonly u: number;
  /** Standardised U with tie and continuity correction; 0 when every value ties. */
  readonly z: number;
  /** One-sided p-value for "the first sample tends to be larger" (normal approximation). */
  readonly pValue: number;
}

/**
 * One-sided Mann–Whitney U test that `current` is stochastically greater than `baseline`, with average ranks
 * for ties, the tie-corrected variance and a continuity correction of ½ (the normal approximation, as R's
 * `wilcox.test(…, alternative = "greater", exact = FALSE, correct = TRUE)`). Adequate from about 10 samples
 * on each side, which HM-016 requires before it tests. `null` when a sample is empty.
 */
export function mannWhitneyGreater(
  current: readonly number[],
  baseline: readonly number[],
): MannWhitneyResult | null {
  const n1 = current.length;
  const n2 = baseline.length;
  if (n1 === 0 || n2 === 0) return null;
  const all = [
    ...current.map((v) => ({ v, current: true })),
    ...baseline.map((v) => ({ v, current: false })),
  ].sort((a, b) => a.v - b.v);
  const n = all.length;
  let rankSum = 0;
  let tieTerm = 0;
  for (let i = 0; i < n;) {
    let j = i;
    while (j + 1 < n && (all[j + 1] as { v: number }).v === (all[i] as { v: number }).v) j++;
    const ties = j - i + 1;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if ((all[k] as { current: boolean }).current) rankSum += rank;
    tieTerm += ties ** 3 - ties;
    i = j + 1;
  }
  const u = rankSum - (n1 * (n1 + 1)) / 2;
  const mean = (n1 * n2) / 2;
  const variance = ((n1 * n2) / 12) * (n + 1 - tieTerm / (n * (n - 1) || 1));
  if (!(variance > 0)) return { u, z: 0, pValue: 1 };
  const z = (u - mean - 0.5) / Math.sqrt(variance);
  return { u, z, pValue: 1 - normalCdf(z) };
}

/**
 * Benjamini–Hochberg adjusted p-values (q-values) for a family of tests: a test is a discovery at false
 * discovery rate `q` when its adjusted value is ≤ `q`. `null` entries (tests not run) are left out of the
 * family and stay `null`.
 */
export function benjaminiHochberg(pValues: readonly (number | null)[]): (number | null)[] {
  const tested = pValues
    .map((p, i) => ({ p, i }))
    .filter((x): x is { p: number; i: number } => x.p !== null && Number.isFinite(x.p))
    .sort((a, b) => a.p - b.p || a.i - b.i);
  const m = tested.length;
  const adjusted: (number | null)[] = pValues.map(() => null);
  let running = 1;
  for (let k = m - 1; k >= 0; k--) {
    const { p, i } = tested[k] as { p: number; i: number };
    // Step-up: the smallest p·m/rank at this rank or above; never below p, since m ≥ rank.
    running = Math.min(running, (p * m) / (k + 1));
    adjusted[i] = running;
  }
  return adjusted;
}
