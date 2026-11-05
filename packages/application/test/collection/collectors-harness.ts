/**
 * Test doubles for the collectors (T-121): an in-memory {@link CollectionStore}, fake Airflow,
 * Composer and Monitoring sources with a request budget, and a {@link CollectorContext} that records
 * reduced fidelity and series counts. Fictitious `acme_*` data only.
 */
import type { DagMeta, EnvironmentConfig, LiveSnapshot, PlatformHealth, WorkerSample } from '@dcam/domain';
import {
  SourceError,
  type AirflowApi,
  type AirflowDag,
  type AirflowPool,
  type AirflowTaskInstance,
  type CollectionStore,
  type ComposerApi,
  type ComposerEnvironment,
  type EnvironmentEntry,
  type MetricQuery,
  type MetricSeries,
  type MonitoringApi,
  type StoredTaskTry,
  type TaskInstanceQuery,
  type TryKey,
} from '@dcam/ports';
import { BudgetExhaustedError, type CollectorContext, type SharedEnvironmentState } from '../../src/index';

export const T0 = Date.UTC(2026, 10, 5, 12, 0, 0);
export const MIN = 60_000;
export const H = 60 * MIN;

const NO_HEALTH: PlatformHealth = {
  envHealthyRatio: null,
  dbHealthyRatio: null,
  heartbeatCompleteness: null,
  webServerHealthyRatio: null,
  dbCpuMemoryMax: null,
  zombies24h: null,
  workerRestarts24h: null,
  importErrors: null,
  parseLoopP95Seconds: null,
};

const tryKey = (k: TryKey) => `${k.dagId}|${k.runId}|${k.taskId}|${k.mapIndex}|${k.tryNumber}`;

export class MemoryStore implements CollectionStore {
  readonly configs = new Map<string, EnvironmentConfig>();
  readonly dagSets = new Map<string, DagMeta[]>();
  readonly health = new Map<string, PlatformHealth>();
  readonly snaps: LiveSnapshot[] = [];
  readonly samples = new Map<number, WorkerSample>();
  readonly tries = new Map<string, StoredTaskTry>();
  readonly ready = new Map<string, number>();
  readonly marks = new Map<string, number>();
  /** Every commitFacts call, for transaction assertions. */
  readonly commits: Array<{ rows: number; watermark: number }> = [];

  async upsertTaskTries(rows: readonly StoredTaskTry[]): Promise<void> {
    for (const r of rows) {
      const k = tryKey(r);
      this.tries.set(k, { ...r, readyAt: this.ready.get(k) ?? r.readyAt });
    }
  }
  async taskTries(envId: string, from: number, to: number): Promise<StoredTaskTry[]> {
    return [...this.tries.values()].filter(
      (t) =>
        t.envId === envId && t.startAt !== null && t.startAt < to && (t.endAt === null || t.endAt >= from),
    );
  }
  async countTaskTries(envId: string): Promise<number> {
    return [...this.tries.values()].filter((t) => t.envId === envId).length;
  }
  async config(envId: string): Promise<EnvironmentConfig | null> {
    return this.configs.get(envId) ?? null;
  }
  async dags(envId: string): Promise<DagMeta[]> {
    return [...(this.dagSets.get(envId) ?? [])];
  }
  async snapshots(_envId: string, from: number, to: number): Promise<LiveSnapshot[]> {
    return this.snaps.filter((s) => s.at >= from && s.at < to).sort((a, b) => a.at - b.at);
  }
  async workerSamples(_envId: string, from: number, to: number): Promise<WorkerSample[]> {
    return [...this.samples.values()].filter((s) => s.at >= from && s.at < to).sort((a, b) => a.at - b.at);
  }
  async platformHealth(envId: string): Promise<PlatformHealth> {
    return this.health.get(envId) ?? NO_HEALTH;
  }
  async saveConfig(envId: string, config: EnvironmentConfig): Promise<void> {
    // A JSON round trip, as a document store would do: Infinity or NaN would not survive it.
    this.configs.set(envId, JSON.parse(JSON.stringify(config)) as EnvironmentConfig);
  }
  async saveDags(envId: string, dags: readonly DagMeta[]): Promise<void> {
    this.dagSets.set(envId, [...dags]);
  }
  async savePlatformHealth(envId: string, health: PlatformHealth): Promise<void> {
    this.health.set(envId, health);
  }
  async saveSnapshot(_envId: string, snapshot: LiveSnapshot): Promise<void> {
    this.snaps.push(snapshot);
  }
  async saveWorkerSamples(_envId: string, samples: readonly WorkerSample[]): Promise<void> {
    for (const s of samples) this.samples.set(s.at, s);
  }
  async recordReady(_envId: string, keys: readonly TryKey[], at: number): Promise<void> {
    for (const k of keys) {
      const prev = this.ready.get(tryKey(k));
      this.ready.set(tryKey(k), prev === undefined ? at : Math.min(prev, at));
    }
  }
  async watermark(envId: string, collectorId: string): Promise<number | null> {
    return this.marks.get(`${envId}|${collectorId}`) ?? null;
  }
  async commitFacts(
    envId: string,
    collectorId: string,
    tries: readonly StoredTaskTry[],
    watermark: number,
  ): Promise<void> {
    await this.upsertTaskTries(tries);
    this.marks.set(`${envId}|${collectorId}`, watermark);
    this.commits.push({ rows: tries.length, watermark });
  }
  async prune(): Promise<void> {}
}

/** Throws {@link BudgetExhaustedError} once `limit` requests have been made. */
export class Budget {
  used = 0;
  constructor(
    readonly api: 'airflow' | 'composer' | 'monitoring',
    public limit = Number.POSITIVE_INFINITY,
  ) {}
  take(): void {
    if (this.used >= this.limit) throw new BudgetExhaustedError(this.api);
    this.used++;
  }
}

export interface FakeAirflowData {
  version: string;
  dags: AirflowDag[];
  pools: AirflowPool[];
  importErrors: number;
  tis: Array<AirflowTaskInstance & { updatedAt: number }>;
}

export class FakeAirflow implements AirflowApi {
  readonly calls: string[] = [];
  readonly tiQueries: TaskInstanceQuery[] = [];
  readonly data: FakeAirflowData;
  constructor(
    data: Partial<FakeAirflowData> = {},
    readonly budget = new Budget('airflow'),
  ) {
    this.data = { version: '2.11.1', dags: [], pools: [], importErrors: 0, tis: [], ...data };
  }
  async version() {
    this.budget.take();
    this.calls.push('version');
    return { version: this.data.version };
  }
  async health() {
    this.budget.take();
    this.calls.push('health');
    return {
      metadatabase: 'healthy' as const,
      scheduler: { status: 'healthy' as const, latestHeartbeat: T0 },
    };
  }
  async dags(page: { readonly limit: number; readonly offset: number }) {
    this.budget.take();
    this.calls.push(`dags:${page.offset}`);
    if (page.limit > 100) throw new Error('limit above 100');
    return {
      items: this.data.dags.slice(page.offset, page.offset + page.limit),
      total: this.data.dags.length,
    };
  }
  async pools() {
    this.budget.take();
    this.calls.push('pools');
    return this.data.pools;
  }
  async importErrorCount() {
    this.budget.take();
    this.calls.push('importErrors');
    return this.data.importErrors;
  }
  async taskInstances(q: TaskInstanceQuery) {
    this.budget.take();
    this.calls.push('taskInstances');
    this.tiQueries.push(q);
    if (q.limit > 100) throw new Error('limit above 100');
    const rows = this.data.tis.filter(
      (t) =>
        (q.states === undefined || (t.state !== null && q.states.includes(t.state))) &&
        (q.updatedFrom === undefined || t.updatedAt >= q.updatedFrom) &&
        (q.updatedTo === undefined || t.updatedAt <= q.updatedTo),
    );
    const items = rows.slice(q.offset, q.offset + q.limit).map(({ updatedAt: _u, ...ti }) => ti);
    return { items, total: rows.length };
  }
  async canReadProviders() {
    return false;
  }
}

export const composerEnv = (over: Partial<ComposerEnvironment> = {}): ComposerEnvironment => ({
  state: 'RUNNING',
  airflowUri: 'https://acme-composer-prod.example.test',
  imageVersion: 'composer-3-airflow-2.11.1-build.22',
  airflowConfigOverrides: {},
  worker: { minCount: 2, maxCount: 6, cpu: 2, memoryGb: 7.5 },
  schedulerCount: 2,
  ...over,
});

export class FakeComposer implements ComposerApi {
  calls = 0;
  constructor(
    public env: ComposerEnvironment = composerEnv(),
    readonly budget = new Budget('composer'),
  ) {}
  async environment() {
    this.budget.take();
    this.calls++;
    return this.env;
  }
}

/** Answers each query from `respond`; records every query. */
export class FakeMonitoring implements MonitoringApi {
  readonly queries: MetricQuery[] = [];
  constructor(
    readonly respond: (q: MetricQuery) => MetricSeries[] = () => [],
    readonly budget = new Budget('monitoring'),
  ) {}
  async series(q: MetricQuery) {
    this.budget.take();
    this.queries.push(q);
    return this.respond(q);
  }
}

export const composerEntry: EnvironmentEntry = {
  id: 'acme-prod',
  displayName: 'Acme production',
  tier: 'prod',
  profile: 'standard',
  source: {
    kind: 'composer',
    projectId: 'acme-prod-123',
    location: 'europe-west1',
    environment: 'acme-composer-prod',
  },
};

export const emulatorEntry: EnvironmentEntry = {
  id: 'acme-emulator',
  displayName: 'Acme emulator',
  tier: 'dev',
  profile: 'live',
  source: {
    kind: 'airflow',
    baseUrl: 'http://127.0.0.1:8080',
    usernameEnv: 'DCAM_EMULATOR_USER',
    passwordEnv: 'DCAM_EMULATOR_PASSWORD',
    limits: {
      parallelism: 32,
      schedulers: 1,
      maxActiveTasksPerDag: 16,
      maxActiveRunsPerDag: 16,
      workerConcurrency: 8,
      workers: 2,
    },
  },
};

export interface FakeContext extends CollectorContext {
  readonly fidelity: string[];
  readonly seriesCounted: number[];
  /** Advances the fake clock. */
  advance(ms: number): void;
}

export function fakeContext(o: {
  env?: EnvironmentEntry;
  store?: MemoryStore;
  now?: number;
  composer?: ComposerApi | null;
  monitoring?: MonitoringApi | null;
  airflow?: AirflowApi;
  shared?: Partial<SharedEnvironmentState>;
}): FakeContext {
  let now = o.now ?? T0;
  const env = o.env ?? composerEntry;
  const shared: SharedEnvironmentState = {
    airflowBaseUrl: env.source.kind === 'airflow' ? env.source.baseUrl : null,
    airflowVersion: null,
    imageVersion: null,
    ...o.shared,
  };
  const fidelity: string[] = [];
  const seriesCounted: number[] = [];
  return {
    env,
    now: () => now,
    store: o.store ?? new MemoryStore(),
    composer: o.composer ?? null,
    monitoring: o.monitoring ?? null,
    airflow() {
      if (!o.airflow || shared.airflowBaseUrl === null)
        throw new SourceError('not-found', 'The Airflow web server URL is not known yet.');
      return o.airflow;
    },
    shared,
    reducedFidelity: (reason) => fidelity.push(reason),
    countSeries: (n) => seriesCounted.push(n),
    fidelity,
    seriesCounted,
    advance(ms) {
      now += ms;
    },
  };
}

/** A task instance row as the Airflow adapter maps it, with the `updated_at` the fake filters on. */
export const ti = (
  over: Partial<AirflowTaskInstance> & { updatedAt?: number } = {},
): AirflowTaskInstance & { updatedAt: number } => ({
  dagId: 'acme_orders_daily',
  runId: 'scheduled__2026-11-05T11:00:00+00:00',
  taskId: 'load',
  mapIndex: -1,
  tryNumber: 1,
  state: 'success',
  pool: 'default_pool',
  poolSlots: 1,
  priorityWeight: 1,
  operator: 'PythonOperator',
  queue: 'default',
  hostname: 'airflow-worker-abc12',
  queuedAt: T0 - 10 * MIN,
  startAt: T0 - 9 * MIN,
  endAt: T0 - 5 * MIN,
  updatedAt: T0 - 5 * MIN,
  ...over,
});

export const dag = (over: Partial<AirflowDag> = {}): AirflowDag => ({
  dagId: 'acme_orders_daily',
  fileloc: '/home/airflow/gcs/dags/orders/acme_orders_daily.py',
  owners: ['finance-data'],
  tags: ['orders'],
  schedule: '0 2 * * *',
  paused: false,
  active: true,
  maxActiveTasks: 16,
  maxActiveRuns: 25,
  ...over,
});

export const pool = (over: Partial<AirflowPool> = {}): AirflowPool => ({
  name: 'default_pool',
  slots: 128,
  runningSlots: 0,
  queuedSlots: 0,
  openSlots: 128,
  scheduledSlots: 0,
  deferredSlots: 0,
  ...over,
});
