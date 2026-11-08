import { describe, expect, it } from 'vitest';
import type { DagMeta, EnvironmentConfig, LiveSnapshot, WorkerSample } from '@dcam/domain';
import type { EnvironmentModelSource, StoredTaskTry, TaskInstanceStore } from '@dcam/ports';
import { getBottlenecks, getDagDetail, getDagLeague, getEnvironmentOverview } from '../src/index';

const M = 60_000;
const H = 60 * M;
const D = 24 * H;
const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const runAt = (ms: number) => `scheduled__${iso(ms).replace('.000Z', '+00:00')}`;

const tryOf = (dagId: string, startAt: number, minutes: number, extra: Partial<StoredTaskTry> = {}) =>
  ({
    envId: 'acme-prod',
    dagId,
    runId: runAt(startAt),
    taskId: 'work',
    mapIndex: -1,
    tryNumber: 1,
    pool: 'default_pool',
    poolSlots: 1,
    state: 'success',
    readyAt: null,
    queuedAt: startAt - M,
    startAt,
    endAt: startAt + minutes * M,
    operator: 'PythonOperator',
    sourceUpdatedAt: startAt + minutes * M,
    ...extra,
  }) satisfies StoredTaskTry;

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
const dag = (dagId: string): DagMeta => ({
  dagId,
  fileloc: `/home/airflow/gcs/dags/${dagId}.py`,
  owners: ['data-oncall'],
  tags: ['daily'],
  team: 'data',
  schedule: '0 0 * * *',
  maxActiveTasks: 4,
  maxActiveRuns: 1,
  catchup: false,
  paused: false,
});

/** A store that answers like DuckDB and records every range it was asked for. */
function storeOf(rows: readonly StoredTaskTry[]) {
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

function modelOf(snapshots: readonly LiveSnapshot[] = [], samples: readonly WorkerSample[] = []) {
  const calls: Array<[number, number]> = [];
  const model: EnvironmentModelSource = {
    config: async (envId) => (envId === 'acme-prod' ? CONFIG : null),
    dags: async () => [dag('heavy'), dag('light')],
    snapshots: async (_env, from, to) => {
      calls.push([from, to]);
      return snapshots.filter((s) => s.at >= from && s.at < to);
    },
    workerSamples: async (_env, from, to) => samples.filter((s) => s.at >= from && s.at < to),
    platformHealth: async () => {
      throw new Error('not used');
    },
  };
  return { model, calls };
}

const clock = { now: () => NOW };
/** Every read covers at most `days` (plus the millisecond read early), so memory stays bounded. */
const atMost = (days: number, calls: ReadonlyArray<[number, number]>) =>
  calls.every(([from, to]) => to - from <= days * D + 1 && to > from);
const atMostADay = (calls: ReadonlyArray<[number, number]>) => atMost(1, calls);

describe('FR-UI-01 long ranges in the use cases', () => {
  const rows = [
    tryOf('heavy', NOW - 20 * D, 120), // 20 days ago
    tryOf('heavy', NOW - 3 * D, 60),
    tryOf('light', NOW - 2 * H, 30),
    tryOf('heavy', NOW - 10 * D, 90), // in the previous 7 days
    tryOf('light', NOW - 40 * D, 60), // in the previous 30 days
  ];

  it('FR-UI-01 / NFR-PERF-01: the 30-day overview covers 30 days, read a day at a time', async () => {
    const { store, calls } = storeOf(rows);
    const o = await getEnvironmentOverview(
      { store, model: modelOf().model, clock },
      { envId: 'acme-prod', range: '30d', sources: ['DEMO'] },
    );
    expect(o.range).toEqual({ from: iso(NOW - 30 * D), to: iso(NOW) });
    expect(o.total_executor_slot_seconds).toBe((120 + 60 + 30 + 90) * 60);
    expect(o.top_dags.map((d) => d.dag_id)).toEqual(['heavy', 'light']);
    expect(o.peak_concurrency).toBe(1);
    expect(calls).toHaveLength(30);
    expect(atMostADay(calls)).toBe(true);
  });

  it('FR-UI-01: the 15-minute overview covers 15 minutes', async () => {
    const { store } = storeOf([tryOf('light', NOW - 10 * M, 5)]);
    const o = await getEnvironmentOverview(
      { store, model: modelOf().model, clock },
      { envId: 'acme-prod', range: '15m', sources: ['DEMO'] },
    );
    expect(o.range.from).toBe(iso(NOW - 15 * M));
    expect(o.total_executor_slot_seconds).toBe(300);
  });

  it('FR-UI-01 / FR-DAGX-02: the 7-day league compares with the previous 7 days, a day at a time', async () => {
    const { store, calls } = storeOf(rows);
    const league = await getDagLeague(
      { store, model: modelOf().model, clock },
      { envId: 'acme-prod', range: '7d', sources: ['DEMO'] },
    );
    expect(league.range).toEqual({ from: iso(NOW - 7 * D), to: iso(NOW) });
    expect(league.previous_range).toEqual({ from: iso(NOW - 14 * D), to: iso(NOW - 7 * D) });
    const heavy = league.rows.find((r) => r.dag_id === 'heavy');
    expect(heavy?.executor_slot_seconds).toBe(3600);
    expect(heavy?.previous_share).toBe(1);
    expect(league.rows.find((r) => r.dag_id === 'light')?.previous_share).toBeNull();
    // History starts with the earliest try read: 10 days ago, 3 of the previous 7 days.
    expect(league.previous_coverage).toBeCloseTo(3 / 7, 9);
    expect(calls).toHaveLength(14);
    expect(atMostADay(calls)).toBe(true);
  });

  it('FR-UI-01 / §8.1: a range longer than the stored history says how much of it has data', async () => {
    const { store } = storeOf([tryOf('heavy', NOW - 3 * D, 60), tryOf('light', NOW - 2 * H, 30)]);
    const league = await getDagLeague(
      { store, model: modelOf().model, clock },
      { envId: 'acme-prod', range: '30d', sources: ['DEMO'] },
    );
    expect(league.coverage).toBeCloseTo(3 / 30, 9);
    expect(league.previous_coverage).toBe(0);
    const o = await getEnvironmentOverview(
      { store, model: modelOf().model, clock },
      { envId: 'acme-prod', range: '30d', sources: ['DEMO'] },
    );
    expect(o.coverage).toBeCloseTo(3 / 30, 9);
  });

  it('FR-UI-01 / FR-DAGD-02: the 90-day DAG detail lists a run from 40 days ago', async () => {
    const { store, calls } = storeOf(rows);
    const result = await getDagDetail(
      { store, model: modelOf().model, clock },
      { envId: 'acme-prod', dagId: 'light', range: '90d', sources: ['DEMO'] },
    );
    if (result.kind !== 'ok') throw new Error(result.kind);
    expect(result.detail.range.from).toBe(iso(NOW - 90 * D));
    expect(result.detail.runs.map((r) => r.start)).toEqual([iso(NOW - 40 * D), iso(NOW - 2 * H)]);
    expect(result.detail.stats.share).toBeCloseTo(90 / 360, 9);
    expect(atMostADay(calls)).toBe(true);
  });

  it('NFR-PERF-06: the 30-day bottlenecks chart has 240 three-hour buckets; buckets without snapshots are gaps', async () => {
    const at = NOW - 20 * D;
    const waiting: LiveSnapshot[] = Array.from({ length: 10 }, (_, i) => ({
      at: at + i * 30_000,
      scheduled: [],
      queued: [
        {
          dagId: 'heavy',
          runId: runAt(at),
          taskId: 'work',
          mapIndex: -1,
          tryNumber: 1,
          pool: 'default_pool',
          poolSlots: 1,
          priorityWeight: 1,
          since: at - 10 * M,
        },
      ],
      pools: [{ name: 'default_pool', slots: 128, running: 72, queued: 1, open: 55 }],
      dagActive: { heavy: 1 },
      executor: { running: 72, queued: 1 },
      workers: { current: 6, target: 6 },
    }));
    const { model, calls } = modelOf(waiting);
    const b = await getBottlenecks(
      { store: storeOf(rows).store, model, clock },
      { envId: 'acme-prod', range: '30d', sources: ['DEMO'] },
    );
    expect(b.bucket_seconds).toBe(3 * 3600);
    expect(b.series).toHaveLength(240);
    expect(b.answer.reason).toBe('executor-slots-exhausted');
    expect(b.waiting_task_seconds).toBe(10 * 30);
    expect(b.snapshot_interval_seconds).toBe(30);
    const withData = b.series.filter((s) => s.workers !== null);
    expect(withData).toHaveLength(1);
    expect(b.series[0]?.workers).toBeNull();
    // The bottleneck analysis reads a week at a time: 30 days in five reads, each read twice (times first).
    expect(atMost(7, calls)).toBe(true);
    expect(calls).toHaveLength(10);
  });

  it('NFR-PERF-06: the 15-minute bottlenecks chart has 15 one-minute buckets', async () => {
    const b = await getBottlenecks(
      { store: storeOf([]).store, model: modelOf().model, clock },
      { envId: 'acme-prod', range: '15m', sources: ['DEMO'] },
    );
    expect(b.bucket_seconds).toBe(60);
    expect(b.series).toHaveLength(15);
  });
});
