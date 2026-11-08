import { describe, expect, it } from 'vitest';
import {
  UNKNOWN_LIMIT,
  atLimitShare,
  dagSelfThrottling,
  environmentSignals,
  raisesRecDag01,
  type DagMeta,
  type EnvironmentConfig,
  type LiveSnapshot,
  type SnapshotTaskInstance,
} from '../src/index';

const T0 = Date.UTC(2026, 10, 5, 12, 0, 0);
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
  pools: [{ name: 'default_pool', slots: 128 }],
};
const dag = (dagId: string, maxActiveTasks: number): DagMeta => ({
  dagId,
  fileloc: `/home/airflow/gcs/dags/${dagId}.py`,
  owners: ['acme'],
  tags: [],
  team: 'acme',
  schedule: '0 * * * *',
  maxActiveTasks,
  maxActiveRuns: 25,
  catchup: false,
  paused: false,
});
const ready = (dagId: string): SnapshotTaskInstance => ({
  dagId,
  runId: 'scheduled__2026-11-05T11:00:00+00:00',
  taskId: 't',
  mapIndex: -1,
  tryNumber: 1,
  pool: 'default_pool',
  poolSlots: 1,
  priorityWeight: 1,
  since: T0 - 5 * MIN,
});
const snapshot = (minute: number, active: number, readyCount: number, running = active): LiveSnapshot => ({
  at: T0 + minute * MIN,
  scheduled: Array.from({ length: readyCount }, () => ready('acme_fanout')),
  queued: [],
  pools: [],
  dagActive: active > 0 ? { acme_fanout: active } : {},
  executor: { running, queued: 0 },
  workers: { current: 2, target: 2 },
});

describe('HM-005 DAG self-throttling, shared with REC-DAG-01', () => {
  // Gaps 0.5, 0.5, 1, 1 min: cadence 0.75 min (median), so the last snapshot stands for 0.75 min.
  const snapshots = [
    snapshot(0, 4, 1), // at the limit with one own task ready
    snapshot(0.5, 4, 1, 8), // the same, and the 8 worker slots are full
    snapshot(1, 4, 0), // at the limit, nothing waiting: active only
    snapshot(2, 2, 1), // below the limit: active only
    snapshot(3, 0, 0), // inactive
  ];
  const window = { from: T0, to: T0 + 10 * MIN, fallbackCadenceMs: 30_000 };

  it('HM-005: time at max_active_tasks with own ready work, active time, own waiting, peak and headroom', () => {
    const d = dagSelfThrottling({ ...window, snapshots, dagId: 'acme_fanout', limit: 4, config });
    expect(d).toEqual({
      activeObservations: 4,
      activeMs: 3 * MIN,
      atLimitObservations: 2,
      atLimitMs: MIN,
      ownWaitingMs: MIN,
      peakDemand: 5,
      headroomObservations: 1,
      lastAtLimit: T0 + 0.5 * MIN,
    });
    expect(atLimitShare(d)).toBeCloseTo(1 / 3, 12);
  });

  it('HM-005: equals the advisor signal for the same DAG and window', () => {
    const dags = [dag('acme_fanout', 4)];
    const advisor = environmentSignals({
      config,
      dags,
      snapshots,
      workerSamples: [],
      tries: [],
      ...window,
      triesCoverage: 1,
      workerResources: null,
    }).dagLimits.find((x) => x.dagId === 'acme_fanout');
    const mine = dagSelfThrottling({ ...window, snapshots, dagId: 'acme_fanout', limit: 4, config });
    expect(advisor).toMatchObject(mine);
  });

  it('HM-032: headroom is unknown, never "free", while worker_concurrency is unknown', () => {
    const unknown: EnvironmentConfig = {
      ...config,
      workerConcurrency: UNKNOWN_LIMIT,
      limitSources: { workerConcurrency: 'unknown' },
    };
    const d = dagSelfThrottling({ ...window, snapshots, dagId: 'acme_fanout', limit: 4, config: unknown });
    expect(d.headroomObservations).toBeNull();
  });

  it('HM-005: no active time without snapshots of the DAG; the share is then null', () => {
    const d = dagSelfThrottling({ ...window, snapshots: [], dagId: 'acme_fanout', limit: 4, config });
    expect(d).toMatchObject({ activeMs: 0, atLimitMs: 0, lastAtLimit: null });
    expect(atLimitShare(d)).toBeNull();
  });

  it('REC-DAG-01: raised at 10 % of active time at the limit, as the advisor evaluates it', () => {
    expect(raisesRecDag01({ activeMs: 1_000, atLimitMs: 100 })).toBe(true);
    expect(raisesRecDag01({ activeMs: 1_000, atLimitMs: 99 })).toBe(false);
    expect(raisesRecDag01({ activeMs: 0, atLimitMs: 0 })).toBe(false);
  });
});
