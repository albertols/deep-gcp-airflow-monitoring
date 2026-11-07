import { describe, expect, it } from 'vitest';
import {
  UNKNOWN_LIMIT,
  type EnvironmentConfig,
  type LiveSnapshot,
  type SnapshotTaskInstance,
  type WorkerSample,
} from '@dcam/domain';
import type { EnvironmentModelSource, StoredTaskTry, TaskInstanceStore } from '@dcam/ports';
import { bottlenecksInWindow, getBottlenecks } from '../src/index';

const SEC = 1_000;
const MIN = 60 * SEC;
const H = 60 * MIN;
/** A Monday 06:00 UTC: the 6 h range starts at midnight. */
const NOW = Date.UTC(2026, 10, 2, 6, 0, 0);
const FROM = NOW - 6 * H;

const config: EnvironmentConfig = {
  envId: 'acme-prod',
  tier: 'prod',
  composerImage: 'composer-3-airflow-2.11.1-build.22',
  airflowVersion: '2.11.1',
  parallelism: 100,
  schedulers: 1,
  maxActiveTasksPerDag: 16,
  maxActiveRunsPerDag: 25,
  workerConcurrency: 10,
  minWorkers: 1,
  maxWorkers: 1,
  pools: [
    { name: 'default_pool', slots: 128 },
    { name: 'external_api', slots: 1 },
  ],
};

const ti = (dagId: string, pool: string, priorityWeight: number, taskId = 't'): SnapshotTaskInstance => ({
  dagId,
  runId: 'r',
  taskId,
  mapIndex: -1,
  tryNumber: 1,
  pool,
  poolSlots: 1,
  priorityWeight,
  since: FROM - 10 * MIN,
});

/** Every minute for 6 h: two partner DAGs wait on the full external_api pool, one task is queued. */
const snapshots: LiveSnapshot[] = Array.from({ length: 6 * 60 }, (_, i) => ({
  at: FROM + i * MIN,
  scheduled: [ti('partner_crm_sync', 'external_api', 3, 'fetch'), ti('partner_tax_sync', 'external_api', 1)],
  queued: [ti('orders_daily', 'default_pool', 1)],
  pools: [
    { name: 'default_pool', slots: 128, running: 9, queued: 1, open: 118 },
    { name: 'external_api', slots: 1, running: 1, queued: 0, open: 0 },
  ],
  dagActive: {},
  executor: { running: 10, queued: 1 },
  workers: { current: 1, target: 1 },
}));
const samples: WorkerSample[] = Array.from({ length: 6 * 60 }, (_, i) => ({
  at: FROM + i * MIN,
  workers: 1,
  target: 1,
  running: 10,
  queued: 1,
  cpu: 0.3,
  memory: 0.4,
}));

const tryOf = (
  dagId: string,
  runId: string,
  queuedAt: number,
  waitMs: number,
  runMs: number,
): StoredTaskTry => ({
  envId: 'acme-prod',
  dagId,
  runId,
  taskId: 't',
  mapIndex: -1,
  tryNumber: 1,
  pool: 'default_pool',
  poolSlots: 1,
  state: 'success',
  readyAt: null,
  queuedAt,
  startAt: queuedAt + waitMs,
  endAt: queuedAt + waitMs + runMs,
  sourceUpdatedAt: null,
  operator: 'PythonOperator',
});
/**
 * `acme_hog` runs for minutes 0–29 of every hour (1 of 10 slots); two small DAGs queue a try every minute
 * and wait 300 s while hog runs, 60 s otherwise.
 */
const tries: StoredTaskTry[] = [
  ...Array.from({ length: 6 }, (_, h) => tryOf('acme_hog', `h${h}`, FROM + h * H, 0, 30 * MIN)),
  ...Array.from({ length: 6 * 60 }, (_, m) =>
    ['acme_small_a', 'acme_small_b'].map((dag) =>
      tryOf(dag, `m${m}`, FROM + m * MIN, (m % 60 < 30 ? 300 : 60) * SEC, SEC),
    ),
  ).flat(),
];

const store: TaskInstanceStore = {
  upsertTaskTries: async () => {},
  taskTries: async () => tries,
  countTaskTries: async () => tries.length,
};
const modelWith = (c: EnvironmentConfig): EnvironmentModelSource => ({
  config: async (id) => (id === 'acme-prod' ? c : null),
  dags: async () => [],
  snapshots: async (_id, from, to) => snapshots.filter((s) => s.at >= from && s.at < to),
  workerSamples: async (_id, from, to) => samples.filter((s) => s.at >= from && s.at < to),
  platformHealth: async () => ({
    envHealthyRatio: null,
    dbHealthyRatio: null,
    heartbeatCompleteness: null,
    webServerHealthyRatio: null,
    dbCpuMemoryMax: null,
    zombies24h: null,
    workerRestarts24h: null,
    importErrors: null,
    parseLoopP95Seconds: null,
  }),
});
const deps = { store, model: modelWith(config), clock: { now: () => NOW } };
const query = { envId: 'acme-prod', range: '6h' as const, sources: ['DEMO' as const] };

describe('getBottlenecks in depth (FR-BOTL-01, FR-BOTL-06, FR-ENV-08, HM-023)', () => {
  it('FR-BOTL-01: each reason lists the pools that waited most, with their share of the reason', async () => {
    const b = await getBottlenecks(deps, query);
    const pool = b.reasons.find((r) => r.id === 'pool-exhausted');
    expect(pool?.top_pools).toEqual([{ pool: 'external_api', waiting_task_seconds: 2 * 6 * 3600, share: 1 }]);
    const slots = b.reasons.find((r) => r.id === 'executor-slots-exhausted');
    expect(slots?.top_pools?.[0]).toMatchObject({ pool: 'default_pool', share: 1 });
  });

  it('FR-ENV-08: pools carry running and queued slots, ready and queued waiting, top DAGs and starvation over time', async () => {
    const b = await getBottlenecks(deps, query);
    const api = b.pools.find((p) => p.name === 'external_api');
    expect(api).toMatchObject({
      running_slots_avg: 1,
      running_slots_peak: 1,
      queued_slots_avg: 0,
      ready_task_seconds: 2 * 6 * 3600,
      queued_task_seconds: 0,
      starved_minutes: 6 * 60,
    });
    expect(api?.top_dags?.map((d) => [d.dag_id, d.share])).toEqual([
      ['partner_crm_sync', 0.5],
      ['partner_tax_sync', 0.5],
    ]);
    expect(api?.starved_series).toHaveLength(b.series.length);
    expect(api?.starved_series?.[0]).toBe(5);
  });

  it('HM-017: names the DAG associated with longer queue waits, with effect, interval and evidence', async () => {
    const b = await getBottlenecks(deps, query);
    const n = b.noisy_neighbours;
    expect(n).toMatchObject({
      method: 'HM-017/range',
      evaluated: true,
      not_evaluated_reason: null,
      active_share: 0.1,
      min_active_minutes: 60,
      min_affected_tries: 200,
      min_control_tries: 200,
      min_affected_minutes: 30,
      resamples: 1_000,
    });
    const hog = n?.items[0];
    expect(hog).toMatchObject({
      dag_id: 'acme_hog',
      active_minutes: 180,
      affected_tries: 360,
      affected_minutes: 180,
      control_tries: 360,
      median_wait_active_seconds: 300,
      median_wait_inactive_seconds: 60,
      effect_seconds: 240,
      confidence: 'high',
      associated_wait_task_minutes: (240 * 360) / 60,
    });
    expect(hog?.ci_low_seconds).toBeGreaterThan(0);
    expect(hog?.overlap_windows[0]).toEqual({
      from: new Date(FROM).toISOString(),
      to: new Date(FROM + 30 * MIN).toISOString(),
    });
  });

  it('HM-032: without worker_concurrency the noisy-neighbour comparison is not evaluated, and says why', async () => {
    const unknown = {
      ...config,
      workerConcurrency: UNKNOWN_LIMIT,
      limitSources: { workerConcurrency: 'unknown' as const },
    };
    const b = await getBottlenecks({ ...deps, model: modelWith(unknown) }, query);
    expect(b.noisy_neighbours?.evaluated).toBe(false);
    expect(b.noisy_neighbours?.items).toEqual([]);
    expect(b.noisy_neighbours?.not_evaluated_reason).toMatch(/worker_concurrency/);
  });

  it('HM-023: priority bands per pool with observed waits; the starvation ratio is not evaluated, with the reason', async () => {
    const b = await getBottlenecks(deps, query);
    const p = b.priority_fairness;
    expect(p?.starvation_ratio_evaluated).toBe(false);
    expect(p?.not_evaluated_reason).toMatch(/28-day/);
    const api = p?.pools.find((x) => x.pool === 'external_api');
    expect(api?.distinct_weights).toBe(2);
    expect(api?.bands.map((x) => [x.band, x.tries, x.p95_low_sample])).toEqual([
      ['low', 1, true],
      ['high', 1, true],
    ]);
    expect(api?.bands[0]?.wait_p50_seconds).toBe(6 * 3600 - 60 + 600);
  });

  it('FR-BOTL-01: the analysis runs over an explicit window, as the range does', async () => {
    const viaRange = await getBottlenecks(deps, query);
    const viaWindow = await bottlenecksInWindow(deps, {
      envId: 'acme-prod',
      from: FROM,
      to: NOW,
      bucketMs: 5 * MIN,
      sources: ['DEMO'],
    });
    expect(viaWindow).toEqual(viaRange);
  });
});
