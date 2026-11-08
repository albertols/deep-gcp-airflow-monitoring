import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { environmentLoad, histogram, hourlyLoadProfile, sharedLogBins, type DagTaskTry } from '../src/index';
import { H, M, T0, tryAt } from './fixtures';

const D = 24 * H;
/** Two days from 00:30 UTC (T0 is a midnight). */
const W = { from: T0 + 30 * M, to: T0 + 30 * M + 2 * D, now: T0 + 30 * M + 2 * D };
const minutes = (ms: number) => ms / M;
const own: DagTaskTry[] = [
  // Half of this try falls before the window.
  tryAt({ dagId: 'acme_nightly', taskId: 'early', runId: 'r0', start: 0, end: 60 }),
  ...[0, 1, 2].map((d) =>
    tryAt({
      dagId: 'acme_nightly',
      taskId: 'load',
      runId: `r${d + 1}`,
      start: minutes(d * D + 2 * H),
      end: minutes(d * D + 3 * H),
    }),
  ),
];
const other = tryAt({ dagId: 'acme_steady', taskId: 'stream', runId: 's', start: 0, end: minutes(3 * D) });
const hourly = (historyFrom: number | null) =>
  hourlyLoadProfile({
    dagTries: own,
    environment: environmentLoad([...own, other], W, H, Math.floor(W.from / H) * H),
    window: W,
    historyFrom,
  });

describe('HM-003 environment load on a UTC-aligned grid', () => {
  it('HM-003: buckets start at the origin and cover the window; clipping stays at the window start', () => {
    const load = environmentLoad([other], W, H, T0);
    expect(load).toMatchObject({ origin: T0, bucketMs: H });
    expect(load.executorSlotSeconds).toHaveLength(49);
    expect(load.executorSlotSeconds[0]).toBe(30 * 60);
    expect(load.executorSlotSeconds[1]).toBe(3_600);
    expect(load.executorSlotSeconds[48]).toBe(30 * 60);
  });
});

describe('FR-DAGD-08 hourly load profile (UTC)', () => {
  it('FR-DAGD-08: mean running slots per UTC hour of day over the covered hours, and the share of the environment', () => {
    const p = hourly(T0 - D);
    expect(p).toHaveLength(24);
    expect(p.map((h) => h.hour)).toEqual(Array.from({ length: 24 }, (_, i) => i));
    expect(p.every((h) => h.coveredHours === 2)).toBe(true);
    expect(p[2]).toEqual({ hour: 2, coveredHours: 2, runningAvg: 1, share: 0.5 });
    // 30 minutes of the early try fall in the window, in hour 0 of the first day.
    expect(p[0]).toEqual({ hour: 0, coveredHours: 2, runningAvg: 0.25, share: 0.2 });
    expect(p[5]).toEqual({ hour: 5, coveredHours: 2, runningAvg: 0, share: 0 });
  });

  it('NFR-DATA-03: only hours with collected history count; without history every hour is a gap', () => {
    const late = hourly(T0 + D);
    expect(late[0]).toMatchObject({ coveredHours: 1.5, runningAvg: 0 });
    expect(late[2]).toMatchObject({ coveredHours: 1, runningAvg: 1 });
    expect(hourly(null).every((h) => h.coveredHours === 0 && h.runningAvg === null && h.share === null)).toBe(
      true,
    );
  });

  it('FR-DAGD-08: without the environment load the share is unknown, the running mean is not', () => {
    const p = hourlyLoadProfile({ dagTries: own, environment: null, window: W, historyFrom: T0 - D });
    expect(p[2]).toMatchObject({ runningAvg: 1, share: null });
  });
});

describe('FR-DAGD-08 overlaid duration distributions', () => {
  it('FR-DAGD-08: log-spaced bins shared by every DAG, and counts per bin', () => {
    const edges = sharedLogBins([[1, 10], [100]], 2);
    expect(edges).toHaveLength(3);
    [1, 10, 100].forEach((x, i) => expect(edges[i]).toBeCloseTo(x, 9));
    expect(histogram([1, 10.5], edges)).toEqual([1, 1]);
    expect(histogram([100], edges)).toEqual([0, 1]);
  });

  it('FR-DAGD-08: zero durations fall in the first bin; one distinct value gives one bin; none gives none', () => {
    const edges = sharedLogBins([[0, 0, 5]], 3);
    expect(edges).toEqual([5, 5]);
    expect(histogram([0, 0, 5], edges)).toEqual([3]);
    expect(sharedLogBins([[], []], 12)).toEqual([]);
    expect(histogram([4], [])).toEqual([]);
  });

  it('FR-DAGD-08: every sample lands in exactly one bin, and the edges ascend', () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(fc.double({ min: 0, max: 1e6, noNaN: true }), { maxLength: 30 }), {
          minLength: 2,
          maxLength: 4,
        }),
        fc.integer({ min: 1, max: 20 }),
        (groups, bins) => {
          const edges = sharedLogBins(groups, bins);
          for (let i = 1; i < edges.length; i++) expect(edges[i]).toBeGreaterThanOrEqual(edges[i - 1] ?? 0);
          for (const g of groups) {
            const counts = histogram(g, edges);
            const total = counts.reduce((a, b) => a + b, 0);
            expect(total).toBe(edges.length ? g.length : 0);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
