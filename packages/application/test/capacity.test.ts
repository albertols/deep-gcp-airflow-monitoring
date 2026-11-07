import { describe, expect, it } from 'vitest';
import {
  UNKNOWN_LIMIT,
  type DagMeta,
  type EnvironmentConfig,
  type LiveSnapshot,
  type WorkerSample,
} from '@dcam/domain';
import type { EnvironmentModelSource, StoredTaskTry, TaskInstanceStore } from '@dcam/ports';
import { getCapacity } from '../src/index';

const MIN = 60_000;
const NOW = Date.UTC(2026, 10, 5, 12, 7, 30);
const config: EnvironmentConfig = {
  envId: 'acme-prod',
  tier: 'prod',
  composerImage: 'composer-3-airflow-2.11.1-build.22',
  airflowVersion: '2.11.1',
  parallelism: UNKNOWN_LIMIT,
  schedulers: 2,
  maxActiveTasksPerDag: 16,
  maxActiveRunsPerDag: 25,
  workerConcurrency: 6,
  minWorkers: 1,
  maxWorkers: 2,
  pools: [{ name: 'default_pool', slots: 128 }],
  limitSources: { parallelism: 'unknown', workerConcurrency: 'override' },
};

/** The last 30 minutes: two workers (max_count) with 12 queued, so every minute is capacity-bound. */
const samples: WorkerSample[] = Array.from({ length: 30 }, (_, i) => ({
  at: Date.UTC(2026, 10, 5, 11, 37) + i * MIN,
  workers: i < 10 ? 1 : 2,
  target: 2,
  running: i < 10 ? 6 : 12,
  queued: 12,
  cpu: 0.5,
  memory: 0.4,
}));
const snapshots: LiveSnapshot[] = Array.from({ length: 60 }, (_, i) => ({
  at: Date.UTC(2026, 10, 5, 11, 37) + i * 30_000,
  scheduled: [],
  queued: [],
  pools: [{ name: 'default_pool', slots: 128, running: 12, queued: 4, open: 112 }],
  dagActive: {},
  executor: { running: 12, queued: 12 },
  workers: { current: 2, target: 2, source: 'monitoring' },
}));
const tryOf = (dagId: string, startAt: number, endAt: number | null): StoredTaskTry => ({
  envId: 'acme-prod',
  dagId,
  runId: 'scheduled__2026-11-05T10:00:00+00:00',
  taskId: 'load',
  mapIndex: -1,
  tryNumber: 1,
  pool: 'default_pool',
  poolSlots: 1,
  state: endAt === null ? 'running' : 'success',
  readyAt: null,
  queuedAt: startAt,
  startAt,
  endAt,
  sourceUpdatedAt: null,
  operator: 'PythonOperator',
});
const tries = [
  tryOf('acme_orders_daily', Date.UTC(2026, 10, 5, 10, 0), Date.UTC(2026, 10, 5, 11, 0)),
  tryOf('acme_billing_hourly', Date.UTC(2026, 10, 5, 11, 30), null),
];

function deps(over: { config?: EnvironmentConfig; samples?: WorkerSample[]; tries?: StoredTaskTry[] } = {}) {
  const store: TaskInstanceStore = {
    upsertTaskTries: async () => {},
    taskTries: async () => over.tries ?? tries,
    countTaskTries: async () => (over.tries ?? tries).length,
    historyStart: async () => ((over.tries ?? tries).length ? Date.UTC(2026, 10, 1) : null),
  };
  const model: EnvironmentModelSource = {
    config: async () => over.config ?? config,
    dags: async () => [] as DagMeta[],
    snapshots: async (_env, from, to) =>
      over.samples === undefined ? snapshots.filter((s) => s.at >= from && s.at < to) : [],
    workerSamples: async (_env, from, to) =>
      (over.samples ?? samples).filter((s) => s.at >= from && s.at < to),
    platformHealth: async () => {
      throw new Error('not read');
    },
  };
  return { store, model, clock: { now: () => NOW } };
}

describe('getCapacity (FR-ENV-02, FR-DAGX-06)', () => {
  it('FR-ENV-02: a 24 h range has 15-minute buckets from a UTC bucket boundary', async () => {
    const c = await getCapacity(deps(), {
      envId: 'acme-prod',
      range: '24h',
      sources: ['SRC-AF-API', 'SRC-MON'],
    });
    expect(c.range).toEqual({ from: '2026-11-04T12:00:00.000Z', to: '2026-11-05T12:07:30.000Z' });
    expect(c.bucket_seconds).toBe(900);
    expect(c.series).toHaveLength(97);
    expect(c.series[0]).toMatchObject({
      start: '2026-11-04T12:00:00.000Z',
      observed_minutes: 0,
      workers_mean: null,
    });
    expect(c.data_as_of).toBe('2026-11-05T12:06:00.000Z');
    expect(c.sources).toEqual(['SRC-AF-API', 'SRC-MON']);
    expect(c.slots_source).toBe('monitoring');
    const week = await getCapacity(deps(), { envId: 'acme-prod', range: '7d', sources: ['DEMO'] });
    expect(week.bucket_seconds).toBe(3600);
    expect(week.range.from).toBe('2026-10-29T12:00:00.000Z');
    expect(week.heatmap.cells[0]).toMatchObject({ date: '2026-10-29', hour: 12, observed_minutes: 0 });
    expect(week.heatmap.cells.at(-1)).toMatchObject({ date: '2026-11-05', hour: 12, observed_minutes: 7 });
  });

  it('FR-ENV-02 / HM-032: limits carry their provenance; an unknown limit has no value', async () => {
    const c = await getCapacity(deps(), { envId: 'acme-prod', range: '1h', sources: ['SRC-MON'] });
    expect(c.limits).toEqual({
      worker_concurrency: 6,
      worker_concurrency_source: 'override',
      min_workers: 1,
      max_workers: 2,
      worker_slots_at_max: 12,
      parallelism: null,
      parallelism_source: 'unknown',
      schedulers: 2,
      parallelism_total: null,
    });
  });

  it('FR-ENV-02: capacity-bound periods, summary, workloads and pools', async () => {
    const c = await getCapacity(deps(), { envId: 'acme-prod', range: '1h', sources: ['SRC-MON'] });
    expect(c.capacity_bound).toEqual({
      evaluated: true,
      not_evaluated_reason: null,
      min_queued: 10,
      queued_ratio: 0.2,
      period_count: 1,
      periods: [
        {
          start: '2026-11-05T11:47:00.000Z',
          end: '2026-11-05T12:07:00.000Z',
          minutes: 20,
          queued_peak: 12,
          workers: 2,
        },
      ],
    });
    expect(c.summary).toMatchObject({
      window_minutes: 61,
      observed_minutes: 30,
      minutes_at_max_workers: 20,
      capacity_bound_minutes: 20,
      running_peak: 12,
      queued_peak: 12,
    });
    expect(c.summary.coverage).toBeCloseTo(30 / 61, 9);
    expect(c.summary.capacity_bound_share).toBeCloseTo(20 / 30, 9);
    expect(c.scale_events).toMatchObject({ evaluated: true, up: 1, down: 0 });
    expect(c.workloads).toEqual([
      {
        workload: 'celery-worker',
        samples: 30,
        cpu: { p50: 0.5, p95: 0.5, max: 0.5, samples: 30, low_sample: false },
        memory: { p50: 0.4, p95: 0.4, max: 0.4, samples: 30, low_sample: false },
      },
    ]);
    expect(c.workloads_not_collected).toEqual(['scheduler', 'triggerer', 'dag-processor', 'web-server']);
    expect(c.pools).toEqual([
      {
        name: 'default_pool',
        slots: 128,
        running_slots_avg: 12,
        running_slots_peak: 12,
        queued_slots_avg: 4,
        starved_minutes: 0,
      },
    ]);
  });

  it('FR-DAGX-06: the DAG × hour-of-day load of the top DAGs comes with its method', async () => {
    const c = await getCapacity(deps(), { envId: 'acme-prod', range: '24h', sources: ['SRC-AF-API'] });
    expect(c.dag_load).toMatchObject({
      method: 'FR-DAGX-06/task-tries',
      time_zone: 'UTC',
      top: 20,
      dag_count: 2,
    });
    expect(c.dag_load.dags.map((d) => d.dag_id)).toEqual(['acme_orders_daily', 'acme_billing_hourly']);
    expect(c.dag_load.dags[0]?.hours[10]).toBe(1);
    expect(c.dag_load.dags[0]?.hours[13]).toBe(0);
  });

  it('NFR-DATA-03: without worker figures every value is null and the reasons say what is missing', async () => {
    const c = await getCapacity(deps({ samples: [], tries: [] }), {
      envId: 'acme-prod',
      range: '6h',
      sources: ['SRC-AF-API', 'SRC-MON'],
    });
    expect(c.data_as_of).toBeNull();
    expect(c.sources).toEqual([]);
    expect(c.summary).toMatchObject({
      observed_minutes: 0,
      capacity_bound_minutes: null,
      running_peak: null,
    });
    expect(c.capacity_bound.evaluated).toBe(false);
    expect(c.capacity_bound.not_evaluated_reason).toMatch(/worker/);
    expect(c.scale_events.evaluated).toBe(false);
    expect(c.scale_events.not_evaluated_reason).toMatch(/Cloud Monitoring/);
    expect(c.series.every((b) => b.running_tries_mean === null)).toBe(true);
    expect(c.pools[0]?.running_slots_avg).toBeNull();
  });

  it('HM-032: with worker_concurrency unknown the capacity-bound check is not evaluated', async () => {
    const unknown = {
      ...config,
      workerConcurrency: UNKNOWN_LIMIT,
      limitSources: { parallelism: 'unknown' as const, workerConcurrency: 'unknown' as const },
    };
    const c = await getCapacity(deps({ config: unknown }), {
      envId: 'acme-prod',
      range: '1h',
      sources: ['SRC-MON'],
    });
    expect(c.limits).toMatchObject({
      worker_concurrency: null,
      worker_slots_at_max: null,
      parallelism: null,
    });
    expect(c.capacity_bound).toMatchObject({ evaluated: false, periods: [] });
    expect(c.capacity_bound.not_evaluated_reason).toMatch(/worker_concurrency/);
    expect(c.summary.capacity_bound_minutes).toBeNull();
  });
});
