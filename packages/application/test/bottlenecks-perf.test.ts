import { describe, expect, it } from 'vitest';
import type {
  DagMeta,
  EnvironmentConfig,
  LiveSnapshot,
  SnapshotTaskInstance,
  WorkerSample,
} from '@dcam/domain';
import type { EnvironmentModelSource, StoredTaskTry, TaskInstanceStore } from '@dcam/ports';
import { bottlenecksInWindow } from '../src/index';

const SEC = 1_000;
const MIN = 60 * SEC;
const H = 60 * MIN;
const DAY = 24 * H;
const NOW = Date.UTC(2026, 10, 9, 0, 0, 0);
const FROM = NOW - 7 * DAY;
const DAGS = 2_000;
/** About 20,000 tries a day at 2,000 DAGs (feature 004's planning figure for the target environment). */
const TRIES_PER_DAY = 20_000;

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
const dags: DagMeta[] = Array.from({ length: DAGS }, (_, i) => ({
  dagId: dagId(i),
  fileloc: `/home/airflow/gcs/dags/${dagId(i)}.py`,
  owners: ['acme'],
  tags: [],
  team: 'acme',
  schedule: i % 3 === 0 ? '0 * * * *' : `${i % 60} ${i % 24} * * *`,
  maxActiveTasks: 16,
  maxActiveRuns: 16,
  catchup: false,
  paused: false,
}));

function generate() {
  const random = rng(7);
  const tries: StoredTaskTry[] = [];
  const total = 7 * TRIES_PER_DAY;
  for (let i = 0; i < total; i++) {
    // Half the tries start in the first five minutes of an hour: collisions at round hours.
    const hour = Math.floor(random() * 7 * 24);
    const minute = random() < 0.5 ? random() * 5 : random() * 60;
    const queuedAt = FROM + hour * H + Math.floor(minute * MIN);
    // Queued while acme_hog_hourly runs (minutes 10–49): 5–10 min; at the round hour up to 10 min; else 1 min.
    const hogging = minute >= 10 && minute < 50;
    const wait = Math.floor((hogging ? 300 + random() * 300 : random() * (minute < 5 ? 600 : 60)) * SEC);
    const heavy = i % 50 === 0;
    const dag = heavy ? dagId(i % 20) : dagId(Math.floor(random() * DAGS));
    const runMs = Math.floor((heavy ? 40 : 1 + random() * 20) * MIN);
    tries.push({
      envId: 'acme-prod',
      dagId: dag,
      runId: `scheduled__${hour}`,
      taskId: `task_${i % 40}`,
      mapIndex: -1,
      tryNumber: 1,
      pool: POOLS[i % POOLS.length]?.name ?? 'default_pool',
      poolSlots: 1,
      state: 'success',
      readyAt: queuedAt - 5 * SEC,
      queuedAt,
      startAt: queuedAt + wait,
      endAt: queuedAt + wait + runMs,
      sourceUpdatedAt: null,
      operator: i % 97 === 0 ? 'ExternalTaskSensor' : 'PythonOperator',
    });
  }

  // A noisy neighbour, so the HM-017 bootstrap is part of the measurement: six tries (1/8 of the off-peak
  // slots) for minutes 10–49 of every hour.
  for (let hour = 0; hour < 7 * 24; hour++)
    for (let j = 0; j < 6; j++) {
      const startAt = FROM + hour * H + 10 * MIN;
      tries.push({
        envId: 'acme-prod',
        dagId: 'acme_hog_hourly',
        runId: `scheduled__${hour}`,
        taskId: `chunk_${j}`,
        mapIndex: -1,
        tryNumber: 1,
        pool: 'default_pool',
        poolSlots: 1,
        state: 'success',
        readyAt: startAt,
        queuedAt: startAt,
        startAt,
        endAt: startAt + 40 * MIN,
        sourceUpdatedAt: null,
        operator: 'PythonOperator',
      });
    }

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
  for (let k = 0; k < 7 * 24 * 60; k++) {
    const at = FROM + k * MIN;
    const peak = k % 60 < 5;
    const scheduled = Array.from({ length: peak ? 150 : 15 }, (_, j) => ti(k, j, at - (k % 5) * MIN));
    const queued = Array.from({ length: peak ? 50 : 10 }, (_, j) => ti(k, 200 + j, at - 30 * SEC));
    const workers = peak ? 12 : 4;
    snapshots.push({
      at,
      scheduled,
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
      dagActive: Object.fromEntries(Array.from({ length: 50 }, (_, j) => [dagId(j * 40), 1 + (j % 16)])),
      executor: { running: workers * 12, queued: queued.length },
      workers: { current: workers, target: peak ? 12 : 4 },
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
  return { tries, snapshots, samples };
}

describe('NFR-PERF: bottlenecks at the target scale', () => {
  it('NFR-PERF: 7 days at 2,000 DAGs with a snapshot every 60 s answer in under 2 s in the application layer', async () => {
    const { tries, snapshots, samples } = generate();
    const store: TaskInstanceStore = {
      upsertTaskTries: async () => {},
      taskTries: async () => tries,
      countTaskTries: async () => tries.length,
    };
    const model: EnvironmentModelSource = {
      config: async () => config,
      dags: async () => dags,
      snapshots: async () => snapshots,
      workerSamples: async () => samples,
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
    };
    // A server has answered requests before this one: warm the code paths on the last day first, so the
    // budget measures the analysis, not the JIT compiler's first pass.
    await bottlenecksInWindow(
      { store, model },
      { envId: 'acme-prod', from: NOW - DAY, to: NOW, bucketMs: 15 * MIN, sources: ['DEMO'] },
    );
    // CPU time of this process, not wall time: on a shared machine or CI runner other processes stretch
    // the wall time, while the CPU time is what the analysis costs (and its wall time on an idle machine).
    const started = process.cpuUsage();
    const b = await bottlenecksInWindow(
      { store, model },
      { envId: 'acme-prod', from: FROM, to: NOW, bucketMs: H, sources: ['DEMO'] },
    );
    const used = process.cpuUsage(started);
    const cpuMs = (used.user + used.system) / 1000;
    expect(b.series).toHaveLength(7 * 24);
    expect(b.waiting_task_seconds).toBeGreaterThan(0);
    expect(b.noisy_neighbours?.evaluated).toBe(true);
    expect(b.noisy_neighbours?.items[0]?.dag_id).toBe('acme_hog_hourly');
    expect(b.pools).toHaveLength(POOLS.length);
    expect(cpuMs).toBeLessThan(2_000);
  }, 120_000);
});
