/**
 * Small statistics shared by signals (spec §8.9): percentiles with the minimum-sample rule.
 */

/** Minimum samples for a p95 (spec §8.9); with fewer, the max is reported and flagged. */
export const MIN_SAMPLES_FOR_TAIL = 20;

/** Linear-interpolation percentile (type 7) over finite values; `p` in [0, 1]. */
export function percentile(values: readonly number[], p: number): number | null {
  return percentileOfSorted(sortedFinite(values), p);
}

/** The finite values, ascending: sort once, then read several percentiles with {@link percentileOfSorted}. */
export const sortedFinite = (values: readonly number[]): number[] =>
  values.filter(Number.isFinite).sort((a, b) => a - b);

/** {@link percentile} of finite values already sorted ascending. */
export function percentileOfSorted(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.min(Math.max(p, 0), 1) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  return a + (b - a) * (rank - lo);
}

export interface Quantile {
  /** The percentile, or the max when the sample is too small for a tail percentile; `null` without samples. */
  readonly value: number | null;
  readonly samples: number;
  /** True when a tail percentile (p ≥ 0.9) had fewer than {@link MIN_SAMPLES_FOR_TAIL} samples, or none. */
  readonly lowSample: boolean;
}

/** A percentile that follows the §8.9 rule: tail percentiles need at least 20 samples. */
export function quantile(values: readonly number[], p: number): Quantile {
  const finite = values.filter(Number.isFinite);
  const samples = finite.length;
  if (samples === 0) return { value: null, samples, lowSample: true };
  const tail = p >= 0.9;
  if (tail && samples < MIN_SAMPLES_FOR_TAIL)
    return { value: finite.reduce((m, v) => Math.max(m, v), -Infinity), samples, lowSample: true };
  return { value: percentile(finite, p), samples, lowSample: false };
}
