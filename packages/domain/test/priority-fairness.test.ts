import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { priorityFairness, type LiveSnapshot, type SnapshotTaskInstance } from '../src/index';

const T0 = Date.UTC(2026, 10, 5, 11, 0, 0);
const SEC = 1_000;

const ti = (taskId: string, priorityWeight: number, since: number, pool = 'etl'): SnapshotTaskInstance => ({
  dagId: `dag_${taskId}`,
  runId: 'r',
  taskId,
  mapIndex: -1,
  tryNumber: 1,
  pool,
  poolSlots: 1,
  priorityWeight,
  since: T0 + since * SEC,
});
const snap = (atSec: number, scheduled: SnapshotTaskInstance[], queued: SnapshotTaskInstance[] = []) =>
  ({
    at: T0 + atSec * SEC,
    scheduled,
    queued,
    pools: [],
    dagActive: {},
    executor: { running: 0, queued: queued.length },
    workers: { current: 1, target: 1 },
  }) satisfies LiveSnapshot;

/**
 * Ten minutes of 30 s snapshots in the etl pool: two low-priority tries (weight 1) wait the whole time; two
 * high-priority tries (weight 3) each wait 30 s; one weight-2 try waits 120 s ready, then 30 s queued. The
 * default pool has one weight only.
 */
function snapshots(): LiveSnapshot[] {
  return Array.from({ length: 21 }, (_, k) => {
    const at = k * 30;
    const scheduled = [ti('low_1', 1, 0), ti('low_2', 1, 0), ti('same_1', 1, 0, 'default_pool')];
    if (at === 60 || at === 90) scheduled.push(ti('high_1', 3, 60));
    if (at === 300 || at === 330) scheduled.push(ti('high_2', 3, 300));
    if (at <= 90) scheduled.push(ti('mid_1', 2, 0));
    const queued = at === 120 || at === 150 ? [ti('mid_1', 2, 120)] : [];
    return snap(at, scheduled, queued);
  });
}
const window = { from: T0, to: T0 + 11 * 60 * SEC };

describe('HM-023 priority fairness (observable part)', () => {
  const pools = priorityFairness(snapshots(), window);
  const etl = pools.find((p) => p.pool === 'etl');

  it('HM-023: groups the waiting tries of a pool into priority bands by weight', () => {
    expect(etl?.tries).toBe(5);
    expect(etl?.distinctWeights).toBe(3);
    expect(etl?.bands.map((b) => [b.band, b.minWeight, b.maxWeight, b.tries])).toEqual([
      ['low', 1, 1, 2],
      ['mid', 2, 2, 1],
      ['high', 3, 3, 2],
    ]);
  });

  it('HM-023: observed wait is last seen waiting − first known ready or queued time, in ms', () => {
    const [low, mid, high] = etl?.bands ?? [];
    expect(low?.waitP50.value).toBe(600 * SEC);
    expect(mid?.waitP50.value).toBe(150 * SEC);
    expect(high?.waitP50.value).toBe(30 * SEC);
  });

  it('§8.9: a p95 from fewer than 20 tries is the max, flagged low sample', () => {
    const [low] = etl?.bands ?? [];
    expect(low?.waitP95).toEqual({ value: 600 * SEC, samples: 2, lowSample: true });
  });

  it('HM-023: a pool whose tries all share one weight has no bands (priority cannot be unfair there)', () => {
    const same = pools.find((p) => p.pool === 'default_pool');
    expect(same?.distinctWeights).toBe(1);
    expect(same?.bands).toEqual([]);
  });

  it('HM-023: bands cover every try once, in weight order, lowest weight low and highest high', () => {
    const arb = fc.array(
      fc.record({
        task: fc.integer({ min: 0, max: 15 }),
        weight: fc.integer({ min: 1, max: 6 }),
        seen: fc.integer({ min: 0, max: 20 }),
        since: fc.integer({ min: 0, max: 600 }),
      }),
      { maxLength: 60 },
    );
    fc.assert(
      fc.property(arb, (specs) => {
        const byTask = new Map<number, (typeof specs)[number]>();
        for (const s of specs) byTask.set(s.task, byTask.get(s.task) ?? s);
        const snaps = Array.from({ length: 21 }, (_, k) =>
          snap(
            k * 30,
            [...byTask.values()].filter((s) => s.seen >= k).map((s) => ti(`t${s.task}`, s.weight, -s.since)),
          ),
        );
        for (const p of priorityFairness(snaps, window)) {
          if (p.distinctWeights < 2) {
            expect(p.bands).toEqual([]);
            continue;
          }
          expect(p.bands.reduce((n, b) => n + b.tries, 0)).toBe(p.tries);
          expect(p.bands[0]?.band).toBe('low');
          expect(p.bands[p.bands.length - 1]?.band).toBe('high');
          for (let i = 1; i < p.bands.length; i++)
            expect(p.bands[i]?.minWeight).toBeGreaterThan(p.bands[i - 1]?.maxWeight ?? Infinity);
        }
      }),
    );
  });
});
