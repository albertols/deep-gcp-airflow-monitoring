import { describe, expect, it } from 'vitest';
import { environmentLoad, type DagMeta, type EnvironmentConfig } from '@dcam/domain';
import type { EnvironmentModelSource, StoredTaskTry, TaskInstanceStore } from '@dcam/ports';
import { getDagComparison, getRunComparison } from '../src/index';

const M = 60_000;
const H = 60 * M;
const D = 24 * H;
const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const runAt = (ms: number) => `scheduled__${iso(ms).replace('.000Z', '+00:00')}`;

const tryOf = (
  envId: string,
  dagId: string,
  runId: string,
  taskId: string,
  startAt: number,
  endAt: number | null,
  extra: Partial<StoredTaskTry> = {},
): StoredTaskTry => ({
  envId,
  dagId,
  runId,
  taskId,
  mapIndex: -1,
  tryNumber: 1,
  pool: 'default_pool',
  poolSlots: 1,
  state: endAt === null ? 'running' : 'success',
  readyAt: null,
  queuedAt: startAt - 30_000,
  startAt,
  endAt,
  operator: 'PythonOperator',
  sourceUpdatedAt: endAt ?? startAt,
  ...extra,
});

const meta = (dagId: string, maxActiveTasks = 16): DagMeta => ({
  dagId,
  fileloc: `/home/airflow/gcs/dags/${dagId}.py`,
  owners: ['finance-data-oncall'],
  tags: [],
  team: 'finance-data',
  schedule: '0 * * * *',
  maxActiveTasks,
  maxActiveRuns: 2,
  catchup: false,
  paused: false,
});

const config = (
  envId: string,
  tier: EnvironmentConfig['tier'],
  workerConcurrency: number,
): EnvironmentConfig => ({
  envId,
  tier,
  composerImage: 'composer-3-airflow-2.11.1-build.22',
  airflowVersion: '2.11.1',
  parallelism: 96,
  schedulers: 2,
  maxActiveTasksPerDag: 16,
  maxActiveRunsPerDag: 25,
  workerConcurrency,
  minWorkers: 1,
  maxWorkers: 4,
  pools: [
    { name: 'default_pool', slots: 128 },
    { name: 'etl', slots: 16 },
  ],
});
const CONFIGS = new Map([
  ['acme-prod', config('acme-prod', 'prod', 12)],
  ['acme-test', config('acme-test', 'test', 8)],
]);

/**
 * Two days of hourly runs. In acme-prod orders_daily runs 10 minutes in the etl pool (two slots), and acme_big
 * runs 30 minutes every hour; in acme-test orders_daily runs 20 minutes. One run of acme-prod's orders_daily, 3 h
 * ago, took 25 minutes because its load task waited and ran longer.
 */
function history(): StoredTaskTry[] {
  const rows: StoredTaskTry[] = [];
  for (let at = NOW - 2 * D; at < NOW - H; at += H) {
    const slow = at === NOW - 3 * H;
    rows.push(
      tryOf('acme-prod', 'orders_daily', runAt(at), 'extract', at + M, at + 6 * M, {
        pool: 'etl',
        poolSlots: 2,
      }),
      tryOf(
        'acme-prod',
        'orders_daily',
        runAt(at),
        'load',
        at + (slow ? 9 : 6) * M,
        at + (slow ? 26 : 11) * M,
        {
          queuedAt: at + 6 * M,
        },
      ),
      tryOf('acme-prod', 'acme_big', runAt(at), 'crunch', at, at + 30 * M),
      tryOf('acme-test', 'orders_daily', runAt(at), 'extract', at + M, at + 21 * M),
    );
  }
  return rows;
}

function deps(rows: StoredTaskTry[], aggregate: boolean, historyStart = aggregate) {
  const calls: string[] = [];
  const of = (envId: string, from: number, to: number) =>
    rows.filter(
      (t) =>
        t.envId === envId && t.startAt !== null && t.startAt < to && (t.endAt === null || t.endAt > from),
    );
  const store: TaskInstanceStore = {
    upsertTaskTries: async () => {},
    countTaskTries: async () => rows.length,
    taskTries: async (envId, from, to) => {
      calls.push(`taskTries:${envId}`);
      return of(envId, from, to);
    },
    dagTaskTries: async (envId, dagId, from, to) => {
      calls.push(`dagTaskTries:${envId}:${dagId}`);
      return of(envId, from, to).filter((t) => t.dagId === dagId);
    },
    ...(historyStart
      ? {
          historyStart: async (envId: string) =>
            Math.min(...rows.filter((t) => t.envId === envId).map((t) => t.startAt as number)),
        }
      : {}),
    ...(aggregate
      ? {
          environmentLoad: async (envId: string, from: number, to: number, now: number, bucketMs: number) => {
            calls.push(`environmentLoad:${envId}`);
            return environmentLoad(
              of(envId, from, to),
              { from, to, now },
              bucketMs,
              Math.floor(from / bucketMs) * bucketMs,
            );
          },
        }
      : {}),
  };
  const model: EnvironmentModelSource = {
    config: async (envId) => CONFIGS.get(envId) ?? null,
    dags: async (envId) =>
      envId === 'acme-prod' ? [meta('orders_daily'), meta('acme_big', 4)] : [meta('orders_daily')],
    snapshots: async () => [],
    workerSamples: async () => [],
    platformHealth: async () => {
      throw new Error('not used');
    },
  };
  return { deps: { store, model, clock: { now: () => NOW } }, calls };
}

const PROD_ORDERS = { envId: 'acme-prod', dagId: 'orders_daily' };
const items = [
  PROD_ORDERS,
  { envId: 'acme-test', dagId: 'orders_daily' },
  { envId: 'acme-prod', dagId: 'acme_big' },
];

describe('FR-DAGD-08 compare DAGs', () => {
  it('FR-DAGD-08: aligned KPIs, shared duration bins, UTC hourly profiles and resource shares, in request order', async () => {
    const { deps: d } = deps(history(), true);
    const r = await getDagComparison(d, { items, range: '24h', sources: ['DEMO'] });
    if (r.kind !== 'ok') throw new Error(r.kind);
    const c = r.comparison;
    expect(c).toMatchObject({
      time_zone: 'UTC',
      range: { from: iso(NOW - D), to: iso(NOW) },
      sources: ['DEMO'],
    });
    expect(c.dags.map((x) => `${x.env_id}:${x.dag_id}`)).toEqual([
      'acme-prod:orders_daily',
      'acme-test:orders_daily',
      'acme-prod:acme_big',
    ]);
    const [prod, test, big] = c.dags;
    expect(prod?.kpis).toMatchObject({ runs: 23, finished_runs: 23, success_rate: 1 });
    expect(test?.kpis.run_duration_p50.value_seconds).toBe(20 * 60);
    // Bins shared by all three: 10 to 30 minutes; every successful run is counted once.
    const bins = c.duration_bins_seconds;
    expect(bins[0]).toBe(10 * 60);
    expect(bins.at(-1)).toBe(30 * 60);
    for (const x of c.dags) {
      expect(x.duration_histogram).toHaveLength(bins.length - 1);
      expect(x.duration_histogram.reduce((a, b) => a + b, 0)).toBe(x.duration.samples);
      expect(x.hourly_profile).toHaveLength(24);
    }
    // acme_big runs 30 minutes of every hour: 0.5 slots on average, a share of 30 ÷ (30 + 5 + 5) minutes.
    expect(big?.hourly_profile[3]).toMatchObject({ hour: 3, covered_hours: 1, running_avg: 0.5 });
    expect(big?.hourly_profile[3]?.share).toBeCloseTo(30 / 40, 9);
    const prodTotal = c.environments.find((e) => e.env_id === 'acme-prod')?.executor_slot_seconds ?? NaN;
    expect(big?.resources.share).toBeCloseTo((big?.resources.executor_slot_seconds ?? NaN) / prodTotal, 9);
    expect(prod?.resources.pools).toEqual([
      { pool: 'default_pool', pool_slot_seconds: expect.any(Number), share: expect.any(Number) },
      { pool: 'etl', pool_slot_seconds: 23 * 5 * 60 * 2, share: 1 },
    ]);
  });

  it("FR-DAGD-08: each environment's capacity context", async () => {
    const { deps: d } = deps(history(), true);
    const r = await getDagComparison(d, { items, range: '24h', sources: ['DEMO'] });
    if (r.kind !== 'ok') throw new Error(r.kind);
    expect(r.comparison.environments.map((e) => e.env_id)).toEqual(['acme-prod', 'acme-test']);
    expect(r.comparison.environments[1]).toMatchObject({
      tier: 'test',
      airflow_version: '2.11.1',
      worker_slots: 32,
      worker_concurrency: 8,
      min_workers: 1,
      max_workers: 4,
      parallelism: 192,
      max_active_tasks_per_dag: 16,
      pools: [
        { name: 'default_pool', slots: 128 },
        { name: 'etl', slots: 16 },
      ],
      coverage: 1,
    });
    const test = r.comparison.environments[1];
    expect(test?.utilisation).toBeCloseTo((test?.executor_slot_seconds ?? 0) / (32 * 24 * 3600), 9);
  });

  it("NFR-PERF: one DAG's tries and each environment's aggregate are read, never every try, and the answer is the same", async () => {
    const withAggregate = deps(history(), true);
    const fallback = deps(history(), false, true);
    const a = await getDagComparison(withAggregate.deps, { items, range: '24h', sources: ['DEMO'] });
    const b = await getDagComparison(fallback.deps, { items, range: '24h', sources: ['DEMO'] });
    expect(withAggregate.calls.some((c) => c.startsWith('taskTries'))).toBe(false);
    expect(withAggregate.calls.filter((c) => c.startsWith('environmentLoad'))).toHaveLength(2);
    expect(fallback.calls.filter((c) => c.startsWith('taskTries'))).toHaveLength(2);
    expect(a).toEqual(b);
  });

  it('NFR-DATA-03: over 7 days with 2 days of history, coverage says so and uncovered hours are not zero', async () => {
    const { deps: d } = deps(history(), true);
    const r = await getDagComparison(d, { items, range: '7d', sources: ['DEMO'] });
    if (r.kind !== 'ok') throw new Error(r.kind);
    expect(r.comparison.environments[0]?.coverage).toBeCloseTo(2 / 7, 6);
    expect(r.comparison.dags[2]?.hourly_profile[3]?.covered_hours).toBe(2);
  });

  it('FR-DAGD-08: unknown environments and DAGs are reported, not invented', async () => {
    const { deps: d } = deps(history(), true);
    expect(
      await getDagComparison(d, {
        items: [PROD_ORDERS, { envId: 'acme-nope', dagId: 'x' }],
        range: '24h',
        sources: ['DEMO'],
      }),
    ).toEqual({ kind: 'unknown-environment', envId: 'acme-nope' });
    expect(
      await getDagComparison(d, {
        items: [PROD_ORDERS, { envId: 'acme-test', dagId: 'acme_big' }],
        range: '24h',
        sources: ['DEMO'],
      }),
    ).toEqual({ kind: 'unknown-dag', envId: 'acme-test', dagId: 'acme_big' });
  });
});

describe('FR-DAGD-09 compare two runs', () => {
  const a = runAt(NOW - 4 * H);
  const b = runAt(NOW - 3 * H);
  const q = {
    envId: 'acme-prod',
    dagId: 'orders_daily',
    a,
    b,
    range: '7d' as const,
    sources: ['DEMO' as const],
  };

  it('FR-DAGD-09: per-task deltas, ranked by contribution to the run duration difference', async () => {
    const { deps: d, calls } = deps(history(), true);
    const r = await getRunComparison(d, q);
    if (r.kind !== 'ok') throw new Error(r.kind);
    const c = r.comparison;
    expect(c).toMatchObject({
      env_id: 'acme-prod',
      dag_id: 'orders_daily',
      method: 'HM-007/timing',
      ranking: 'critical_path',
      duration_delta_seconds: 15 * 60,
      explained_seconds: 15 * 60,
    });
    expect(c.a).toMatchObject({
      run_id: a,
      state: 'success',
      duration_seconds: 10 * 60,
      critical_path_seconds: 600,
    });
    expect(c.b).toMatchObject({ run_id: b, duration_seconds: 25 * 60 });
    expect(c.tasks.map((t) => t.task_id)).toEqual(['load', 'extract']);
    expect(c.tasks[0]).toMatchObject({
      duration_delta_seconds: 12 * 60,
      queue_wait_delta_seconds: 3 * 60,
      contribution_seconds: 15 * 60,
    });
    expect(c.tasks[0]?.b).toMatchObject({ on_critical_path: true, map_indexes: 1, map_index: -1, tries: 1 });
    expect(calls).toEqual(['dagTaskTries:acme-prod:orders_daily']);
  });

  it('FR-DAGD-09: a run outside the range or unknown is reported with which one', async () => {
    const { deps: d } = deps(history(), true);
    expect(await getRunComparison(d, { ...q, b: 'manual__nope' })).toEqual({
      kind: 'unknown-run',
      runId: 'manual__nope',
    });
    expect(await getRunComparison(d, { ...q, range: '1h' })).toEqual({ kind: 'unknown-run', runId: a });
    expect(await getRunComparison(d, { ...q, dagId: 'nope' })).toEqual({ kind: 'unknown-dag' });
    expect(await getRunComparison(d, { ...q, envId: 'acme-nope' })).toEqual({ kind: 'unknown-environment' });
  });
});
