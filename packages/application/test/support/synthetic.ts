/**
 * A synthetic environment at the first target profile (spec §10: about 2,000 DAGs) for performance
 * tests: task tries, live snapshots and worker samples over many days, generated deterministically
 * in memory. Fictitious `acme_*` names only; nothing comes from a real environment.
 */
import type {
  DagMeta,
  EnvironmentConfig,
  LiveSnapshot,
  SnapshotTaskInstance,
  WorkerSample,
} from '@dcam/domain';
import type { EnvironmentModelSource, StoredTaskTry, TaskInstanceStore } from '@dcam/ports';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export interface SyntheticOptions {
  readonly now: number;
  readonly days: number;
  readonly dags?: number;
  /** Tries per day across the environment (approximate). */
  readonly triesPerDay?: number;
  /** `af.live` cadence; the standard profile collects every 30 s (spec §17.2). */
  readonly snapshotCadenceMs?: number;
}

export interface SyntheticEnvironment {
  readonly tries: StoredTaskTry[];
  readonly dags: DagMeta[];
  readonly config: EnvironmentConfig;
  readonly snapshotCadenceMs: number;
  readonly store: TaskInstanceStore;
  readonly model: EnvironmentModelSource;
}

/** Deterministic pseudo-random numbers (mulberry32). */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export const SYNTHETIC_CONFIG: EnvironmentConfig = {
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
    { name: 'external_api', slots: 4 },
  ],
};

/** First index whose value is ≥ x in a sorted array. */
function lowerBound(xs: readonly number[], x: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((xs[mid] as number) < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * One environment: a tenth of the DAGs run hourly, the rest daily, so that the environment runs about
 * `triesPerDay` tries a day; 1 % of tries fail and are retried.
 */
export function syntheticEnvironment(options: SyntheticOptions): SyntheticEnvironment {
  const dagCount = options.dags ?? 2_000;
  const triesPerDay = options.triesPerDay ?? 20_000;
  const cadence = options.snapshotCadenceMs ?? 30_000;
  const rand = random(7);
  const end = options.now;
  const start = end - options.days * DAY;
  const hourly = Math.max(1, Math.round(dagCount / 10));
  // Tasks per run so that hourly DAGs make half the tries and daily DAGs the other half.
  const hourlyTasks = Math.max(1, Math.round(triesPerDay / 2 / hourly / 24));
  const dailyTasks = Math.max(1, Math.round(triesPerDay / 2 / Math.max(1, dagCount - hourly)));
  const pools = ['default_pool', 'etl', 'external_api'];

  const dags: DagMeta[] = Array.from({ length: dagCount }, (_, i) => ({
    dagId: `acme_dag_${String(i).padStart(4, '0')}`,
    fileloc: `/home/airflow/gcs/dags/team_${i % 20}/acme_dag_${i}.py`,
    owners: [`team-${i % 20}`],
    tags: [`team-${i % 20}`, i < hourly ? 'hourly' : 'daily'],
    team: `team-${i % 20}`,
    schedule: i < hourly ? '0 * * * *' : `${i % 60} ${i % 24} * * *`,
    maxActiveTasks: 16,
    maxActiveRuns: 1,
    catchup: false,
    paused: false,
  }));

  const tries: StoredTaskTry[] = [];
  dags.forEach((dag, i) => {
    const isHourly = i < hourly;
    const period = isHourly ? HOUR : DAY;
    const offset = isHourly ? (i % 60) * MIN : ((i % 24) * 60 + (i % 60)) * MIN;
    const tasks = isHourly ? hourlyTasks : dailyTasks;
    for (let at = Math.floor(start / period) * period + offset; at < end; at += period) {
      if (at < start) continue;
      const runId = `scheduled__${new Date(at).toISOString().replace('.000Z', '+00:00')}`;
      let t = at + Math.floor(rand() * 30_000);
      for (let k = 0; k < tasks; k++) {
        const queuedAt = t;
        const startAt = queuedAt + Math.floor(rand() * 20_000);
        // Tasks after "now" have not started yet.
        if (startAt >= end) break;
        const runtime = (isHourly ? 30_000 : 120_000) + Math.floor(rand() * 600_000);
        const failed = rand() < 0.01;
        const endAt = startAt + runtime;
        const base: StoredTaskTry = {
          envId: 'acme-prod',
          dagId: dag.dagId,
          runId,
          taskId: `task_${k}`,
          mapIndex: -1,
          tryNumber: 1,
          pool: pools[k % pools.length] as string,
          poolSlots: 1,
          state: failed ? 'failed' : 'success',
          readyAt: queuedAt - 5_000,
          queuedAt,
          startAt,
          endAt: endAt > end ? null : endAt,
          operator: k === 0 && i % 7 === 0 ? 'ExternalTaskSensor' : 'PythonOperator',
          sourceUpdatedAt: Math.min(endAt, end),
        };
        tries.push(base);
        t = endAt;
        if (failed && endAt + 60_000 < end) {
          const retryStart = endAt + 60_000;
          const retryEnd = retryStart + runtime;
          tries.push({
            ...base,
            tryNumber: 2,
            state: 'success',
            queuedAt: retryStart - 5_000,
            readyAt: retryStart - 10_000,
            startAt: retryStart,
            endAt: retryEnd > end ? null : retryEnd,
            sourceUpdatedAt: Math.min(retryEnd, end),
          });
          t = retryEnd;
        }
      }
    }
  });
  tries.sort((a, b) => (a.startAt ?? 0) - (b.startAt ?? 0));
  const startTimes = tries.map((t) => t.startAt ?? 0);
  // Longest running interval, so a range query can start its scan early enough.
  const longest = tries.reduce((m, t) => Math.max(m, (t.endAt ?? end) - (t.startAt ?? 0)), 0);

  const store: TaskInstanceStore = {
    upsertTaskTries: async () => {},
    countTaskTries: async () => tries.length,
    taskTries: async (_env, from, to) => {
      const out: StoredTaskTry[] = [];
      for (let i = lowerBound(startTimes, from - longest); i < tries.length; i++) {
        const t = tries[i] as StoredTaskTry;
        if ((t.startAt ?? 0) >= to) break;
        if (t.endAt === null || t.endAt > from) out.push(t);
      }
      return out;
    },
  };

  // Live snapshots: a few tasks waiting, more during the nightly batch window (00:00–03:00 UTC).
  const snapshotAt = (at: number): LiveSnapshot => {
    const r = random(Math.floor(at / cadence));
    const night = new Date(at).getUTCHours() < 3;
    const waiting = Math.floor(r() * (night ? 40 : 6));
    const ti = (n: number): SnapshotTaskInstance => {
      const dag = dags[Math.floor(r() * dagCount)] as DagMeta;
      return {
        dagId: dag.dagId,
        runId: 'r',
        taskId: `task_${n}`,
        mapIndex: -1,
        tryNumber: 1,
        pool: pools[n % pools.length] as string,
        poolSlots: 1,
        priorityWeight: 1,
        since: at - Math.floor(r() * 10 * MIN),
      };
    };
    const scheduled = Array.from({ length: waiting }, (_, n) => ti(n));
    const queued = Array.from({ length: Math.floor(waiting / 2) }, (_, n) => ti(n));
    const workers = night ? 6 : 2 + Math.floor(r() * 3);
    const dagActive: Record<string, number> = {};
    for (const s of scheduled) dagActive[s.dagId] = (dagActive[s.dagId] ?? 0) + 1;
    return {
      at,
      scheduled,
      queued,
      pools: SYNTHETIC_CONFIG.pools.map((p) => {
        const running = Math.min(p.slots, Math.floor(r() * p.slots));
        return { name: p.name, slots: p.slots, running, queued: 0, open: p.slots - running };
      }),
      dagActive,
      executor: { running: workers * 10, queued: queued.length },
      workers: { current: workers, target: night ? 8 : workers },
    };
  };
  const sampleAt = (at: number): WorkerSample => {
    const night = new Date(at).getUTCHours() < 3;
    const workers = night ? 6 : 3;
    return {
      at,
      workers,
      target: workers,
      running: workers * 10,
      queued: night ? 30 : 2,
      cpu: 0.5,
      memory: 0.6,
    };
  };
  const grid = <T>(from: number, to: number, step: number, make: (at: number) => T): T[] => {
    const out: T[] = [];
    for (let at = Math.ceil(Math.max(from, start) / step) * step; at < Math.min(to, end + 1); at += step)
      out.push(make(at));
    return out;
  };

  const model: EnvironmentModelSource = {
    config: async () => SYNTHETIC_CONFIG,
    dags: async () => dags,
    snapshots: async (_env, from, to) => grid(from, to, cadence, snapshotAt),
    workerSamples: async (_env, from, to) => grid(from, to, MIN, sampleAt),
    platformHealth: async () => ({
      envHealthyRatio: 1,
      dbHealthyRatio: 1,
      heartbeatCompleteness: 1,
      webServerHealthyRatio: 1,
      dbCpuMemoryMax: 0.4,
      zombies24h: 0,
      workerRestarts24h: 0,
      importErrors: 0,
      parseLoopP95Seconds: 30,
    }),
  };

  return { tries, dags, config: SYNTHETIC_CONFIG, snapshotCadenceMs: cadence, store, model };
}
