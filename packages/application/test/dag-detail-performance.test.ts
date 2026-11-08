import { describe, expect, it } from 'vitest';
import {
  criticalPathFrequency,
  dagDurationRegression,
  dagReliability,
  dagRuns,
  dagWindowStats,
  taskStats,
  type DagMeta,
  type EnvironmentConfig,
} from '@dcam/domain';
import type { EnvironmentModelSource, StoredTaskTry, TaskInstanceStore } from '@dcam/ports';
import { getDagDetail } from '../src/index';
import { measureCpu } from './cpu-time';

const S = 1_000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;
const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();

/** mulberry32: deterministic test data. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const BIG = 'acme_feature_pipeline';

/**
 * `days` of history ending at NOW: the big DAG (50 tasks: 1 → 48 in parallel → 1) every 15 min (96 runs a
 * day, 2 % of tries retried), and 100 hourly DAGs of three tasks in a row.
 */
function history(days: number): StoredTaskTry[] {
  const random = rng(7);
  const rows: StoredTaskTry[] = [];
  const add = (dagId: string, runId: string, taskId: string, start: number, seconds: number) => {
    const failed = random() < 0.02;
    const end = start + Math.round(seconds * (failed ? 0.3 : 1) * S);
    const base = {
      envId: 'acme-prod',
      dagId,
      runId,
      taskId,
      mapIndex: -1,
      pool: 'default_pool',
      poolSlots: 1,
      readyAt: null,
      operator: 'PythonOperator',
      sourceUpdatedAt: null,
    };
    rows.push({
      ...base,
      tryNumber: 1,
      state: failed ? 'failed' : 'success',
      queuedAt: start - 2 * S,
      startAt: start,
      endAt: end,
    });
    if (!failed) return end;
    const retry = end + M;
    const retryEnd = retry + Math.round(seconds * S);
    rows.push({
      ...base,
      tryNumber: 2,
      state: 'success',
      queuedAt: retry - 2 * S,
      startAt: retry,
      endAt: retryEnd,
    });
    return retryEnd;
  };
  const from = NOW - days * D;
  for (let at = from; at < NOW - H; at += 15 * M) {
    const runId = `scheduled__${iso(at).replace('.000Z', '+00:00')}`;
    const first = add(BIG, runId, 'extract', at + 5 * S, 30 + random() * 30);
    let last = first;
    for (let i = 0; i < 48; i++)
      last = Math.max(last, add(BIG, runId, `feature_${i}`, first + 3 * S, 60 + random() * 120));
    add(BIG, runId, 'publish', last + 3 * S, 20 + random() * 20);
  }
  for (let d = 0; d < 100; d++)
    for (let at = from + (d % 60) * M; at < NOW - H; at += H) {
      const runId = `scheduled__${iso(at).replace('.000Z', '+00:00')}`;
      let t = at + 5 * S;
      for (const task of ['a', 'b', 'c'])
        t = add(`acme_dag_${d}`, runId, task, t + 3 * S, 20 + random() * 60) + 0;
    }
  return rows;
}

const meta = (dagId: string): DagMeta => ({
  dagId,
  fileloc: `/home/airflow/gcs/dags/${dagId}.py`,
  owners: ['ml-platform-oncall'],
  tags: [],
  team: 'ml-platform',
  schedule: '*/15 * * * *',
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

describe('NFR-PERF DAG detail at 50 tasks × 96 runs a day', () => {
  const rows = history(7);
  const store: TaskInstanceStore = {
    upsertTaskTries: async () => {},
    countTaskTries: async () => rows.length,
    taskTries: async (_env, from, to) =>
      rows.filter((t) => t.startAt !== null && t.startAt < to && (t.endAt === null || t.endAt > from)),
  };
  const model: EnvironmentModelSource = {
    config: async () => CONFIG,
    dags: async () => [meta(BIG), ...Array.from({ length: 100 }, (_, d) => meta(`acme_dag_${d}`))],
    snapshots: async () => [],
    workerSamples: async () => [],
    platformHealth: async () => {
      throw new Error('not used');
    },
  };

  it('NFR-PERF / HM-016: answers with 7 days stored (34,000 tries of the DAG, 50,000 of others) in under 1 s', async () => {
    expect(rows.filter((t) => t.dagId === BIG).length).toBeGreaterThan(33_600);
    const { result, cpuMs, wallMs } = await measureCpu(() =>
      getDagDetail(
        { store, model, clock: { now: () => NOW } },
        { envId: 'acme-prod', dagId: BIG, range: '24h', sources: ['DEMO'] },
      ),
    );
    if (result.kind !== 'ok') throw new Error(result.kind);
    expect(result.detail.tasks).toHaveLength(50);
    expect(result.detail.regression?.baseline.samples).toBeGreaterThan(500);
    expect(cpuMs, `CPU ${cpuMs} ms, wall ${wallMs} ms`).toBeLessThan(1_000);
  });

  it('NFR-PERF: the DAG detail computations over a 7-day range with a week of baseline stay under 1 s', async () => {
    const twoWeeks = history(14).filter((t) => t.dagId === BIG);
    const range = { from: NOW - 7 * D, to: NOW, now: NOW };
    const baseline = { from: range.from - 28 * D, to: range.from };
    const { result, cpuMs, wallMs } = await measureCpu(async () => {
      dagWindowStats(twoWeeks, range);
      dagRuns(twoWeeks, range);
      taskStats(twoWeeks, range);
      dagReliability(twoWeeks, range);
      return {
        regression: dagDurationRegression(twoWeeks, range, baseline),
        frequency: criticalPathFrequency(twoWeeks, range),
      };
    });
    expect(result.regression.tasks.size).toBe(50);
    expect(result.frequency.runs).toBeGreaterThan(600);
    expect(cpuMs, `CPU ${cpuMs} ms, wall ${wallMs} ms`).toBeLessThan(1_000);
  });
});
