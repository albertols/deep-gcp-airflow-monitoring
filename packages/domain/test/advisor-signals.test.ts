import { describe, expect, it } from 'vitest';
import {
  environmentSignals,
  type AdvisorInput,
  type DagMeta,
  type EnvironmentConfig,
  type LiveSnapshot,
  type ObservedTry,
  type SnapshotTaskInstance,
  type WorkerSample,
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
  pools: [
    { name: 'default_pool', slots: 128 },
    { name: 'tiny', slots: 2 },
  ],
};
const dag = (dagId: string, schedule: string, maxActiveTasks = 16): DagMeta => ({
  dagId,
  fileloc: `/home/airflow/gcs/dags/${dagId}.py`,
  owners: ['acme'],
  tags: [],
  team: 'acme',
  schedule,
  maxActiveTasks,
  maxActiveRuns: 25,
  catchup: false,
  paused: false,
});
const dags = [
  dag('wide_dag', '0 * * * *', 2),
  dag('orders_daily', '0 2 * * *'),
  dag('partner_sync', '5 * * * *'),
];
const ti = (dagId: string, pool = 'default_pool'): SnapshotTaskInstance => ({
  dagId,
  runId: 'scheduled__2026-11-05T11:00:00+00:00',
  taskId: 't',
  mapIndex: -1,
  tryNumber: 1,
  pool,
  poolSlots: 1,
  priorityWeight: 1,
  since: T0 - 5 * MIN,
});
// 20 snapshots over 10 minutes. In the first 5 minutes the tiny pool is full and worker slots are full at
// max_count; wide_dag sits at its max_active_tasks of 2 throughout with two ready tasks of its own.
const snapshots: LiveSnapshot[] = Array.from({ length: 20 }, (_, i) => {
  const early = i < 10;
  return {
    at: T0 + i * 30_000,
    scheduled: [ti('wide_dag'), ti('wide_dag'), ti('partner_sync', 'tiny')],
    queued: [ti('orders_daily'), ti('orders_daily'), ti('orders_daily')],
    pools: [
      { name: 'default_pool', slots: 128, running: 6, queued: 3, open: 119 },
      { name: 'tiny', slots: 2, running: early ? 2 : 1, queued: 0, open: early ? 0 : 1 },
    ],
    dagActive: { wide_dag: 2, partner_sync: 2, orders_daily: 3 },
    executor: { running: early ? 8 : 6, queued: 3 },
    workers: { current: 2, target: 2 },
  };
});
// Ten one-minute samples: workers at max with 12 queued for 5 minutes, then idle.
const samples: WorkerSample[] = Array.from({ length: 10 }, (_, i) => ({
  at: T0 + i * MIN,
  workers: 2,
  target: 2,
  running: i < 5 ? 8 : 4,
  queued: i < 5 ? 12 : 0,
  cpu: i < 5 ? 0.2 : 0.1,
  memory: i < 5 ? 0.3 : 0.2,
}));
const attempt = (over: Partial<ObservedTry>): ObservedTry => ({
  dagId: 'orders_daily',
  taskId: 'load',
  runId: 'r',
  mapIndex: -1,
  tryNumber: 1,
  pool: 'default_pool',
  poolSlots: 1,
  queuedAt: null,
  startAt: T0,
  endAt: T0 + MIN,
  operator: 'PythonOperator',
  state: 'success',
  ...over,
});
const tries: ObservedTry[] = [
  attempt({
    dagId: 'partner_feed_wait',
    taskId: 'wait_for_feed',
    operator: 'ExternalTaskSensor',
    endAt: T0 + 8 * MIN,
  }),
  attempt({
    dagId: 'files',
    taskId: 'wait_file',
    operator: 'GCSObjectExistenceSensor',
    state: 'up_for_reschedule',
  }),
  attempt({ taskId: 'queued_while_bound', queuedAt: T0 + MIN, startAt: T0 + 4 * MIN, endAt: T0 + 5 * MIN }),
  attempt({ taskId: 'queued_later', queuedAt: T0 + 7 * MIN, startAt: T0 + 9 * MIN, endAt: T0 + 10 * MIN }),
];
const input: AdvisorInput = {
  config,
  dags,
  snapshots,
  workerSamples: samples,
  tries,
  from: T0,
  to: T0 + 10 * MIN,
  snapshotIntervalMs: 30_000,
  triesCoverage: 1,
  workerResources: null,
};

describe('advisor signals over the window', () => {
  it('§13.2: coverage is the share of the window with snapshots and worker samples', () => {
    const s = environmentSignals(input);
    expect(s.coverage).toEqual({ snapshots: 1, samples: 1, tries: 1 });
    const half = environmentSignals({ ...input, snapshots: snapshots.slice(0, 10) });
    expect(half.coverage.snapshots).toBe(0.5);
  });

  it('HM-011 / REC-CAP-01: capacity-bound minutes, stretches, queued peak and queue wait while bound', () => {
    const { capacity } = environmentSignals(input);
    expect(capacity.capacityBoundMinutes).toBe(5);
    expect(capacity.bound).toMatchObject({ minutes: 5, queuedPeak: 12, queuedTaskMinutes: 60 });
    expect(capacity.bound.episodes).toEqual([{ start: T0, end: T0 + 5 * MIN, minutes: 5 }]);
    expect(capacity.bound.maxQueueWaitMs).toBe(3 * MIN);
    expect(capacity.bound.demandP95).toBe(20);
  });

  it('HM-011 / REC-CAP-01: a bound sample before a collection gap counts for one minute, not the gap', () => {
    const gap = [samples[0] as WorkerSample, { ...(samples[9] as WorkerSample), at: T0 + 120 * MIN }];
    const { capacity } = environmentSignals({ ...input, workerSamples: gap, to: T0 + 121 * MIN });
    expect(capacity.bound.minutes).toBe(1);
    expect(capacity.bound.queuedTaskMinutes).toBe(12);
    expect(capacity.bound.episodes).toEqual([{ start: T0, end: T0 + MIN, minutes: 1 }]);
  });

  it('HM-027 / REC-CAP-05: worker CPU and memory while executor slots were exhausted at max_count', () => {
    const { capacity } = environmentSignals(input);
    expect(capacity.slotsFullAtMax).toMatchObject({ minutes: 5, cpuP95: 0.2, memoryP95: 0.3 });
  });

  it('HM-006: waiting totals, minutes per reason and waiting by minute-of-hour', () => {
    const { waiting } = environmentSignals(input);
    expect(waiting.totalsMs.get('dag-max-active-tasks')).toBe(20 * 2 * 30_000);
    expect(waiting.totalsMs.get('pool-exhausted')).toBe(10 * 30_000);
    expect(waiting.totalsMs.get('executor-slots-exhausted')).toBe(10 * 3 * 30_000);
    expect(waiting.minutes.get('pool-exhausted')).toBe(5);
    expect(waiting.lastSeen.get('pool-exhausted')).toBe(T0 + 4 * MIN);
    expect(waiting.byMinuteOfHour.waitingMs.slice(0, 10).every((ms) => ms > 0)).toBe(true);
    expect(waiting.byMinuteOfHour.waitingMs[10]).toBe(0);
  });

  it('REC-CONC-02: pool starvation with the DAGs that waited for the pool and its peak demand', () => {
    const tiny = environmentSignals(input).pools.find((p) => p.name === 'tiny');
    expect(tiny).toMatchObject({
      slots: 2,
      starvedMinutes: 5,
      starvedObservations: 10,
      bindingWaitingMs: 10 * 30_000,
      waitingWhileStarvedMs: 10 * 30_000,
      peakDemandSlots: 3,
      lastStarved: T0 + 9 * 30_000,
    });
    expect([...(tiny?.dagWaitingMs ?? [])]).toEqual([['partner_sync', 10 * 30_000]]);
  });

  it('HM-005 / REC-DAG-01: time at max_active_tasks with own ready work, peak demand and headroom', () => {
    const wide = environmentSignals(input).dagLimits.find((d) => d.dagId === 'wide_dag');
    expect(wide).toMatchObject({
      limit: 2,
      limitIsDefault: false,
      activeObservations: 20,
      atLimitObservations: 20,
      ownWaitingMs: 20 * 2 * 30_000,
      peakDemand: 4,
      headroomObservations: 10,
      lastAtLimit: T0 + 19 * 30_000,
    });
    expect(environmentSignals(input).dagLimits.some((d) => d.dagId === 'orders_daily')).toBe(false);
  });

  it('HM-008 / REC-DAG-05: sensor slot time with the mode inferred from observed states', () => {
    const { sensors } = environmentSignals(input);
    expect(sensors).toEqual([
      expect.objectContaining({
        dagId: 'partner_feed_wait',
        taskId: 'wait_for_feed',
        operator: 'ExternalTaskSensor',
        mode: 'poke',
        slotSeconds: 480,
        tries: 1,
      }),
      expect.objectContaining({ dagId: 'files', mode: 'reschedule' }),
    ]);
  });

  it('HM-009 / HM-003: collision density from DAG schedules and slot-seconds per DAG and pool', () => {
    const s = environmentSignals(input);
    expect(s.schedules.busiestMinute).toBe(0);
    expect(s.slotSecondsByDag.get('partner_feed_wait')).toBe(480);
    expect(s.poolSlotSeconds.get('default_pool')).toBeGreaterThan(0);
  });
});
