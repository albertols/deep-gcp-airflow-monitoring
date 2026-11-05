import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { occupancySeries, slotSeconds, type TaskTry } from '../src/index';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 1, 0, 0, 0);

function tryOf(partial: Partial<TaskTry> & Pick<TaskTry, 'startAt' | 'endAt'>): TaskTry {
  return {
    dagId: 'dag_a',
    taskId: 't1',
    runId: 'r1',
    mapIndex: -1,
    tryNumber: 1,
    pool: 'default_pool',
    poolSlots: 1,
    ...partial,
  };
}

const window = { from: T0, to: T0 + 10 * MIN, now: T0 + 10 * MIN };

describe('HM-003 slot-seconds per DAG', () => {
  it('HM-003: counts the running time of each try as executor slot-seconds', () => {
    const result = slotSeconds([tryOf({ startAt: T0, endAt: T0 + 30_000 })], window);
    expect(result.byDag.get('dag_a')).toEqual({ executorSlotSeconds: 30, poolSlotSeconds: 30 });
    expect(result.totalExecutorSlotSeconds).toBe(30);
  });

  it('HM-003: multiplies pool slot-seconds by pool_slots but counts one executor slot', () => {
    const result = slotSeconds([tryOf({ startAt: T0, endAt: T0 + MIN, poolSlots: 3 })], window);
    expect(result.byDag.get('dag_a')).toEqual({ executorSlotSeconds: 60, poolSlotSeconds: 180 });
    expect(result.byPool.get('default_pool')).toBe(180);
  });

  it('HM-003: uses "now" as the end of tries that are still running', () => {
    const result = slotSeconds([tryOf({ startAt: T0 + 9 * MIN, endAt: null })], window);
    expect(result.totalExecutorSlotSeconds).toBe(60);
  });

  it('HM-003: clips tries to the requested window', () => {
    const result = slotSeconds([tryOf({ startAt: T0 - MIN, endAt: T0 + MIN })], window);
    expect(result.totalExecutorSlotSeconds).toBe(60);
  });

  it('HM-003: rejects tries without a start or with an end before the start, and counts them', () => {
    const result = slotSeconds(
      [tryOf({ startAt: null, endAt: null }), tryOf({ startAt: T0 + MIN, endAt: T0 })],
      window,
    );
    expect(result.totalExecutorSlotSeconds).toBe(0);
    expect(result.rejected).toBe(2);
  });
});

describe('HM-011 occupancy sweep', () => {
  it('HM-011: reports per-minute average and maximum concurrency', () => {
    const series = occupancySeries([tryOf({ startAt: T0, endAt: T0 + 30_000 })], window);
    const total = series.get('*');
    expect(total?.[0]).toEqual({ start: T0, avg: 0.5, max: 1 });
    expect(total?.[1]).toEqual({ start: T0 + MIN, avg: 0, max: 0 });
    expect(total).toHaveLength(10);
  });

  it('HM-011: overlapping tries add up', () => {
    const series = occupancySeries(
      [tryOf({ startAt: T0, endAt: T0 + MIN }), tryOf({ taskId: 't2', startAt: T0 + 30_000, endAt: T0 + MIN })],
      window,
    );
    expect(series.get('*')?.[0]).toEqual({ start: T0, avg: 1.5, max: 2 });
  });

  it('HM-011: a try that ends exactly when another starts does not count twice', () => {
    const series = occupancySeries(
      [
        tryOf({ startAt: T0, endAt: T0 + 30_000 }),
        tryOf({ taskId: 't2', startAt: T0 + 30_000, endAt: T0 + MIN }),
      ],
      window,
    );
    expect(series.get('*')?.[0]).toEqual({ start: T0, avg: 1, max: 1 });
  });

  it('HM-011: groups by a key, and the groups add up to the total', () => {
    const tries = [
      tryOf({ startAt: T0, endAt: T0 + 2 * MIN }),
      tryOf({ dagId: 'dag_b', startAt: T0 + MIN, endAt: T0 + 3 * MIN }),
    ];
    const series = occupancySeries(tries, window, (t) => t.dagId);
    expect([...series.keys()].sort()).toEqual(['*', 'dag_a', 'dag_b']);
    expect(series.get('dag_b')?.[1]).toEqual({ start: T0 + MIN, avg: 1, max: 1 });
    expect(series.get('*')?.[1]).toEqual({ start: T0 + MIN, avg: 2, max: 2 });
  });

  it('HM-011: averages a partial last bucket over its real length', () => {
    const short = { from: T0, to: T0 + 90_000, now: T0 + 90_000 };
    const series = occupancySeries([tryOf({ startAt: T0 + MIN, endAt: T0 + 90_000 })], short);
    expect(series.get('*')).toEqual([
      { start: T0, avg: 0, max: 0 },
      { start: T0 + MIN, avg: 1, max: 1 },
    ]);
  });

  it('HM-011: the area under the occupancy curve equals the executor slot-seconds (property)', () => {
    const arbTry = fc
      .record({
        start: fc.integer({ min: -2 * MIN, max: 12 * MIN }),
        length: fc.integer({ min: 0, max: 8 * MIN }),
        running: fc.boolean(),
        dag: fc.constantFrom('a', 'b', 'c'),
        slots: fc.integer({ min: 1, max: 4 }),
      })
      .map(({ start, length, running, dag, slots }) =>
        tryOf({
          dagId: dag,
          poolSlots: slots,
          startAt: T0 + start,
          endAt: running ? null : T0 + start + length,
        }),
      );
    fc.assert(
      fc.property(fc.array(arbTry, { maxLength: 40 }), (tries) => {
        const total = slotSeconds(tries, window).totalExecutorSlotSeconds;
        const area = (occupancySeries(tries, window).get('*') ?? []).reduce((s, b) => s + b.avg * 60, 0);
        expect(area).toBeCloseTo(total, 6);
      }),
    );
  });
});
