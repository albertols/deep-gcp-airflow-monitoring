import { describe, expect, it } from 'vitest';
import type { DagMeta, EnvironmentConfig, LiveSnapshot } from '@dcam/domain';
import type { EnvironmentModelSource, StoredTaskTry, TaskInstanceStore } from '@dcam/ports';
import { getDagDetail, getDagLeague } from '../src/index';

const H = 3_600_000;
const M = 60_000;
const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const runAt = (ms: number) => `scheduled__${iso(ms).replace('.000Z', '+00:00')}`;

const tryOf = (
  dagId: string,
  runId: string,
  taskId: string,
  startAt: number,
  endAt: number | null,
  extra: Partial<StoredTaskTry> = {},
): StoredTaskTry => ({
  envId: 'acme-prod',
  dagId,
  runId,
  taskId,
  mapIndex: -1,
  tryNumber: 1,
  pool: 'default_pool',
  poolSlots: 1,
  state: endAt === null ? 'running' : 'success',
  readyAt: startAt - 2 * M,
  queuedAt: startAt - M,
  startAt,
  endAt,
  operator: 'PythonOperator',
  sourceUpdatedAt: endAt ?? startAt,
  ...extra,
});

const dag = (dagId: string, team: string, extra: Partial<DagMeta> = {}): DagMeta => ({
  dagId,
  fileloc: `/home/airflow/gcs/dags/${team}/${dagId}.py`,
  owners: [`${team}-oncall`],
  tags: [team, 'hourly'],
  team,
  schedule: '0 * * * *',
  maxActiveTasks: 4,
  maxActiveRuns: 2,
  catchup: false,
  paused: false,
  ...extra,
});

const CONFIG: EnvironmentConfig = {
  envId: 'acme-prod',
  tier: 'prod',
  composerImage: 'composer-3-airflow-2.11.1-build.22',
  airflowVersion: '2.11.1',
  parallelism: 96,
  schedulers: 2,
  maxActiveTasksPerDag: 16,
  maxActiveRunsPerDag: 25,
  workerConcurrency: 12,
  minWorkers: 2,
  maxWorkers: 6,
  pools: [
    { name: 'default_pool', slots: 128 },
    { name: 'etl', slots: 24 },
  ],
};

function storeOf(rows: StoredTaskTry[]) {
  const calls: Array<[number, number]> = [];
  const store: TaskInstanceStore = {
    upsertTaskTries: async () => {},
    countTaskTries: async () => rows.length,
    taskTries: async (_env, from, to) => {
      calls.push([from, to]);
      return rows.filter((t) => t.startAt !== null && t.startAt < to && (t.endAt === null || t.endAt > from));
    },
  };
  return { store, calls };
}

function modelOf(dags: DagMeta[], snapshots: LiveSnapshot[] = []): EnvironmentModelSource {
  return {
    config: async (envId) => (envId === 'acme-prod' ? CONFIG : null),
    dags: async () => dags,
    snapshots: async (_env, from, to) => snapshots.filter((s) => s.at >= from && s.at < to),
    workerSamples: async () => [],
    platformHealth: async () => {
      throw new Error('not used');
    },
  };
}

const snapshotAt = (at: number, dagActive: Record<string, number>, ready: StoredTaskTry[]): LiveSnapshot => ({
  at,
  scheduled: ready.map((t) => ({
    dagId: t.dagId,
    runId: t.runId,
    taskId: t.taskId,
    mapIndex: t.mapIndex,
    tryNumber: t.tryNumber,
    pool: t.pool,
    poolSlots: t.poolSlots,
    priorityWeight: 1,
    since: at - M,
  })),
  queued: [],
  pools: [],
  dagActive,
  executor: { running: 0, queued: 0 },
  workers: { current: 2, target: 2 },
});

const clock = { now: () => NOW };

describe('FR-DAGX-01..03 DAG league use case', () => {
  const rows = [
    tryOf('heavy', runAt(NOW - 3 * H), 'a', NOW - 3 * H, NOW - H), // 2 h
    tryOf('heavy', runAt(NOW - 3 * H), 'b', NOW - 2 * H, NOW - H), // 1 h
    tryOf('light', runAt(NOW - 2 * H), 'a', NOW - 2 * H, NOW - H), // 1 h
    tryOf('heavy', runAt(NOW - 30 * H), 'a', NOW - 30 * H, NOW - 29 * H), // previous period
  ];

  it('FR-DAGX-02: lists every known DAG with metadata, shares, the previous period and Pareto/Gini', async () => {
    const { store, calls } = storeOf(rows);
    const model = modelOf([
      dag('heavy', 'finance-data'),
      dag('light', 'customer'),
      dag('idle', 'ml', { paused: true }),
    ]);
    const league = await getDagLeague(
      { store, model, clock },
      { envId: 'acme-prod', range: '24h', sources: ['DEMO'], openFindings: new Map([['heavy', 2]]) },
    );
    expect(calls).toEqual([[NOW - 48 * H, NOW]]);
    expect(league).toMatchObject({
      env_id: 'acme-prod',
      range: { from: iso(NOW - 24 * H), to: iso(NOW) },
      previous_range: { from: iso(NOW - 48 * H), to: iso(NOW - 24 * H) },
      data_as_of: iso(NOW),
      sources: ['DEMO'],
      total_executor_slot_seconds: 4 * 3600,
      dag_count: 3,
      active_dag_count: 2,
      pareto_80_dag_count: 2,
    });
    expect(league.gini).toBeCloseTo(0.25, 12); // [3 h, 1 h]
    expect(league.rows.map((r) => r.dag_id)).toEqual(['heavy', 'light', 'idle']);
    expect(league.rows[0]).toMatchObject({
      team: 'finance-data',
      owners: ['finance-data-oncall'],
      tags: ['finance-data', 'hourly'],
      schedule: '0 * * * *',
      paused: false,
      runs: 1,
      failed_runs: 0,
      success_rate: 1,
      tries: 2,
      retries: 0,
      flaky_rate: null,
      executor_slot_seconds: 3 * 3600,
      share: 0.75,
      cumulative_share: 0.75,
      previous_share: 1,
      peak_concurrency: 2,
      open_findings: 2,
    });
    expect(league.rows[0]?.run_duration_p95).toEqual({
      value_seconds: 2 * 3600,
      samples: 1,
      low_sample: true,
    });
    expect(league.rows[0]?.queue_wait_p95).toEqual({ value_seconds: 60, samples: 2, low_sample: true });
    expect(league.rows[2]).toMatchObject({
      dag_id: 'idle',
      paused: true,
      runs: 0,
      share: 0,
      open_findings: 0,
    });
  });

  it('FR-DAGX-02: a run with work waiting in the latest live snapshot is still running', async () => {
    const { store } = storeOf(rows);
    const waiting = tryOf('light', runAt(NOW - 2 * H), 'b', NOW, null);
    const model = modelOf([dag('light', 'customer')], [snapshotAt(NOW - 10_000, {}, [waiting])]);
    const league = await getDagLeague(
      { store, model, clock },
      { envId: 'acme-prod', range: '24h', sources: [] },
    );
    expect(league.rows.find((r) => r.dag_id === 'light')).toMatchObject({ runs: 1, success_rate: null });
  });
});

describe('FR-DAGD-01..04 DAG detail use case', () => {
  const r1 = runAt(NOW - 3 * H);
  const r2 = runAt(NOW - 2 * H);
  const rows = [
    tryOf('etl_daily', r1, 'extract', NOW - 3 * H + M, NOW - 3 * H + 11 * M, { pool: 'etl', poolSlots: 2 }),
    tryOf('etl_daily', r1, 'load', NOW - 3 * H + 12 * M, NOW - 3 * H + 42 * M),
    tryOf('etl_daily', r2, 'extract', NOW - 2 * H + 2 * M, NOW - 2 * H + 12 * M, {
      pool: 'etl',
      poolSlots: 2,
    }),
    tryOf('other', runAt(NOW - H), 'x', NOW - H, NOW - H + 50 * M),
  ];
  const deps = (snapshots: LiveSnapshot[] = []) => ({
    store: storeOf(rows).store,
    model: modelOf([dag('etl_daily', 'finance-data'), dag('other', 'customer')], snapshots),
    clock,
  });
  const query = { envId: 'acme-prod', dagId: 'etl_daily', range: '24h' as const, sources: ['DEMO' as const] };

  it('FR-DAGD-01: header metadata and every limit that can throttle the DAG', async () => {
    const result = await getDagDetail(deps(), query);
    if (result.kind !== 'ok') throw new Error(result.kind);
    expect(result.detail.meta).toEqual({
      fileloc: '/home/airflow/gcs/dags/finance-data/etl_daily.py',
      owners: ['finance-data-oncall'],
      tags: ['finance-data', 'hourly'],
      team: 'finance-data',
      schedule: '0 * * * *',
      paused: false,
      catchup: false,
      limits: {
        max_active_tasks: 4,
        max_active_runs: 2,
        pools: [
          { name: 'default_pool', slots: 128, pool_slots: 1 },
          { name: 'etl', slots: 24, pool_slots: 2 },
        ],
        parallelism: 192,
        worker_slots: 72,
      },
    });
    expect(result.detail.findings).toEqual([]);
  });

  it('FR-DAGD-02 / HM-005: KPIs, runs with start delay, and the self-throttled ratio', async () => {
    const atLimit = tryOf('etl_daily', r2, 'load', NOW, null);
    const snapshots = [
      snapshotAt(NOW - 3 * M, { etl_daily: 4 }, [atLimit]),
      snapshotAt(NOW - 2 * M, { etl_daily: 1 }, []),
    ];
    const result = await getDagDetail(deps(snapshots), query);
    if (result.kind !== 'ok') throw new Error(result.kind);
    const { stats, runs } = result.detail;
    expect(stats).toMatchObject({ runs: 2, success_rate: 1, executor_slot_seconds: 50 * 60 });
    expect(stats.share).toBeCloseTo(50 / 100, 12);
    expect(stats.self_throttled_ratio).toBe(0.5);
    expect(runs).toEqual([
      {
        run_id: r1,
        state: 'success',
        logical_date: iso(NOW - 3 * H),
        start: iso(NOW - 3 * H + M),
        end: iso(NOW - 3 * H + 42 * M),
        duration_seconds: 41 * 60,
        start_delay_seconds: 60,
        tries: 2,
      },
      {
        run_id: r2,
        state: 'success',
        logical_date: iso(NOW - 2 * H),
        start: iso(NOW - 2 * H + 2 * M),
        end: iso(NOW - 2 * H + 12 * M),
        duration_seconds: 10 * 60,
        start_delay_seconds: 120,
        tries: 1,
      },
    ]);
  });

  it('FR-DAGD-03: the Gantt shows the latest run by default, or the requested run', async () => {
    const latest = await getDagDetail(deps(), query);
    if (latest.kind !== 'ok') throw new Error(latest.kind);
    expect(latest.detail.gantt.run_id).toBe(r2);
    expect(latest.detail.gantt.rows).toEqual([
      {
        task_id: 'extract',
        try_number: 1,
        state: 'success',
        ready_at: iso(NOW - 2 * H),
        queued_at: iso(NOW - 2 * H + M),
        start: iso(NOW - 2 * H + 2 * M),
        end: iso(NOW - 2 * H + 12 * M),
      },
    ]);
    const first = await getDagDetail(deps(), { ...query, runId: r1 });
    if (first.kind !== 'ok') throw new Error(first.kind);
    expect(first.detail.gantt.rows.map((r) => r.task_id)).toEqual(['extract', 'load']);
    expect((await getDagDetail(deps(), { ...query, runId: 'nope' })).kind).toBe('unknown-run');
  });

  it('FR-DAGD-04: per-task statistics sorted by contribution to run duration', async () => {
    const result = await getDagDetail(deps(), query);
    if (result.kind !== 'ok') throw new Error(result.kind);
    // load: 30 min in one of two runs = 15 min per run; extract: 10 min in each run.
    expect(result.detail.tasks.map((t) => t.task_id)).toEqual(['load', 'extract']);
    const [load, extract] = result.detail.tasks;
    expect(load).toMatchObject({ tries: 1, contribution_seconds: 15 * 60 });
    expect(load?.slot_seconds_share).toBeCloseTo(30 / 50, 12);
    expect(extract).toMatchObject({
      tries: 2,
      retries: 0,
      failure_rate: null,
      contribution_seconds: 10 * 60,
      duration_p50: { value_seconds: 600, samples: 2, low_sample: false },
      queue_wait_p95: { value_seconds: 60, samples: 2, low_sample: true },
    });
    expect(extract?.slot_seconds_share).toBeCloseTo(20 / 50, 12);
  });

  it('FR-DAGD-01: unknown DAGs are reported, not invented', async () => {
    expect((await getDagDetail(deps(), { ...query, dagId: 'missing' })).kind).toBe('unknown-dag');
  });
});
