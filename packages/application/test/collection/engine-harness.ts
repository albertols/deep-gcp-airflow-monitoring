/// <reference types="node" />
/**
 * Test harness for the collection engine: a virtual clock whose sleeps wake in time order, fake sources
 * that record every call, and a workspace configuration with fictitious `acme-*` environments.
 */
import type {
  AirflowApi,
  Clock,
  CollectionStore,
  ComposerApi,
  EnvironmentEntry,
  MonitoringApi,
  ProfileCadences,
  Sleeper,
  WorkspaceConfig,
} from '@dcam/ports';
import type { Collector, CollectorContext, CollectorManifest, CollectorResult } from '../../src/index';

export const T0 = Date.UTC(2026, 10, 5, 12, 0, 0);

/** Lets every pending promise continuation run (fakes never use macrotasks). */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

interface Timer {
  readonly at: number;
  readonly seq: number;
  readonly resolve: () => void;
}

/** A clock and a sleeper on virtual time: time moves only in {@link advance}, waking sleeps in order. */
export class FakeTime implements Clock, Sleeper {
  private t: number;
  private seq = 0;
  private timers: Timer[] = [];

  constructor(start = T0) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  sleep(
    ms: number,
    signal?: { readonly aborted: boolean; addEventListener(type: 'abort', fn: () => void): void },
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      const timer: Timer = { at: this.t + Math.max(0, ms), seq: this.seq++, resolve };
      this.timers.push(timer);
      signal?.addEventListener('abort', () => {
        this.timers = this.timers.filter((x) => x !== timer);
        resolve();
      });
    });
  }

  /** Pending sleeps (for tests that check nothing is left waiting). */
  get pending(): number {
    return this.timers.length;
  }

  /** Runs every sleep due within `ms`, in time order, then sets the clock to the end. */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      await flush();
      const next = this.earliest();
      if (!next || next.at > end) break;
      this.timers = this.timers.filter((x) => x !== next);
      this.t = Math.max(this.t, next.at);
      next.resolve();
    }
    this.t = end;
    await flush();
  }

  /** Advances time until `p` settles (at most `limitMs`), and returns its value. */
  async settle<T>(p: Promise<T>, limitMs = 24 * 3_600_000): Promise<T> {
    let done = false;
    const tracked = p.finally(() => {
      done = true;
    });
    tracked.catch(() => undefined);
    const end = this.t + limitMs;
    await flush();
    while (!done) {
      const next = this.earliest();
      if (!next || next.at > end) throw new Error('settle: the promise did not settle in time');
      this.timers = this.timers.filter((x) => x !== next);
      this.t = Math.max(this.t, next.at);
      next.resolve();
      await flush();
    }
    return tracked;
  }

  private earliest(): Timer | undefined {
    let best: Timer | undefined;
    for (const x of this.timers)
      if (!best || x.at < best.at || (x.at === best.at && x.seq < best.seq)) best = x;
    return best;
  }
}

/** A deterministic `random` that cycles through the given values. */
export const cycling = (...values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length] as number;
};

export const CADENCES: Record<'live' | 'standard' | 'eco', ProfileCadences> = {
  live: { airflowLive: 10, airflowFacts: 30, airflowInventory: 600, monitoring: 60, composer: 300 },
  standard: { airflowLive: 30, airflowFacts: 60, airflowInventory: 3600, monitoring: 60, composer: 600 },
  eco: { airflowLive: 120, airflowFacts: 300, airflowInventory: 3600, monitoring: 300, composer: 1800 },
};

export const composerEnv = (
  id: string,
  profile: EnvironmentEntry['profile'] = 'standard',
  projectId = `${id}-project`,
): EnvironmentEntry => ({
  id,
  displayName: id,
  tier: 'prod',
  profile,
  source: { kind: 'composer', projectId, location: 'europe-west1', environment: id },
});

export const airflowEnv = (id: string, profile: EnvironmentEntry['profile'] = 'live'): EnvironmentEntry => ({
  id,
  displayName: id,
  tier: 'dev',
  profile,
  source: {
    kind: 'airflow',
    baseUrl: 'http://127.0.0.1:8080/api/v1',
    usernameEnv: 'DCAM_EMULATOR_USER',
    passwordEnv: 'DCAM_EMULATOR_PASSWORD',
    limits: {
      parallelism: 32,
      schedulers: 1,
      maxActiveTasksPerDag: 16,
      maxActiveRunsPerDag: 16,
      workerConcurrency: 16,
      workers: 1,
    },
  },
});

export const workspace = (
  environments: readonly EnvironmentEntry[],
  budgets: Partial<WorkspaceConfig['budgets']> = {},
): WorkspaceConfig => ({
  path: '/home/acme/dcam.config.yaml',
  dataDir: '/home/acme/.dcam/data',
  quotaProjectId: null,
  caBundlePath: null,
  profiles: CADENCES,
  budgets: {
    airflowApi: { live: 60, standard: 12, eco: 4, background: 2, maxConcurrent: 2 },
    monitoringPerProjectPerMinute: 30,
    composerApiPerMinute: 6,
    ...budgets,
  },
  environments,
});

/** The store is not used by fake collectors; any call is a test bug. */
export const unusedStore = new Proxy({} as CollectionStore, {
  get(_target, prop) {
    throw new Error(`the fake collectors do not use the store (${String(prop)})`);
  },
});

export interface Call {
  readonly envId: string;
  readonly api: 'airflow' | 'composer' | 'monitoring';
  readonly method: string;
  readonly at: number;
  readonly baseUrl?: string;
}

/** Fake sources that log every call; `behave` may throw or wait to script failures and latency. */
export class FakeSources {
  readonly calls: Call[] = [];
  /** Highest number of Airflow calls in flight at once, per environment. */
  readonly airflowPeak = new Map<string, number>();
  private readonly airflowInFlight = new Map<string, number>();
  /** Base URLs handed to `airflow()`, per environment (to check the cache). */
  readonly airflowFactories: string[] = [];

  constructor(
    private readonly time: FakeTime,
    private readonly behave: (call: Call) => Promise<void> | void = () => undefined,
  ) {}

  for(env: EnvironmentEntry): {
    composer?: ComposerApi;
    monitoring?: MonitoringApi;
    airflow(baseUrl: string): AirflowApi;
  } {
    const airflow = (baseUrl: string): AirflowApi => {
      this.airflowFactories.push(`${env.id} ${baseUrl}`);
      const run = async <T>(method: string, value: T): Promise<T> => {
        const inFlight = (this.airflowInFlight.get(env.id) ?? 0) + 1;
        this.airflowInFlight.set(env.id, inFlight);
        this.airflowPeak.set(env.id, Math.max(this.airflowPeak.get(env.id) ?? 0, inFlight));
        try {
          await this.call({ envId: env.id, api: 'airflow', method, at: this.time.now(), baseUrl });
          return value;
        } finally {
          this.airflowInFlight.set(env.id, (this.airflowInFlight.get(env.id) ?? 1) - 1);
        }
      };
      return {
        version: () => run('version', { version: '2.11.1' }),
        health: () =>
          run('health', {
            metadatabase: 'healthy',
            scheduler: { status: 'healthy', latestHeartbeat: this.time.now() },
          }),
        dags: () => run('dags', { items: [], total: 0 }),
        pools: () => run('pools', []),
        importErrorCount: () => run('importErrorCount', 0),
        taskInstances: () => run('taskInstances', { items: [], total: 0 }),
        canReadProviders: () => run('canReadProviders', false),
      };
    };
    if (env.source.kind === 'airflow') return { airflow };
    return {
      airflow,
      composer: {
        environment: async () => {
          await this.call({ envId: env.id, api: 'composer', method: 'environment', at: this.time.now() });
          return {
            state: 'RUNNING',
            airflowUri: `https://${env.id}.composer.example.test`,
            imageVersion: 'composer-3-airflow-2.11.1-build.22',
            airflowConfigOverrides: {},
            worker: { minCount: 1, maxCount: 3, cpu: 2, memoryGb: 8 },
            schedulerCount: 1,
          };
        },
      },
      monitoring: {
        series: async () => {
          await this.call({ envId: env.id, api: 'monitoring', method: 'series', at: this.time.now() });
          return [];
        },
      },
    };
  }

  private async call(call: Call): Promise<void> {
    this.calls.push(call);
    await this.behave(call);
  }
}

export const manifest = (
  overrides: Partial<CollectorManifest> & Pick<CollectorManifest, 'id'>,
): CollectorManifest => {
  const defaults: Record<CollectorManifest['id'], Omit<CollectorManifest, 'id'>> = {
    'composer.config': {
      source: 'SRC-COMPOSER',
      api: 'composer',
      cadence: 'composer',
      priority: 'standard',
      maxRequestsPerCycle: 1,
      outputs: ['config'],
      sourceKinds: ['composer'],
    },
    'af.inventory': {
      source: 'SRC-AF-API',
      api: 'airflow',
      cadence: 'airflowInventory',
      priority: 'background',
      maxRequestsPerCycle: 25,
      outputs: ['dags', 'health'],
      sourceKinds: ['composer', 'airflow'],
    },
    'af.live': {
      source: 'SRC-AF-API',
      api: 'airflow',
      cadence: 'airflowLive',
      priority: 'live',
      maxRequestsPerCycle: 3,
      outputs: ['snapshots'],
      sourceKinds: ['composer', 'airflow'],
    },
    'af.facts': {
      source: 'SRC-AF-API',
      api: 'airflow',
      cadence: 'airflowFacts',
      priority: 'standard',
      maxRequestsPerCycle: 5,
      outputs: ['tries'],
      sourceKinds: ['composer', 'airflow'],
    },
    'mon.core': {
      source: 'SRC-MON',
      api: 'monitoring',
      cadence: 'monitoring',
      priority: 'standard',
      maxRequestsPerCycle: 6,
      outputs: ['samples', 'health'],
      sourceKinds: ['composer'],
    },
    'af.backfill': {
      source: 'SRC-AF-API',
      api: 'airflow',
      cadence: 'airflowFacts',
      priority: 'background',
      maxRequestsPerCycle: 20,
      outputs: ['tries'],
      sourceKinds: ['composer', 'airflow'],
      backfill: 'task_instances',
    },
    'mon.backfill': {
      source: 'SRC-MON',
      api: 'monitoring',
      cadence: 'monitoring',
      priority: 'background',
      maxRequestsPerCycle: 9,
      outputs: ['samples'],
      sourceKinds: ['composer'],
      backfill: 'metrics',
    },
  };
  return { ...defaults[overrides.id], ...overrides };
};

/** A collector whose cycle is the given function. */
export const collector = (
  m: CollectorManifest,
  collect: (ctx: CollectorContext) => Promise<CollectorResult> = async () => ({ dataAsOf: null }),
): Collector => ({ manifest: m, collect });

/** Calls the collector's own API until the engine refuses (budget, deadline or cycle maximum). */
export const greedy = (m: CollectorManifest): Collector =>
  collector(m, async (ctx) => {
    for (;;) {
      if (m.api === 'airflow') await ctx.airflow().pools();
      else if (m.api === 'composer' && ctx.composer)
        await ctx.composer.environment({ projectId: 'acme', location: 'europe-west1', environment: 'acme' });
      else if (m.api === 'monitoring' && ctx.monitoring) await ctx.monitoring.series({} as never);
      else throw new Error(`no ${m.api} source`);
    }
  });

/** The five collectors of feature 002 with default manifests, all greedy. */
export const greedyFive = (overrides: Partial<Omit<CollectorManifest, 'id'>> = {}) =>
  (['composer.config', 'af.inventory', 'af.live', 'af.facts', 'mon.core'] as const).map((id) =>
    greedy(manifest({ id, ...overrides })),
  );

/** The largest number of timestamps inside any window of `windowMs` (sliding). */
export function maxInWindow(times: readonly number[], windowMs = 60_000): number {
  const sorted = [...times].sort((a, b) => a - b);
  let best = 0;
  let lo = 0;
  for (let hi = 0; hi < sorted.length; hi++) {
    while ((sorted[hi] as number) - (sorted[lo] as number) >= windowMs) lo++;
    best = Math.max(best, hi - lo + 1);
  }
  return best;
}
