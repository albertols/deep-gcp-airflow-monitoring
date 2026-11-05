import { describe, expect, it } from 'vitest';
import {
  classifySnapshot,
  type EnvironmentConfig,
  type LiveSnapshot,
  type SnapshotTaskInstance,
  UNKNOWN_LIMIT,
} from '../src/index';

const AT = Date.UTC(2026, 10, 5, 12, 0, 0);
const config: EnvironmentConfig = {
  envId: 'acme-prod',
  tier: 'prod',
  composerImage: 'composer-3-airflow-2.11.1-build.22',
  airflowVersion: '2.11.1',
  parallelism: 10,
  schedulers: 1,
  maxActiveTasksPerDag: 16,
  maxActiveRunsPerDag: 25,
  workerConcurrency: 4,
  minWorkers: 1,
  maxWorkers: 3,
  pools: [
    { name: 'default_pool', slots: 128 },
    { name: 'tiny', slots: 1 },
  ],
};
const limits = new Map([['capped_dag', 2]]);
const ti = (over: Partial<SnapshotTaskInstance> = {}): SnapshotTaskInstance => ({
  dagId: 'orders_daily',
  runId: 'scheduled__2026-11-05T11:00:00+00:00',
  taskId: 'load',
  mapIndex: -1,
  tryNumber: 1,
  pool: 'default_pool',
  poolSlots: 1,
  priorityWeight: 1,
  since: AT - 120_000,
  ...over,
});
const snapshot = (over: Partial<LiveSnapshot> = {}): LiveSnapshot => ({
  at: AT,
  scheduled: [],
  queued: [],
  pools: [
    { name: 'default_pool', slots: 128, running: 2, queued: 0, open: 126 },
    { name: 'tiny', slots: 1, running: 1, queued: 0, open: 0 },
  ],
  dagActive: {},
  executor: { running: 2, queued: 0 },
  workers: { current: 1, target: 1 },
  ...over,
});
const ctx = { config, dagMaxActiveTasks: limits };
const reasonOf = (s: LiveSnapshot) => classifySnapshot(s, ctx).map((c) => c.reason);

describe('HM-006 waiting classifier (first match wins, spec L1036–1084)', () => {
  it('HM-006 #2: a task in a pool that does not exist waits for "pool does not exist"', () => {
    expect(reasonOf(snapshot({ scheduled: [ti({ pool: 'nope' })] }))).toEqual(['pool-missing']);
  });

  it('HM-006 #3: a task needing more slots than its pool has waits for "task larger than its pool"', () => {
    expect(reasonOf(snapshot({ scheduled: [ti({ pool: 'tiny', poolSlots: 2 })] }))).toEqual([
      'task-larger-than-pool',
    ]);
  });

  it('HM-006 #4: running + queued at parallelism × schedulers means "global parallelism"', () => {
    const s = snapshot({ scheduled: [ti()], executor: { running: 8, queued: 2 } });
    expect(reasonOf(s)).toEqual(['parallelism']);
  });

  it('HM-006 #5: fewer open pool slots than the task needs means "pool exhausted"', () => {
    expect(reasonOf(snapshot({ scheduled: [ti({ pool: 'tiny' })] }))).toEqual(['pool-exhausted']);
  });

  it('HM-006 #6: a DAG at its max_active_tasks means "DAG max_active_tasks"', () => {
    const s = snapshot({ scheduled: [ti({ dagId: 'capped_dag' })], dagActive: { capped_dag: 2 } });
    expect(reasonOf(s)).toEqual(['dag-max-active-tasks']);
    const defaultLimit = snapshot({ scheduled: [ti()], dagActive: { orders_daily: 16 } });
    expect(reasonOf(defaultLimit)).toEqual(['dag-max-active-tasks']);
  });

  it('HM-006 #8: no limit binds but not queued 30 s after ready means "scheduler throughput"', () => {
    expect(reasonOf(snapshot({ scheduled: [ti({ since: AT - 31_000 })] }))).toEqual(['scheduler-throughput']);
    expect(reasonOf(snapshot({ scheduled: [ti({ since: AT - 10_000 })] }))).toEqual(['normal-latency']);
  });

  it('HM-006 #9: slots full, workers below max_count and the target above current means "autoscaling lag"', () => {
    const s = snapshot({
      queued: [ti()],
      executor: { running: 4, queued: 1 },
      workers: { current: 1, target: 2 },
    });
    expect(reasonOf(s)).toEqual(['autoscaling-lag']);
  });

  it('HM-006 #10: slots full with workers at max_count means "executor slots exhausted"', () => {
    const s = snapshot({
      queued: [ti()],
      executor: { running: 12, queued: 1 },
      workers: { current: 3, target: 3 },
    });
    expect(reasonOf(s)).toEqual(['executor-slots-exhausted']);
  });

  it('HM-006 #11: free slots but queued for 60 s or more means "worker pickup"; less is normal latency', () => {
    expect(reasonOf(snapshot({ queued: [ti({ since: AT - 61_000 })] }))).toEqual(['worker-pickup']);
    expect(reasonOf(snapshot({ queued: [ti({ since: AT - 5_000 })] }))).toEqual(['normal-latency']);
  });

  it('HM-006 #13: slots full below max_count with no scale-up planned is "unknown", not a guess', () => {
    const s = snapshot({
      queued: [ti()],
      executor: { running: 4, queued: 1 },
      workers: { current: 1, target: 1 },
    });
    expect(reasonOf(s)).toEqual(['unknown']);
  });

  it('HM-006: keeps the other matching reasons as secondary evidence, in evaluation order', () => {
    const s = snapshot({
      scheduled: [ti({ dagId: 'capped_dag', pool: 'tiny' })],
      dagActive: { capped_dag: 2 },
      executor: { running: 9, queued: 1 },
    });
    const [c] = classifySnapshot(s, ctx);
    expect(c?.reason).toBe('parallelism');
    expect(c?.secondary).toEqual(['pool-exhausted', 'dag-max-active-tasks']);
    expect(c?.phase).toBe('pre-queue');
  });
});

describe('HM-006 with limits DCAM does not know (Composer without an override, HM-032 later)', () => {
  const unknown = (keys: ReadonlyArray<'parallelism' | 'workerConcurrency'>) => ({
    config: {
      ...config,
      parallelism: UNKNOWN_LIMIT,
      workerConcurrency: UNKNOWN_LIMIT,
      limitSources: Object.fromEntries(keys.map((k) => [k, 'unknown' as const])),
    },
    dagMaxActiveTasks: limits,
  });

  it('HM-006 #4: an unknown parallelism is never binding, even with a large executor backlog', () => {
    const s = snapshot({ scheduled: [ti()], executor: { running: 2_000, queued: 50_000 } });
    const [c] = classifySnapshot(s, unknown(['parallelism']));
    expect(c?.reason).toBe('scheduler-throughput');
    expect(c?.secondary).toEqual([]);
  });

  it('HM-006 #9–#11: with an unknown worker_concurrency a long post-queue wait is "unknown", not a slot guess', () => {
    const s = snapshot({
      queued: [ti({ since: AT - 61_000 }), ti({ taskId: 'fresh', since: AT - 5_000 })],
      executor: { running: 40, queued: 2 },
      workers: { current: 3, target: 3 },
    });
    expect(classifySnapshot(s, unknown(['workerConcurrency'])).map((c) => c.reason)).toEqual([
      'unknown',
      'normal-latency',
    ]);
  });

  it('HM-006: the placeholder alone never binds when the provenance is lost', () => {
    const s = snapshot({ scheduled: [ti()], executor: { running: 2_000, queued: 50_000 } });
    const withoutSources: EnvironmentConfig = { ...config, parallelism: UNKNOWN_LIMIT };
    expect(classifySnapshot(s, { config: withoutSources, dagMaxActiveTasks: limits })[0]?.reason).toBe(
      'scheduler-throughput',
    );
  });
});
