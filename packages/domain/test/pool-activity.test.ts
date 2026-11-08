import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  attributeWaiting,
  poolActivity,
  type EnvironmentConfig,
  type LiveSnapshot,
  type PoolState,
  type SnapshotTaskInstance,
} from '../src/index';

const T0 = Date.UTC(2026, 10, 5, 11, 0, 0);
const SEC = 1_000;
const MIN = 60 * SEC;
const config: EnvironmentConfig = {
  envId: 'acme-prod',
  tier: 'prod',
  composerImage: 'composer-3-airflow-2.11.1-build.22',
  airflowVersion: '2.11.1',
  parallelism: 100,
  schedulers: 1,
  maxActiveTasksPerDag: 16,
  maxActiveRunsPerDag: 25,
  workerConcurrency: 4,
  minWorkers: 1,
  maxWorkers: 2,
  pools: [
    { name: 'etl', slots: 2 },
    { name: 'default_pool', slots: 128 },
  ],
};
const ti = (dagId: string, pool = 'etl'): SnapshotTaskInstance => ({
  dagId,
  runId: 'r',
  taskId: 't',
  mapIndex: -1,
  tryNumber: 1,
  pool,
  poolSlots: 1,
  priorityWeight: 1,
  since: T0 - MIN,
});
const etl = (running: number, queued: number): PoolState => ({
  name: 'etl',
  slots: 2,
  running,
  queued,
  open: Math.max(0, 2 - running - queued),
});
const snap = (
  at: number,
  pool: PoolState,
  scheduled: SnapshotTaskInstance[],
  queued: SnapshotTaskInstance[] = [],
): LiveSnapshot => ({
  at,
  scheduled,
  queued,
  pools: [pool, { name: 'default_pool', slots: 128, running: 0, queued: 0, open: 128 }],
  dagActive: {},
  executor: { running: pool.running, queued: pool.queued },
  workers: { current: 1, target: 1 },
});
const opts = { from: T0, to: T0 + 3 * MIN, bucketMs: MIN, fallbackCadenceMs: 30 * SEC };

describe('FR-ENV-08 pool activity', () => {
  // Two DAGs wait for the full two-slot etl pool; b is queued next; then a slot opens.
  const snapshots = [
    snap(T0, etl(2, 0), [ti('a'), ti('b')]),
    snap(T0 + 30 * SEC, etl(1, 1), [ti('a')], [ti('b')]),
    snap(T0 + 60 * SEC, etl(1, 0), []),
  ];
  const [pool] = poolActivity(snapshots, config, opts);

  it('FR-ENV-08: running and queued slots are time-weighted means over the snapshots, with the peak', () => {
    expect(pool?.name).toBe('etl');
    expect(pool?.slots).toBe(2);
    expect(pool?.observedMs).toBe(90 * SEC);
    expect(pool?.runningSlotsAvg).toBeCloseTo(4 / 3);
    expect(pool?.runningSlotsPeak).toBe(2);
    expect(pool?.queuedSlotsAvg).toBeCloseTo(1 / 3);
  });

  it('FR-ENV-08: ready and queued waiting task-time in the pool, and the DAGs that waited most', () => {
    expect(pool?.readyTaskMs).toBe(90 * SEC);
    expect(pool?.queuedTaskMs).toBe(30 * SEC);
    expect(pool?.topDags).toEqual([
      { dagId: 'a', waitingMs: 60 * SEC },
      { dagId: 'b', waitingMs: 60 * SEC },
    ]);
  });

  it('FR-ENV-08: starved time is zero open slots while ready work waited; buckets without snapshots are gaps', () => {
    expect(pool?.starvedMs).toBe(60 * SEC);
    expect(pool?.starvedByBucket).toEqual([60 * SEC, 0, null]);
  });

  it('FR-ENV-08: the cadence is that of raw snapshots: thinned ones (one per 5 min) do not stretch the raw ones', () => {
    // 20 h thinned, then 2 h raw every 30 s, then the collector stops 20 min before the end.
    const starved = etl(2, 0);
    const thinned = Array.from({ length: 240 }, (_, k) => ({
      ...snap(T0 + k * 5 * MIN, starved, [ti('a')]),
      spanMs: 5 * MIN,
    }));
    const rawFrom = T0 + 20 * 60 * MIN;
    const raw = Array.from({ length: 240 }, (_, k) => snap(rawFrom + k * 30 * SEC, starved, [ti('a')]));
    const to = rawFrom + 140 * MIN;
    const [p] = poolActivity([...thinned, ...raw], config, { ...opts, to, bucketMs: 60 * MIN });
    // Each raw snapshot stands for 30 s, the last one too: the 20 min after it are a collection gap.
    expect(p?.observedMs).toBe(20 * 60 * MIN + 120 * MIN);
    expect(p?.starvedMs).toBe(20 * 60 * MIN + 120 * MIN);
    const a = attributeWaiting(
      [...thinned, ...raw],
      { config, dagMaxActiveTasks: new Map() },
      {
        ...opts,
        to,
        bucketMs: 60 * MIN,
      },
    );
    expect(a.coveredMs).toBe(p?.observedMs);
  });

  it('FR-ENV-08: a pool never seen in a snapshot has no means (no data, never zero)', () => {
    const [unseen] = poolActivity([], config, opts);
    expect(unseen?.observedMs).toBe(0);
    expect(unseen?.runningSlotsAvg).toBeNull();
    expect(unseen?.runningSlotsPeak).toBeNull();
    expect(unseen?.queuedSlotsAvg).toBeNull();
    expect(unseen?.starvedByBucket).toEqual([null, null, null]);
  });

  it('FR-ENV-08: starved time never exceeds observed time, and top DAG waiting adds up to ready + queued', () => {
    const arbTi = fc.record({ dag: fc.constantFrom('a', 'b', 'c'), pool: fc.constantFrom('etl', 'x') });
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            running: fc.integer({ min: 0, max: 2 }),
            queued: fc.integer({ min: 0, max: 2 }),
            scheduled: fc.array(arbTi, { maxLength: 5 }),
            waitingQueued: fc.array(arbTi, { maxLength: 3 }),
            gap: fc.integer({ min: 1, max: 200 }),
          }),
          { maxLength: 12 },
        ),
        (specs) => {
          let at = T0;
          const snapshots = specs.map((s) => {
            at += s.gap * SEC;
            return snap(
              at,
              etl(s.running, s.queued),
              s.scheduled.map((x) => ti(x.dag, x.pool)),
              s.waitingQueued.map((x) => ti(x.dag, x.pool)),
            );
          });
          const window = { ...opts, to: T0 + 60 * MIN };
          const [p] = poolActivity(snapshots, config, window);
          if (!p) throw new Error('etl missing');
          expect(p.starvedMs).toBeLessThanOrEqual(p.observedMs);
          const buckets = p.starvedByBucket.reduce<number>((x, y) => x + (y ?? 0), 0);
          expect(buckets).toBeCloseTo(p.starvedMs, 6);
          const dags = p.topDags.reduce((x, d) => x + d.waitingMs, 0);
          expect(dags).toBeCloseTo(p.readyTaskMs + p.queuedTaskMs, 6);
        },
      ),
    );
  });
});
