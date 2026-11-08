import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { benjaminiHochberg, mannWhitneyGreater, normalCdf, normalUpperTail } from '../src/index';

describe('HM-016 significance tests (spec §8.9: Mann–Whitney, Benjamini–Hochberg)', () => {
  it('HM-016: the standard normal CDF matches table values', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 6);
    expect(normalCdf(-2.326348)).toBeCloseTo(0.01, 6);
    expect(normalCdf(3)).toBeCloseTo(0.99865, 5);
    expect(normalCdf(-8)).toBeGreaterThanOrEqual(0);
    expect(normalCdf(8)).toBeLessThanOrEqual(1);
  });

  it('HM-016: the upper tail is computed directly, so far-out z keeps a positive, accurate p-value', () => {
    // Q(z) = 1 − Φ(z): reference values (R: pnorm(z, lower.tail = FALSE)).
    const reference: Array<[number, number]> = [
      [0, 0.5],
      [3, 1.3498980316301e-3],
      [5, 2.866515718791939e-7],
      [8, 6.220960574271785e-16],
      [10, 7.619853024160527e-24],
      [20, 2.753624118606233e-89],
    ];
    for (const [z, q] of reference) expect(Math.abs(normalUpperTail(z) - q) / q).toBeLessThan(1e-6);
    expect(normalUpperTail(-3)).toBeCloseTo(1 - 1.3498980316301e-3, 9);
    // A clear shift of 200 against 2,000 samples: z ≈ 23, p tiny but above 0, and q follows.
    const big = Array.from({ length: 200 }, (_, i) => 100 + i);
    const small = Array.from({ length: 2_000 }, (_, i) => i % 90);
    const p = mannWhitneyGreater(big, small)?.pValue as number;
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1e-100);
    expect(benjaminiHochberg([p, 0.5])[0]).toBeGreaterThan(0);
  });

  it('HM-016: one-sided Mann–Whitney U with average ranks for ties, tie and continuity correction', () => {
    // Ranks of the combined sample 1 2 3 4 4 4 5 6: the three 4s share rank 5. R(current) = 3 + 5 + 5 + 8 = 21,
    // U = 21 − 4·5/2 = 11, μ = 8, σ² = 16/12 · (9 − 24/56) = 80/7, z = (11 − 8 − 0.5)/√(80/7).
    // R: wilcox.test(c(3,4,4,6), c(1,2,4,5), alternative = "greater", exact = FALSE) gives W = 11, p = 0.2298.
    const test = mannWhitneyGreater([3, 4, 4, 6], [1, 2, 4, 5]);
    expect(test?.u).toBe(11);
    expect(test?.z).toBeCloseTo(2.5 / Math.sqrt(80 / 7), 9);
    expect(test?.pValue).toBeCloseTo(0.2298, 4);
  });

  it('HM-016: a clear shift gives a small p-value; the other direction gives a large one', () => {
    const baseline = Array.from({ length: 20 }, (_, i) => 100 + i);
    const slower = Array.from({ length: 10 }, (_, i) => 200 + i);
    // U = n1·n2 = 200, μ = 100, σ² = 200 · 31 / 12, z = 99.5 / σ.
    const test = mannWhitneyGreater(slower, baseline);
    expect(test?.u).toBe(200);
    expect(test?.pValue).toBeCloseTo(1 - normalCdf(99.5 / Math.sqrt((200 * 31) / 12)), 12);
    expect(test?.pValue).toBeLessThan(1e-4);
    expect(mannWhitneyGreater(baseline.slice(0, 10), slower.concat(slower))?.pValue).toBeGreaterThan(0.99);
  });

  it('HM-016: no samples give no test; identical samples give no evidence (p = 1)', () => {
    expect(mannWhitneyGreater([], [1, 2])).toBeNull();
    expect(mannWhitneyGreater([1], [])).toBeNull();
    expect(mannWhitneyGreater([5, 5, 5], [5, 5])?.pValue).toBe(1);
  });

  it('HM-016: Benjamini–Hochberg adjusted values (step-up, monotone), with gaps kept as gaps', () => {
    const q = benjaminiHochberg([0.01, 0.04, 0.03, 0.005]);
    [0.02, 0.04, 0.04, 0.02].forEach((v, i) => expect(q[i]).toBeCloseTo(v, 12));
    const withGap = benjaminiHochberg([0.02, null, 0.5]);
    expect(withGap[0]).toBeCloseTo(0.04, 12);
    expect(withGap[1]).toBeNull();
    expect(withGap[2]).toBeCloseTo(0.5, 12);
    expect(benjaminiHochberg([])).toEqual([]);
  });

  it('HM-016: adjusted values are at least the p-value, at most 1, and keep the order of the p-values', () => {
    fc.assert(
      fc.property(fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { maxLength: 30 }), (ps) => {
        const q = benjaminiHochberg(ps);
        ps.forEach((p, i) => {
          const qi = q[i] as number;
          expect(qi).toBeGreaterThanOrEqual(p - 1e-12);
          expect(qi).toBeLessThanOrEqual(1);
          ps.forEach((pj, j) => {
            if (p <= pj) expect(qi).toBeLessThanOrEqual((q[j] as number) + 1e-12);
          });
        });
      }),
    );
  });

  it('HM-016: the Mann–Whitney p-value is a probability, and shifting the current sample up never raises it', () => {
    fc.assert(
      fc.property(
        // Half-second offsets: no current value ever ties a baseline value, so σ stays the same under a shift.
        fc.array(
          fc.integer({ min: 1, max: 50 }).map((v) => v + 0.5),
          { minLength: 1, maxLength: 15 },
        ),
        fc.array(fc.integer({ min: 1, max: 50 }), { minLength: 1, maxLength: 25 }),
        fc.integer({ min: 0, max: 30 }),
        (current, baseline, shift) => {
          const p = mannWhitneyGreater(current, baseline)?.pValue as number;
          const shifted = mannWhitneyGreater(
            current.map((v) => v + shift),
            baseline,
          )?.pValue as number;
          expect(p).toBeGreaterThanOrEqual(0);
          expect(p).toBeLessThanOrEqual(1);
          expect(shifted).toBeLessThanOrEqual(p + 1e-12);
        },
      ),
    );
  });
});
