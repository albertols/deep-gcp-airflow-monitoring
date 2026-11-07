import { describe, expect, it } from 'vitest';
import type { DagMeta, EnvironmentConfig } from '@dcam/domain';
import type { EnvironmentModelSource, StoredTaskTry, TaskInstanceStore } from '@dcam/ports';
import { getDagDetail } from '../src/index';

const M = 60_000;
const H = 60 * M;
const D = 24 * H;
const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const runAt = (ms: number) => `scheduled__${iso(ms).replace('.000Z', '+00:00')}`;
/** A deterministic spread around 1: 0.9 … 1.13. */
const spread = (i: number) => 0.9 + ((((i * 7) % 24) + 24) % 24) / 100;

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
  readyAt: null,
  queuedAt: startAt - 5_000,
  startAt,
  endAt,
  operator: 'PythonOperator',
  sourceUpdatedAt: endAt ?? startAt,
  ...extra,
});

const meta = (dagId: string): DagMeta => ({
  dagId,
  fileloc: `/home/airflow/gcs/dags/ml-platform/${dagId}.py`,
  owners: ['ml-platform-oncall'],
  tags: ['hourly'],
  team: 'ml-platform',
  schedule: '0 * * * *',
  maxActiveTasks: 16,
  maxActiveRuns: 2,
  catchup: false,
  paused: false,
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
  pools: [{ name: 'default_pool', slots: 128 }],
};

const overlaps = (t: StoredTaskTry, from: number, to: number) =>
  t.startAt !== null && t.startAt < to && (t.endAt === null || t.endAt > from);

function storeOf(rows: readonly StoredTaskTry[], perDag = false) {
  const calls: string[] = [];
  const store: TaskInstanceStore = {
    upsertTaskTries: async () => {},
    countTaskTries: async () => rows.length,
    taskTries: async (_env, from, to) => {
      calls.push(`env ${iso(from)} ${iso(to)}`);
      return rows.filter((t) => overlaps(t, from, to));
    },
    ...(perDag
      ? {
          dagTaskTries: async (_env: string, dagId: string, from: number, to: number) => {
            calls.push(`dag ${dagId} ${iso(from)} ${iso(to)}`);
            return rows.filter((t) => t.dagId === dagId && overlaps(t, from, to));
          },
        }
      : {}),
  };
  return { store, calls };
}

const model: EnvironmentModelSource = {
  config: async (envId) => (envId === 'acme-prod' ? CONFIG : null),
  dags: async () => [meta('search_ranking_refresh'), meta('other')],
  snapshots: async () => [],
  workerSamples: async () => [],
  platformHealth: async () => {
    throw new Error('not used');
  },
};
const clock = { now: () => NOW };
const query = {
  envId: 'acme-prod',
  dagId: 'search_ranking_refresh',
  range: '24h' as const,
  sources: ['DEMO' as const],
};

/**
 * Hourly runs of extract → transform → load for the given hours before NOW (1 = the run an hour ago).
 * `transformSeconds` sets transform's duration per run.
 */
function hourly(hoursAgo: readonly number[], transformSeconds: (hoursAgo: number) => number) {
  const tries: StoredTaskTry[] = [];
  for (const h of hoursAgo) {
    const runId = runAt(NOW - h * H);
    let at = NOW - h * H + M;
    for (const [taskId, seconds] of [
      ['extract', 60 * spread(h)],
      ['transform', transformSeconds(h)],
      ['load', 60 * spread(h + 5)],
    ] as const) {
      const end = at + Math.round(seconds * 1000);
      tries.push(tryOf('search_ranking_refresh', runId, taskId, at, end));
      at = end + 10_000;
    }
  }
  return tries;
}
const week = Array.from({ length: 168 }, (_, i) => 168 - i);
// transform takes 5 min, then twice as long in the last 18 h.
const regressed = hourly(week, (h) => (h <= 18 ? 2 : 1) * 300 * spread(h));

describe('HM-016 / FR-TASK-01 duration against the 28-day baseline in DAG detail', () => {
  it('HM-016: reports the baseline window, the history it covers, and the margin', async () => {
    const result = await getDagDetail({ store: storeOf(regressed).store, model, clock }, query);
    if (result.kind !== 'ok') throw new Error(result.kind);
    expect(result.detail.baseline).toEqual({
      from: iso(NOW - D - 28 * D),
      to: iso(NOW - D),
      history_from: iso(NOW - 168 * H + M),
      coverage: (6 * D - M) / (28 * D),
      margin: 1.3,
    });
  });

  it('HM-016: flags the regressed task and the DAG run duration, with distributions now and in the baseline', async () => {
    const result = await getDagDetail({ store: storeOf(regressed).store, model, clock }, query);
    if (result.kind !== 'ok') throw new Error(result.kind);
    const { regression, tasks } = result.detail;
    expect(regression).toMatchObject({ status: 'regression' });
    expect(regression?.current.samples).toBe(24);
    expect(regression?.baseline.samples).toBe(144);
    const transform = tasks.find((t) => t.task_id === 'transform');
    expect(transform?.duration_regression).toMatchObject({ status: 'regression' });
    expect(transform?.duration_regression?.ratio).toBeGreaterThan(1.8);
    expect(transform?.duration_regression?.p_value).toBeLessThan(0.01);
    expect(transform?.duration_regression?.q_value).toBeLessThanOrEqual(0.05);
    expect(transform?.duration_regression?.current).toMatchObject({ samples: 24, low_sample: false });
    expect(transform?.duration_regression?.baseline.p50).toBeGreaterThan(250);
    expect(transform?.duration_regression?.baseline.p50).toBeLessThan(350);
    const extract = tasks.find((t) => t.task_id === 'extract');
    expect(extract?.duration_regression?.status).toBe('within_baseline');
  });

  it('HM-016: says the baseline is not available when DCAM has no history before the range', async () => {
    const recent = hourly(
      Array.from({ length: 20 }, (_, i) => 20 - i),
      () => 300,
    );
    const result = await getDagDetail({ store: storeOf(recent).store, model, clock }, query);
    if (result.kind !== 'ok') throw new Error(result.kind);
    expect(result.detail.baseline).toMatchObject({ coverage: 0, history_from: iso(NOW - 20 * H + M) });
    expect(result.detail.regression).toMatchObject({ status: 'no_baseline', ratio: null });
    expect(result.detail.tasks.every((t) => t.duration_regression?.status === 'no_baseline')).toBe(true);
  });

  it('HM-016: reads the baseline of this DAG only, where the store can', async () => {
    const other = tryOf('other', runAt(NOW - 100 * H), 'x', NOW - 100 * H, NOW - 100 * H + M);
    const { store, calls } = storeOf([...regressed, other], true);
    const result = await getDagDetail({ store, model, clock }, query);
    if (result.kind !== 'ok') throw new Error(result.kind);
    expect(calls.sort()).toEqual([
      `dag search_ranking_refresh ${iso(NOW - D - 28 * D)} ${iso(NOW - 2 * D)}`,
      `env ${iso(NOW - 2 * D)} ${iso(NOW)}`,
    ]);
    // A try overlapping both reads is counted once.
    expect(result.detail.regression?.baseline.samples).toBe(144);
  });
});

describe('HM-016 baseline coverage does not depend on the store', () => {
  // The environment's history starts 20 days ago with another DAG; this DAG was first seen 3 days ago.
  const firstSeen = hourly(
    Array.from({ length: 72 }, (_, i) => 72 - i),
    () => 300,
  );
  const older = tryOf('other', runAt(NOW - 20 * D), 'x', NOW - 20 * D, NOW - 20 * D + M);
  const rows = [...firstSeen, older];
  const historyStart = async () => NOW - 20 * D;

  it('HM-016: a DAG first seen 3 days ago is dated from the environment history, with either store', async () => {
    const coverage = async (store: TaskInstanceStore) => {
      const result = await getDagDetail({ store, model, clock }, query);
      if (result.kind !== 'ok') throw new Error(result.kind);
      return result.detail.baseline;
    };
    const fallback = await coverage(storeOf(rows).store);
    // The baseline is the 28 days before the range: [NOW − 29 D, NOW − D); history covers its last 19 days.
    expect(fallback).toMatchObject({ history_from: iso(NOW - 20 * D), coverage: 19 / 28 });
    // The DuckDB store: a per-DAG baseline read, and the environment's history start.
    expect(await coverage({ ...storeOf(rows, true).store, historyStart })).toEqual(fallback);
    expect(await coverage({ ...storeOf(rows).store, historyStart })).toEqual(fallback);
  });
});

describe('HM-015 failures, retries and flakiness in DAG detail', () => {
  it('HM-015: run and try outcomes for the DAG and per task, with counts and rates', async () => {
    const flaky = Array.from({ length: 24 }, (_, i) => {
      const h = 24 - i;
      const runId = runAt(NOW - h * H);
      const at = NOW - h * H + M;
      return i < 6
        ? [
            tryOf('search_ranking_refresh', runId, 'score', at, at + M, { state: 'failed' }),
            tryOf('search_ranking_refresh', runId, 'score', at + 3 * M, at + 4 * M, { tryNumber: 2 }),
          ]
        : [tryOf('search_ranking_refresh', runId, 'score', at, at + M)];
    }).flat();
    const result = await getDagDetail({ store: storeOf(flaky).store, model, clock }, query);
    if (result.kind !== 'ok') throw new Error(result.kind);
    expect(result.detail.reliability).toEqual({
      finished_runs: 24,
      failed_runs: 0,
      run_failure_rate: 0,
      run_recoveries: 0,
      run_unrecovered: 0,
      run_mttr_seconds: null,
      tasks: {
        tries: 30,
        failed_tries: 6,
        try_failure_rate: 6 / 30,
        task_instances: 24,
        retried: 6,
        retry_rate: 6 / 24,
        flaky: 6,
        flaky_inferred: 0,
        flaky_rate: 6 / 24,
        recoveries: 6,
        unrecovered: 0,
        mttr_seconds: 180,
      },
    });
    expect(result.detail.tasks[0]?.reliability).toEqual(result.detail.reliability?.tasks);
  });
});

describe('HM-007 critical path in DAG detail', () => {
  it('HM-007: the Gantt run has its critical path as Gantt row indexes, and each task how often it is on it', async () => {
    const result = await getDagDetail({ store: storeOf(regressed).store, model, clock }, query);
    if (result.kind !== 'ok') throw new Error(result.kind);
    const { gantt, tasks, runs } = result.detail;
    expect(gantt.run_id).toBe(runs.at(-1)?.run_id);
    expect(gantt.critical_path?.method).toBe('timing');
    expect(gantt.critical_path?.row_indexes.map((i) => gantt.rows[i]?.task_id)).toEqual([
      'extract',
      'transform',
      'load',
    ]);
    const run = runs.at(-1);
    expect(gantt.critical_path?.duration_seconds).toBeCloseTo(run?.duration_seconds as number, 6);
    for (const t of tasks) expect(t).toMatchObject({ critical_path_runs: 24, critical_path_share: 1 });
  });

  it('HM-007: a run still running has no critical path yet', async () => {
    const running = [
      ...regressed,
      tryOf('search_ranking_refresh', runAt(NOW - 10 * M), 'extract', NOW - 5 * M, null),
    ];
    const result = await getDagDetail(
      { store: storeOf(running).store, model, clock },
      { ...query, runId: runAt(NOW - 10 * M) },
    );
    if (result.kind !== 'ok') throw new Error(result.kind);
    expect(result.detail.gantt.critical_path).toBeNull();
  });
});
