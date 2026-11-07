import { describe, expect, it } from 'vitest';
import type {
  DagMeta,
  EnvironmentConfig,
  LiveSnapshot,
  SnapshotTaskInstance,
  WorkerSample,
} from '@dcam/domain';
import type { EnvironmentModelSource, StoredTaskTry, TaskInstanceStore } from '@dcam/ports';
import { getCapacity, getForecast } from '../src/index';

const SEC = 1_000;
const MIN = 60 * SEC;
const H = 60 * MIN;
const DAY = 24 * H;
const NOW = Date.UTC(2026, 10, 9, 0, 0, 0);
const DAGS = 2_000;

/** mulberry32, so the data is the same on every run. */
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

const POOLS = [
  { name: 'default_pool', slots: 256 },
  ...Array.from({ length: 13 }, (_, i) => ({ name: `acme_pool_${i}`, slots: 4 + i * 4 })),
];
const config: EnvironmentConfig = {
  envId: 'acme-prod',
  tier: 'prod',
  composerImage: 'composer-3-airflow-2.11.1-build.22',
  airflowVersion: '2.11.1',
  parallelism: 200,
  schedulers: 2,
  maxActiveTasksPerDag: 16,
  maxActiveRunsPerDag: 25,
  workerConcurrency: 12,
  minWorkers: 2,
  maxWorkers: 12,
  pools: POOLS,
};
const dagId = (i: number) => `acme_dag_${String(i).padStart(4, '0')}`;
const hourly = (i: number) => i % 3 === 0;
const dags: DagMeta[] = Array.from({ length: DAGS }, (_, i) => ({
  dagId: dagId(i),
  fileloc: `/home/airflow/gcs/dags/${dagId(i)}.py`,
  owners: ['acme'],
  tags: [],
  team: 'acme',
  schedule: hourly(i) ? `${i % 60} * * * *` : i % 10 === 1 ? '0:30:00' : `${i % 60} ${i % 24} * * *`,
  maxActiveTasks: 16,
  maxActiveRuns: 16,
  catchup: false,
  paused: false,
}));

/**
 * 28 days of scheduled runs: 667 hourly DAGs with one try a run and 1,333 daily DAGs with three, about 20,000
 * tries a day (feature 004's planning figure), plus a manual run of every tenth DAG each day (baseline).
 */
function generateTries(days: number): StoredTaskTry[] {
  const random = rng(11);
  const tries: StoredTaskTry[] = [];
  const push = (i: number, runId: string, taskId: string, queuedAt: number) => {
    const startAt = queuedAt + Math.floor(random() * 60 * SEC);
    tries.push({
      envId: 'acme-prod',
      dagId: dagId(i),
      runId,
      taskId,
      mapIndex: -1,
      tryNumber: 1,
      pool: POOLS[i % POOLS.length]?.name ?? 'default_pool',
      poolSlots: 1,
      state: 'success',
      readyAt: null,
      queuedAt,
      startAt,
      endAt: Math.min(NOW, startAt + Math.floor((1 + random() * 20) * MIN)),
      sourceUpdatedAt: null,
      operator: 'PythonOperator',
    });
  };
  for (let d = days; d > 0; d--) {
    const day = NOW - d * DAY;
    for (let i = 0; i < DAGS; i++) {
      if (hourly(i))
        for (let h = 0; h < 24; h++) {
          const at = day + h * H + (i % 60) * MIN;
          push(i, `scheduled__${at}`, 'run', at);
        }
      else {
        const at = day + (i % 24) * H + (i % 60) * MIN;
        for (let k = 0; k < 3; k++) push(i, `scheduled__${at}`, `step_${k}`, at + k * 5 * MIN);
      }
      if (i % 10 === 0) push(i, `manual__${day}`, 'adhoc', day + 13 * H);
    }
  }
  return tries;
}

function generateLive(days: number) {
  const ti = (k: number, j: number, since: number): SnapshotTaskInstance => ({
    dagId: dagId((j * 37 + Math.floor(k / 5)) % DAGS),
    runId: `scheduled__${Math.floor(k / 60)}`,
    taskId: `task_${j}`,
    mapIndex: -1,
    tryNumber: 1,
    pool: POOLS[j % POOLS.length]?.name ?? 'default_pool',
    poolSlots: 1,
    priorityWeight: 1 + (j % 4),
    since,
  });
  const snapshots: LiveSnapshot[] = [];
  const samples: WorkerSample[] = [];
  for (let k = 0; k < days * 24 * 60; k++) {
    const at = NOW - days * DAY + k * MIN;
    const peak = k % 60 < 5;
    const workers = peak ? 12 : 4;
    const queued = Array.from({ length: peak ? 50 : 10 }, (_, j) => ti(k, 200 + j, at - 30 * SEC));
    snapshots.push({
      at,
      scheduled: Array.from({ length: peak ? 150 : 15 }, (_, j) => ti(k, j, at - (k % 5) * MIN)),
      queued,
      pools: POOLS.map((p, i) => {
        const running = Math.min(p.slots, peak ? p.slots : Math.floor(p.slots / 2));
        return {
          name: p.name,
          slots: p.slots,
          running,
          queued: i % 3,
          open: Math.max(0, p.slots - running - (i % 3)),
        };
      }),
      dagActive: {},
      executor: { running: workers * 12, queued: queued.length },
      workers: { current: workers, target: workers, source: 'monitoring' },
    });
    samples.push({
      at,
      workers,
      target: workers,
      running: workers * 12,
      queued: queued.length,
      cpu: 0.5,
      memory: 0.5,
    });
  }
  return { snapshots, samples };
}

function deps(tries: StoredTaskTry[], live: ReturnType<typeof generateLive>) {
  const store: TaskInstanceStore = {
    upsertTaskTries: async () => {},
    taskTries: async (_env, from, to) =>
      tries.filter((t) => (t.startAt ?? Infinity) < to && (t.endAt === null || t.endAt > from)),
    countTaskTries: async () => tries.length,
    historyStart: async () => NOW - 28 * DAY,
  };
  const model: EnvironmentModelSource = {
    config: async () => config,
    dags: async () => dags,
    snapshots: async (_env, from, to) => live.snapshots.filter((s) => s.at >= from && s.at < to),
    workerSamples: async (_env, from, to) => live.samples.filter((s) => s.at >= from && s.at < to),
    platformHealth: async () => {
      throw new Error('not read');
    },
  };
  return { store, model, clock: { now: () => NOW } };
}

/** CPU time of this process, not wall time: other processes on a shared machine stretch the wall time. */
async function cpuMs<T>(work: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const started = process.cpuUsage();
  const result = await work();
  const used = process.cpuUsage(started);
  return { result, ms: (used.user + used.system) / 1000 };
}

describe('NFR-PERF: capacity and forecast at the target scale', () => {
  it('NFR-PERF: capacity over 7 days at 2,000 DAGs answers in under 2 s of CPU in the application layer', async () => {
    const tries = generateTries(7);
    const d = deps(tries, generateLive(7));
    // A server has answered requests before this one: warm the code paths first.
    await getCapacity(d, { envId: 'acme-prod', range: '24h', sources: ['DEMO'] });
    // The store and model reads are outside the application budget: read once, then measure the analysis.
    const store = await d.store.taskTries('acme-prod', NOW - 8 * DAY, NOW);
    const fast = { ...d, store: { ...d.store, taskTries: async () => store } };
    const { result, ms } = await cpuMs(() =>
      getCapacity(fast, { envId: 'acme-prod', range: '7d', sources: ['DEMO'] }),
    );
    expect(tries.length).toBeGreaterThan(7 * 19_000);
    expect(result.series).toHaveLength(7 * 24);
    expect(result.summary.observed_minutes).toBe(7 * 24 * 60);
    expect(result.dag_load.dags).toHaveLength(20);
    expect(ms).toBeLessThan(2_000);
  }, 180_000);

  it('NFR-PERF: the forecast over 28 days of history at 2,000 DAGs answers in under 2 s of CPU', async () => {
    const tries = generateTries(28);
    const d = deps(tries, { snapshots: [], samples: [] });
    const fast = { ...d, store: { ...d.store, taskTries: async () => tries } };
    await getForecast(
      { ...d, store: { ...d.store, taskTries: async () => tries.slice(-40_000) } },
      {
        envId: 'acme-prod',
        sources: ['DEMO'],
      },
    );
    const { result, ms } = await cpuMs(() => getForecast(fast, { envId: 'acme-prod', sources: ['DEMO'] }));
    expect(tries.length).toBeGreaterThan(28 * 19_000);
    expect(result.evaluated).toBe(true);
    expect(result.history.runs_profiled).toBeGreaterThan(28 * 17_000);
    expect(result.planned_runs).toBeGreaterThan(17_000);
    expect(result.confidence.level).toBe('normal');
    expect(result.baseline.method).toBe('hour-of-week');
    expect(ms).toBeLessThan(2_000);
  }, 300_000);
});
