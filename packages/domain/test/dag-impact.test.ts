import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createEnvironmentLoad, environmentLoad, loadShare, slotSeconds } from '../src/index';
import { M, T0, tryAt, windowOf } from './fixtures';

const W = windowOf(0, 30);
const tries = [
  tryAt({ dagId: 'acme_hog', taskId: 'a', start: 0, end: 10 }),
  tryAt({ dagId: 'acme_hog', taskId: 'b', start: 0, end: 20 }),
  tryAt({ dagId: 'acme_other', taskId: 'x', start: 5, end: 25, pool: 'etl', poolSlots: 2 }),
  // Still running at "now": it ends at now.
  tryAt({ dagId: 'acme_small', taskId: 'y', start: 28, end: null }),
  // Never started, and an end before the start: not load (as slotSeconds rejects them).
  tryAt({ dagId: 'acme_small', taskId: 'z', start: null }),
  tryAt({ dagId: 'acme_small', taskId: 'w', start: 12, end: 11 }),
];
const own = tries.filter((t) => t.dagId === 'acme_hog');
/** Executor slots per minute: 4 in minutes 0–9, unknown in 10–19, 2 in 20–29. */
const slots = Array.from({ length: 30 }, (_, k) => (k < 10 ? 4 : k < 20 ? null : 2));

describe('HM-003 environment load per bucket', () => {
  it('HM-003: executor slot-seconds per bucket and pool slot-seconds per pool, clipped to the window', () => {
    const load = environmentLoad(tries, W, 10 * M);
    expect(load.executorSlotSeconds).toEqual([1_500, 1_200, 420]);
    expect([...load.poolSlotSeconds]).toEqual([
      ['default_pool', 1_800 + 120],
      ['etl', 2 * 1_200],
    ]);
  });

  it('HM-003: the buckets add up to slotSeconds, and the pools equal its byPool, for any tries', () => {
    const arb = fc.array(
      fc.record({
        start: fc.option(fc.integer({ min: -20, max: 40 }), { nil: null }),
        length: fc.option(fc.integer({ min: -5, max: 40 }), { nil: null }),
        pool: fc.constantFrom('default_pool', 'etl'),
        poolSlots: fc.integer({ min: 1, max: 3 }),
      }),
      { maxLength: 40 },
    );
    fc.assert(
      fc.property(arb, fc.integer({ min: 1, max: 17 }), (specs, bucketMinutes) => {
        const xs = specs.map((s, i) =>
          tryAt({
            taskId: `t${i}`,
            start: s.start,
            end: s.start === null || s.length === null ? null : s.start + s.length,
            pool: s.pool,
            poolSlots: s.poolSlots,
          }),
        );
        const w = windowOf(0, 30, 25);
        const load = environmentLoad(xs, w, bucketMinutes * M);
        const reference = slotSeconds(xs, w);
        expect(load.executorSlotSeconds).toHaveLength(Math.ceil(30 / bucketMinutes));
        const sum = load.executorSlotSeconds.reduce((a, b) => a + b, 0);
        expect(sum).toBeCloseTo(reference.totalExecutorSlotSeconds, 6);
        for (const [pool, seconds] of reference.byPool)
          expect(load.poolSlotSeconds.get(pool) ?? 0).toBeCloseTo(seconds, 6);
      }),
      { numRuns: 100 },
    );
  });
});

describe('NFR-PERF-01 environment load from store slices', () => {
  it('HM-003 / NFR-PERF-01: slices in any order, each read 1 ms early, give the load of one pass', () => {
    const w = windowOf(0, 30);
    const overlapping = (from: number, to: number) =>
      tries.filter((t) => t.startAt !== null && t.startAt < to && (t.endAt === null || t.endAt > from));
    const acc = createEnvironmentLoad(w, 10 * M);
    const edges = [0, 7, 14, 21, 28, 30].map((m) => T0 + m * M);
    const slices = edges.slice(1).map((to, i) => ({ from: edges[i] as number, to }));
    for (const slice of [...slices].reverse()) acc.add(overlapping(slice.from - 1, slice.to), slice);
    expect(acc.result()).toEqual(environmentLoad(tries, w, 10 * M));
  });
});

describe('FR-DAGD-06 share of the environment load over time', () => {
  const input = {
    dagTries: own,
    environment: environmentLoad(tries, W, 10 * M),
    window: W,
    bucketMs: 10 * M,
    historyFrom: T0 - 60 * M,
    slots,
  };

  it("FR-DAGD-06 / HM-003: the DAG's executor slot-seconds ÷ the environment's, and ÷ the known executor slots", () => {
    expect(loadShare(input)).toEqual([
      { start: T0, dagSlotSeconds: 1_200, environmentSlotSeconds: 1_500, share: 0.8, capacityShare: 0.5 },
      // Slots unknown in every minute of the bucket: no capacity share, never a guess (HM-032).
      {
        start: T0 + 10 * M,
        dagSlotSeconds: 600,
        environmentSlotSeconds: 1_200,
        share: 0.5,
        capacityShare: null,
      },
      { start: T0 + 20 * M, dagSlotSeconds: 0, environmentSlotSeconds: 420, share: 0, capacityShare: 0 },
    ]);
  });

  it('NFR-DATA-03: before the history start, and in buckets without any load, the share is a gap', () => {
    const late = loadShare({ ...input, historyFrom: T0 + 15 * M });
    expect(late[0]).toEqual({
      start: T0,
      dagSlotSeconds: null,
      environmentSlotSeconds: null,
      share: null,
      capacityShare: null,
    });
    expect(late[1]?.share).toBe(0.5);
    const finished = tries.filter((t) => t.endAt !== null);
    const quiet = loadShare({
      ...input,
      window: windowOf(0, 40),
      environment: environmentLoad(finished, windowOf(0, 40), 10 * M),
    });
    expect(quiet[3]).toMatchObject({ dagSlotSeconds: 0, environmentSlotSeconds: 0, share: null });
  });

  it('FR-DAGD-06: shares stay within [0, 1]', () => {
    for (const b of loadShare(input)) {
      for (const x of [b.share, b.capacityShare]) if (x !== null) expect(x).toBeGreaterThanOrEqual(0);
      for (const x of [b.share, b.capacityShare]) if (x !== null) expect(x).toBeLessThanOrEqual(1);
    }
  });
});
