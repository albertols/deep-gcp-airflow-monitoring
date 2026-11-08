import { describe, expect, it } from 'vitest';
import {
  compareRuns,
  concurrencyProfile,
  environmentLoad,
  loadShare,
  noisyNeighbourOf,
  type DagMeta,
  type EnvironmentConfig,
  type LiveSnapshot,
} from '@dcam/domain';
import type { EnvironmentModelSource, StoredTaskTry, TaskInstanceStore } from '@dcam/ports';
import { getDagComparison } from '../src/index';
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
 * 7 days of one environment: the big DAG (1 → 48 in parallel → 1) every 15 min, and 300 hourly DAGs of three
 * tasks in a row: about 34,000 tries of the big DAG and 150,000 of the others (about 26,000 tries a day).
 */
function history(envId: string, seed: number): StoredTaskTry[] {
  const random = rng(seed);
  const rows: StoredTaskTry[] = [];
  const add = (dagId: string, runId: string, taskId: string, start: number, seconds: number) => {
    const end = start + Math.round(seconds * S);
    rows.push({
      envId,
      dagId,
      runId,
      taskId,
      mapIndex: -1,
      tryNumber: 1,
      pool: 'default_pool',
      poolSlots: 1,
      state: 'success',
      readyAt: null,
      queuedAt: start - Math.round(random() * 30 * S),
      startAt: start,
      endAt: end,
      operator: 'PythonOperator',
      sourceUpdatedAt: null,
    });
    return end;
  };
  const from = NOW - 7 * D;
  for (let at = from; at < NOW - H; at += 15 * M) {
    const runId = `scheduled__${iso(at).replace('.000Z', '+00:00')}`;
    const first = add(BIG, runId, 'extract', at + 5 * S, 30 + random() * 30);
    let last = first;
    for (let i = 0; i < 48; i++)
      last = Math.max(last, add(BIG, runId, `feature_${i}`, first + 3 * S, 60 + random() * 120));
    add(BIG, runId, 'publish', last + 3 * S, 20 + random() * 20);
  }
  for (let d = 0; d < 300; d++)
    for (let at = from + (d % 60) * M; at < NOW - H; at += H) {
      const runId = `scheduled__${iso(at).replace('.000Z', '+00:00')}`;
      let t = at + 5 * S;
      for (const task of ['a', 'b', 'c'])
        t = add(`acme_dag_${d}`, runId, task, t + 3 * S, 20 + random() * 60);
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

const config = (envId: string): EnvironmentConfig => ({
  envId,
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
});

/** A snapshot a minute for 7 days with the big DAG at its limit for a quarter of each hour. */
function snapshots(): LiveSnapshot[] {
  return Array.from({ length: 7 * 24 * 60 }, (_, k) => {
    const at = NOW - 7 * D + k * M;
    const busy = k % 60 < 15;
    return {
      at,
      scheduled: busy
        ? Array.from({ length: 8 }, (_, i) => ({
            dagId: BIG,
            runId: 'r',
            taskId: `feature_${i}`,
            mapIndex: -1,
            tryNumber: 1,
            pool: 'default_pool',
            poolSlots: 1,
            priorityWeight: 1,
            since: at - M,
          }))
        : [],
      queued: [],
      pools: [{ name: 'default_pool', slots: 128, running: 20, queued: 4, open: 104 }],
      dagActive: busy ? { [BIG]: 16, acme_dag_1: 1 } : { acme_dag_1: 1 },
      executor: { running: 20, queued: 4 },
      workers: { current: 4, target: 4 },
    };
  });
}

describe('NFR-PERF DAG concurrency, impact and comparisons at ~26,000 tries a day', () => {
  const prod = history('acme-prod', 7);
  const test = history('acme-test', 8);

  it('NFR-PERF / FR-DAGD-05 / FR-DAGD-06: concurrency, load share, HM-017 and a run comparison over 7 days stay under 1 s', async () => {
    const w = { from: NOW - 7 * D, to: NOW, now: NOW };
    const own = prod.filter((t) => t.dagId === BIG);
    const snaps = snapshots();
    const slots = new Array<number | null>(7 * 24 * 60).fill(48);
    const runs = [...new Set(own.map((t) => t.runId))];
    const { result, cpuMs, wallMs } = await measureCpu(async () => {
      const profile = concurrencyProfile({
        tries: own,
        snapshots: snaps,
        dagId: BIG,
        limit: 16,
        config: config('acme-prod'),
        window: w,
        bucketMs: H,
        fallbackCadenceMs: 30 * S,
        historyFrom: NOW - 7 * D,
      });
      const share = loadShare({
        dagTries: own,
        environment: environmentLoad(prod, w, H),
        window: w,
        bucketMs: H,
        historyFrom: NOW - 7 * D,
        slots,
      });
      const score = noisyNeighbourOf({ tries: prod, slots, ...w }, BIG);
      const byRun = (id: string | undefined) => own.filter((t) => t.runId === id);
      const runComparison = compareRuns(byRun(runs[0]), byRun(runs.at(-1)));
      return { profile, share, score, runComparison };
    });
    expect(own.length).toBeGreaterThan(33_000);
    expect(result.profile.selfThrottling.atLimitMs).toBeGreaterThan(0);
    expect(result.share).toHaveLength(168);
    expect(result.score.status).not.toBe('not-evaluated');
    expect(result.runComparison?.tasks).toHaveLength(50);
    expect(cpuMs, `CPU ${cpuMs} ms, wall ${wallMs} ms`).toBeLessThan(1_000);
  });

  it('NFR-PERF / FR-DAGD-08: comparing 4 DAGs from two environments over 7 days answers in under 2 s', async () => {
    const all = [...prod, ...test];
    const of = (envId: string, from: number, to: number) =>
      all.filter(
        (t) =>
          t.envId === envId && t.startAt !== null && t.startAt < to && (t.endAt === null || t.endAt > from),
      );
    // The store's own work counts: the fake sums the environment in JavaScript, which DuckDB does in SQL.
    const store: TaskInstanceStore = {
      upsertTaskTries: async () => {},
      countTaskTries: async () => all.length,
      taskTries: async () => {
        throw new Error('the comparison must not read every try of an environment');
      },
      dagTaskTries: async (envId, dagId, from, to) => of(envId, from, to).filter((t) => t.dagId === dagId),
      historyStart: async () => NOW - 7 * D,
      environmentLoad: async (envId, from, to, now, bucketMs) =>
        environmentLoad(
          of(envId, from, to),
          { from, to, now },
          bucketMs,
          Math.floor(from / bucketMs) * bucketMs,
        ),
    };
    const model: EnvironmentModelSource = {
      config: async (envId) => config(envId),
      dags: async () => [meta(BIG), ...Array.from({ length: 300 }, (_, d) => meta(`acme_dag_${d}`))],
      snapshots: async () => [],
      workerSamples: async () => [],
      platformHealth: async () => {
        throw new Error('not used');
      },
    };
    const items = [
      { envId: 'acme-prod', dagId: BIG },
      { envId: 'acme-test', dagId: BIG },
      { envId: 'acme-prod', dagId: 'acme_dag_1' },
      { envId: 'acme-test', dagId: 'acme_dag_2' },
    ];
    const { result, cpuMs, wallMs } = await measureCpu(() =>
      getDagComparison(
        { store, model, clock: { now: () => NOW } },
        { items, range: '7d', sources: ['DEMO'] },
      ),
    );
    if (result.kind !== 'ok') throw new Error(result.kind);
    expect(result.comparison.dags).toHaveLength(4);
    expect(result.comparison.dags[0]?.kpis.runs).toBeGreaterThan(600);
    expect(cpuMs, `CPU ${cpuMs} ms, wall ${wallMs} ms`).toBeLessThan(2_000);
  });
});
