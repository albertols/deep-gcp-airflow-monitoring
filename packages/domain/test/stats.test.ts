import { describe, expect, it } from 'vitest';
import { percentile, quantile } from '../src/index';

describe('percentiles (spec §8.9)', () => {
  it('interpolates linearly between ranks', () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([10], 0.95)).toBe(10);
    expect(percentile([5, 1, 3], 0)).toBe(1);
    expect(percentile([5, 1, 3], 1)).toBe(5);
  });

  it('returns null without samples and ignores non-finite values', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([Number.NaN, 4, Number.POSITIVE_INFINITY], 0.5)).toBe(4);
  });

  it('§8.9: p95 needs at least 20 samples, otherwise it reports the max and flags a low sample', () => {
    const nineteen = Array.from({ length: 19 }, (_, i) => i + 1);
    expect(quantile(nineteen, 0.95)).toEqual({ value: 19, samples: 19, lowSample: true });
    const twenty = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(quantile(twenty, 0.95)).toEqual({
      value: percentile(twenty, 0.95),
      samples: 20,
      lowSample: false,
    });
    expect(quantile([], 0.95)).toEqual({ value: null, samples: 0, lowSample: true });
  });

  it('p50 is reported with any number of samples', () => {
    expect(quantile([3, 1, 2], 0.5)).toEqual({ value: 2, samples: 3, lowSample: false });
  });
});
