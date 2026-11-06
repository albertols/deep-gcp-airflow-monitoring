import { describe, expect, it } from 'vitest';
import {
  attributeWaiting,
  capacityStats,
  type EnvironmentConfig,
  type LiveSnapshot,
  type SnapshotTaskInstance,
  type WorkerSample,
  UNKNOWN_LIMIT,
} from '../src/index';

const T0 = Date.UTC(2026, 10, 5, 11, 0, 0);
const MIN = 60_000;
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
  pools: [{ name: 'tiny', slots: 1 }],
};
const ctx = { config, dagMaxActiveTasks: new Map<string, number>() };
const ti = (dagId: string, since: number): SnapshotTaskInstance => ({
  dagId,
  runId: 'r',
  taskId: 't',
  mapIndex: -1,
  tryNumber: 1,
  pool: 'tiny',
  poolSlots: 1,
  priorityWeight: 1,
  since,
});
/** Two DAGs wait on a full one-slot pool; workers at max with slots full also leave one queued. */
const snap = (at: number): LiveSnapshot => ({
  at,
  scheduled: [ti('a', T0 - MIN), ti('b', T0 - MIN)],
  queued: [ti('c', T0 - MIN)],
  pools: [{ name: 'tiny', slots: 1, running: 1, queued: 0, open: 0 }],
  dagActive: {},
  executor: { running: 8, queued: 1 },
  workers: { current: 2, target: 2 },
});
const snapshots = [0, 1, 2, 3].map((i) => snap(T0 + i * 30_000));

describe('HM-006 attribution over time (FR-BOTL-01)', () => {
  const a = attributeWaiting(snapshots, ctx, {
    from: T0,
    to: T0 + 2 * MIN,
    bucketMs: MIN,
    intervalMs: 30_000,
  });

  it('FR-BOTL-01: each waiting task instance in a snapshot counts one snapshot interval of waiting', () => {
    expect(a.totals.get('pool-exhausted')).toBe(2 * 4 * 30_000);
    expect(a.totals.get('executor-slots-exhausted')).toBe(4 * 30_000);
  });

  it('FR-BOTL-01: buckets the waiting by reason over time', () => {
    expect(a.buckets.map((b) => b.start)).toEqual([T0, T0 + MIN]);
    expect(a.buckets[0]?.byReason.get('pool-exhausted')).toBe(2 * 2 * 30_000);
    expect(a.buckets[0]?.workers).toBe(2);
    expect(a.buckets[0]?.slotsUsed).toBe(1);
  });

  it('FR-BOTL-01: ranks the DAGs that contribute to each reason', () => {
    expect([...(a.byReasonDag.get('pool-exhausted') ?? new Map())]).toEqual([
      ['a', 4 * 30_000],
      ['b', 4 * 30_000],
    ]);
  });

  it('REC-CONC-02: counts pool-starved time (zero open slots with work waiting) and pool waiting', () => {
    expect(a.pools.get('tiny')).toMatchObject({ waitingMs: 8 * 30_000, starvedMs: 4 * 30_000 });
  });

  it('records how much of each reason happened while workers were at max_count', () => {
    expect(a.atMaxWorkersMs.get('executor-slots-exhausted')).toBe(4 * 30_000);
  });

  it('keeps the latest snapshot for the current binding limit, and ignores snapshots outside the window', () => {
    expect(a.latest?.snapshot.at).toBe(T0 + 90_000);
    const none = attributeWaiting(snapshots, ctx, {
      from: T0 + 10 * MIN,
      to: T0 + 11 * MIN,
      bucketMs: MIN,
      intervalMs: 30_000,
    });
    expect(none.totals.size).toBe(0);
    expect(none.latest).toBeNull();
  });
});

describe('HM-011 / HM-012 worker capacity', () => {
  const sample = (
    i: number,
    workers: number,
    target: number,
    running: number,
    queued: number,
  ): WorkerSample => ({
    at: T0 + i * MIN,
    workers,
    target,
    running,
    queued,
    cpu: 0.2,
    memory: 0.3,
  });
  const samples = [
    sample(0, 1, 1, 2, 0),
    sample(1, 1, 2, 4, 6), // target rises above workers
    sample(2, 1, 2, 4, 9),
    sample(3, 2, 2, 8, 12), // reached the target 2 min later; at max with a long queue
    sample(4, 2, 2, 8, 0),
  ];

  it('HM-011: minutes at max_count and capacity-bound minutes (queued ≥ max(10, 20 % of slots))', () => {
    const c = capacityStats(samples, config);
    expect(c.minutesAtMax).toBe(2);
    expect(c.capacityBoundMinutes).toBe(1);
    expect(c.utilisation.samples).toBe(5);
  });

  it('HM-012: scale-up lag from the target rising to the workers reaching it', () => {
    expect(capacityStats(samples, config).scaleUpLagsSeconds).toEqual([120]);
  });

  it('HM-011: a sample before a collection gap counts for one sample interval, not the whole gap', () => {
    const gap = [sample(0, 2, 2, 8, 12), sample(120, 1, 1, 2, 0)];
    const c = capacityStats(gap, config);
    expect(c.minutesAtMax).toBe(1);
    expect(c.capacityBoundMinutes).toBe(1);
  });

  it('HM-011 / HM-032: with an unknown worker_concurrency slot utilisation and capacity-bound minutes are unknown', () => {
    const unknown: EnvironmentConfig = {
      ...config,
      workerConcurrency: UNKNOWN_LIMIT,
      limitSources: { workerConcurrency: 'unknown' },
    };
    const c = capacityStats(samples, unknown);
    expect(c.utilisation).toEqual({ value: null, samples: 0, lowSample: true });
    expect(c.minutesAtMax).toBe(2);
    // HM-032: "queued ≥ 20 % of slots" cannot be checked, so capacity-bound minutes are unknown, not 0.
    expect(c.capacityBoundMinutes).toBeNull();
    const a = attributeWaiting(
      snapshots,
      { config: unknown, dagMaxActiveTasks: new Map() },
      {
        from: T0,
        to: T0 + 2 * MIN,
        bucketMs: MIN,
        intervalMs: 30_000,
      },
    );
    expect(a.buckets.map((b) => b.slotsUsed)).toEqual([null, null]);
    expect(a.buckets.map((b) => b.workers)).toEqual([2, 2]);
  });
});
