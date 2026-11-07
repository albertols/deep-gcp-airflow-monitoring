/**
 * The collection engine (spec §7.11, §9.3): one scheduler for every collector of every environment, with
 * the observer budget, circuit breakers and collector health.
 *
 * Scheduling (FR-COLL-02)
 * - Each (environment, collector) is a single-flight task: a cycle never overlaps itself, and a cycle that
 *   overruns its cadence is followed at once by the next one.
 * - The cadence comes from the environment's profile, with ±10 % jitter drawn from `random`; the first
 *   cycle runs at start. Profile `off` disables every collector, and a collector whose `sourceKinds`
 *   exclude the environment's source kind is disabled there.
 * - Priorities apply where collectors contend: every request waits in the budget gate of its API, highest
 *   priority first (live > standard > background, see `budget.ts`).
 * - Airflow collectors wait until the Airflow base URL is known (from the configuration for a self-managed
 *   Airflow, from `composer.config` for Composer) and are woken as soon as it is set.
 *
 * Budgets (FR-COLL-06, NFR-OBS-05)
 * - Airflow per environment by the profile's budget class, at most `maxConcurrent` in flight; Composer per
 *   environment; Monitoring per project, shared by the project's environments, at the budget of the most
 *   demanding profile among them. Monitoring and Composer budgets follow the profile (§7.11). Background
 *   work has a guaranteed share of the Airflow and Monitoring budgets (`budget.ts`). Every budget is
 *   clamped to the hard maxima.
 * - One token per source call. A call may wait for a token until the cycle's deadline (its start plus its
 *   cadence). A call that gets none in time, or that would exceed the manifest's `maxRequestsPerCycle`,
 *   throws `BudgetExhaustedError`: the cycle ends early with reduced fidelity, not as a failure, and the
 *   next cycle starts a full interval after it ended (longer intervals, fewer pages, §7.11 item 3).
 *
 * Errors
 * - Transient `SourceError`s open the (environment, API) circuit (`breaker.ts`): no cycle of that API
 *   starts while it is open, and calls in running cycles fail fast.
 * - Other errors (unauthenticated, forbidden, quota project, API disabled, not found, invalid response,
 *   unsupported, and bugs) fail the cycle with the error's fix hint; the collector retries at most every
 *   5 min.
 * - A VPC Service Controls denial (FR-AUTH-06) parks the (environment, API): nothing calls it again until
 *   `recheck(envId)` or a restart.
 *
 * Health and footprint (FR-COLL-11, FR-SELF-01, HM-030, NFR-OBS-06): `status()` maps the runtime state
 * to the `Collection` contract (`status.ts`). Every finished cycle is counted per minute for the error
 * rate; `recordRequest` (fed by the http-guard hook) and `countSeries` (fed by collectors) fill bounded
 * minute buckets (`footprint.ts`). One token is taken per source call, while the footprint counts HTTP
 * requests, so a paged Monitoring query shows every page there.
 *
 * @implements FR-COLL-01, FR-COLL-02, FR-COLL-06, FR-COLL-11, FR-AUTH-06, FR-SELF-01, HM-030, NFR-OBS-05,
 *   NFR-OBS-06
 */
import type { Collection } from '@dcam/contracts';
import {
  SourceError,
  type AirflowApi,
  type Clock,
  type CollectionStore,
  type ComposerApi,
  type EnvironmentEntry,
  type MonitoringApi,
  type Sleeper,
  type WorkspaceConfig,
} from '@dcam/ports';
import {
  BudgetGate,
  TokenBucket,
  effectiveBudgets,
  type BudgetGateOptions,
  type EffectiveBudgets,
} from './budget';
import { CircuitBreaker } from './breaker';
import {
  BudgetExhaustedError,
  type ApiId,
  type Collector,
  type CollectorContext,
  type CollectorManifest,
  type CollectorResult,
  type EnvironmentSources,
  type SharedEnvironmentState,
} from './types';
import {
  FAILING_AFTER,
  environmentStatus,
  type CycleCounts,
  type EnvironmentView,
  type LastError,
  type TaskView,
} from './status';
import { FootprintCounter, HOUR_MINUTES, MinuteBuckets, RollingSum, type RequestRecord } from './footprint';

export type { RequestRecord } from './footprint';

export interface CollectionLogEntry {
  readonly level: 'info' | 'warn' | 'error';
  readonly envId?: string;
  readonly collectorId?: string;
  readonly message: string;
}

export interface CollectionEngineDeps {
  readonly config: WorkspaceConfig;
  readonly store: CollectionStore;
  readonly clock: Clock;
  readonly sleeper: Sleeper;
  /** Uniform in [0, 1), for jitter and backoff; `Math.random` by default. */
  readonly random?: () => number;
  readonly sources: (env: EnvironmentEntry) => EnvironmentSources;
  readonly collectors: readonly Collector[];
  readonly log?: (entry: CollectionLogEntry) => void;
}

export interface CollectionEngine {
  start(): void;
  /** Aborts every wait and resolves once running cycles have finished. */
  stop(): Promise<void>;
  status(): Collection;
  /** Fed by the composition root from the http-guard onResponse hook (HM-030). */
  recordRequest(envId: string, api: ApiId, request: RequestRecord): void;
  /**
   * Runs the environment's checks again: clears VPC Service Controls parking (FR-AUTH-06) and retries
   * collectors that failed with an error the user had to fix, now.
   */
  recheck(envId: string): void;
}

/** A collector manifest the engine refuses (FR-COLL-01). */
export class InvalidCollectorError extends Error {
  override readonly name = 'InvalidCollectorError';
}

/** Why a manifest cannot be registered; empty when it can. */
export function manifestProblems(m: CollectorManifest): string[] {
  const problems: string[] = [];
  if (!(Number.isFinite(m.maxRequestsPerCycle) && m.maxRequestsPerCycle > 0))
    problems.push(`${m.id}: maxRequestsPerCycle must be a positive number (the cycle's request budget).`);
  if (m.outputs.length === 0) problems.push(`${m.id}: declares no output.`);
  return problems;
}

const JITTER = 0.1;
const MIN_CADENCE_MS = 1_000;
const SLOW_RETRY_MS = 5 * 60_000;

interface ParkedApi {
  readonly error: SourceError;
  readonly at: number;
}

interface EnvRuntime extends EnvironmentView<Task> {
  readonly shared: SharedEnvironmentState;
  readonly gates: Readonly<Record<ApiId, BudgetGate>>;
  readonly breakers: Readonly<Record<ApiId, CircuitBreaker>>;
  readonly parked: Map<ApiId, ParkedApi>;
  readonly tasks: Task[];
  sources: EnvironmentSources | null;
  airflow: { readonly url: string; readonly api: AirflowApi } | null;
}

interface Task extends TaskView {
  readonly env: EnvRuntime;
  readonly collector: Collector;
  dueAt: number;
  /** The last failure needs the user to act; retry slowly. */
  slowRetry: boolean;
  abort: AbortController | null;
  wake: (() => void) | null;
}

interface Cycle {
  readonly task: Task;
  readonly deadline: number;
  requests: number;
  reduced: string | null;
}

export function createCollectionEngine(deps: CollectionEngineDeps): CollectionEngine {
  const { config, clock, sleeper } = deps;
  const random = deps.random ?? Math.random;

  const seen = new Set<string>();
  const problems: string[] = [];
  for (const c of deps.collectors) {
    problems.push(...manifestProblems(c.manifest));
    if (seen.has(c.manifest.id)) problems.push(`${c.manifest.id}: registered twice.`);
    seen.add(c.manifest.id);
  }
  if (problems.length > 0) throw new InvalidCollectorError(`Refused collectors: ${problems.join(' ')}`);

  let started = false;
  let stopping = false;
  let stopped: Promise<void> | null = null;
  const loops: Promise<void>[] = [];

  const log = (level: CollectionLogEntry['level'], message: string, task?: Task, envId?: string) => {
    const id = task?.env.entry.id ?? envId;
    deps.log?.({
      level,
      message,
      ...(id === undefined ? {} : { envId: id }),
      ...(task ? { collectorId: task.manifest.id } : {}),
    });
  };

  const gate = (
    perMinute: () => number,
    api: ApiId,
    extra: Pick<BudgetGateOptions, 'backgroundBucket' | 'maxConcurrent'> = { maxConcurrent: () => Infinity },
  ) => new BudgetGate({ api, clock, sleeper, bucket: new TokenBucket(perMinute), ...extra });
  // Cloud Monitoring budgets are per project (§7.11 item 1): one gate per project, with the budget of the
  // most demanding profile among the project's environments (eco alone gets the eco budget).
  const projectBudgets = new Map<string, { monitoring: number; monitoringBackground: number }>();
  for (const entry of config.environments) {
    if (entry.source.kind !== 'composer') continue;
    const b = effectiveBudgets(config.budgets, entry.profile);
    const prev = projectBudgets.get(entry.source.projectId);
    projectBudgets.set(entry.source.projectId, {
      monitoring: Math.max(prev?.monitoring ?? 0, b.monitoring),
      monitoringBackground: Math.max(prev?.monitoringBackground ?? 0, b.monitoringBackground),
    });
  }
  const projectGates = new Map<string, BudgetGate>();
  const monitoringGate = (env: EnvironmentEntry): BudgetGate => {
    if (env.source.kind !== 'composer') return gate(() => 0, 'monitoring');
    const key = env.source.projectId;
    let g = projectGates.get(key);
    if (!g) {
      const budget = projectBudgets.get(key) ?? { monitoring: 0, monitoringBackground: 0 };
      g = gate(() => budget.monitoring, 'monitoring', {
        backgroundBucket: new TokenBucket(() => budget.monitoringBackground),
        maxConcurrent: () => Infinity,
      });
      projectGates.set(key, g);
    }
    return g;
  };
  /** An environment's budgets, with the Monitoring budget of its project. */
  const budgetsOf = (entry: EnvironmentEntry): EffectiveBudgets => {
    const own = effectiveBudgets(config.budgets, entry.profile);
    const project = entry.source.kind === 'composer' ? projectBudgets.get(entry.source.projectId) : undefined;
    return project && entry.profile !== 'off' ? { ...own, ...project } : own;
  };

  const wake = (task: Task) => {
    task.abort?.abort();
    const resume = task.wake;
    task.wake = null;
    resume?.();
  };

  const envs = new Map<string, EnvRuntime>();
  for (const entry of config.environments) {
    const budgets = budgetsOf(entry);
    const google = entry.source.kind === 'composer';
    const tasks: Task[] = [];
    const runtime: EnvRuntime = {
      entry,
      budgets,
      footprint: google
        ? {
            airflow: new FootprintCounter(random),
            composer: new FootprintCounter(random),
            monitoring: new FootprintCounter(random),
          }
        : { airflow: new FootprintCounter(random) },
      series: google ? new RollingSum() : null,
      shared: sharedState(entry, () => {
        for (const t of tasks) if (t.manifest.api === 'airflow') wake(t);
      }),
      gates: {
        airflow: gate(() => budgets.airflow, 'airflow', {
          backgroundBucket: new TokenBucket(() => budgets.airflowBackground),
          maxConcurrent: () => budgets.airflowConcurrent,
        }),
        composer: gate(() => budgets.composer, 'composer'),
        monitoring: monitoringGate(entry),
      },
      breakers: {
        airflow: new CircuitBreaker(random),
        composer: new CircuitBreaker(random),
        monitoring: new CircuitBreaker(random),
      },
      parked: new Map(),
      tasks,
      sources: null,
      airflow: null,
      reducedAt: null,
    };
    for (const collector of deps.collectors) {
      const m = collector.manifest;
      const disabled = entry.profile === 'off' || !m.sourceKinds.includes(entry.source.kind);
      const cadences = entry.profile === 'off' ? null : config.profiles[entry.profile];
      tasks.push({
        env: runtime,
        collector,
        manifest: m,
        disabled,
        cadenceMs: disabled || !cadences ? 0 : Math.max(MIN_CADENCE_MS, cadences[m.cadence] * 1_000),
        dueAt: 0,
        running: false,
        slowRetry: false,
        lastAttemptAt: null,
        lastSuccessAt: null,
        dataAsOf: null,
        lastOutcome: null,
        consecutiveFailures: 0,
        lastError: null,
        cycles: new MinuteBuckets<CycleCounts>(HOUR_MINUTES, () => ({ cycles: 0, failures: 0 })),
        abort: null,
        wake: null,
      });
    }
    envs.set(entry.id, runtime);
  }
  const allTasks = () => [...envs.values()].flatMap((e) => e.tasks);

  /** Why a task may not start a cycle now: until a time, or until woken (`null`). */
  const hold = (task: Task, now: number): { readonly until: number | null } | null => {
    const { env, manifest } = task;
    if (env.parked.has(manifest.api)) return { until: null };
    if (manifest.api === 'airflow' && env.shared.airflowBaseUrl === null) return { until: null };
    const open = env.breakers[manifest.api].openUntil(now);
    return open === null ? null : { until: open };
  };

  const nextRunAt = (task: Task): number | null => {
    if (!started || stopping || task.disabled || task.running) return null;
    const h = hold(task, clock.now());
    if (h?.until === null) return null;
    return Math.max(task.dueAt, h?.until ?? 0);
  };

  const sleepFor = async (task: Task, ms: number) => {
    const abort = new AbortController();
    task.abort = abort;
    await sleeper.sleep(ms, abort.signal);
    if (task.abort === abort) task.abort = null;
  };

  const run = async (task: Task): Promise<void> => {
    while (!stopping) {
      const now = clock.now();
      const h = hold(task, now);
      if (h?.until === null) {
        await new Promise<void>((resolve) => {
          task.wake = resolve;
        });
        continue;
      }
      const at = Math.max(task.dueAt, h?.until ?? now);
      if (at > now) {
        await sleepFor(task, at - now);
        continue;
      }
      await runCycle(task);
    }
  };

  const sourcesOf = (env: EnvRuntime): EnvironmentSources => (env.sources ??= deps.sources(env.entry));

  const circuitOpen = (api: ApiId, until: number) =>
    new SourceError(
      'unavailable',
      `DCAM paused calls to the ${api} API after errors, and tries again at ${new Date(until).toISOString()}.`,
      { retryAfterMs: Math.max(0, until - clock.now()) },
    );

  const park = (env: EnvRuntime, api: ApiId, error: SourceError) => {
    env.parked.set(api, { error, at: clock.now() });
    log(
      'error',
      `VPC Service Controls denied a ${api} API call${error.details.vpcScId ? ` (unique identifier ${error.details.vpcScId})` : ''}. DCAM does not retry until the check runs again.`,
      undefined,
      env.entry.id,
    );
  };

  const stoppingError = (api: ApiId) => new BudgetExhaustedError(api, 'DCAM is stopping.');

  /** Throws while the circuit is open, waits while a probe is in flight; `true` when this call is the probe. */
  const passBreaker = async (breaker: CircuitBreaker, api: ApiId): Promise<boolean> => {
    for (;;) {
      const verdict = breaker.enter(clock.now());
      if (verdict.kind === 'go') return false;
      if (verdict.kind === 'probe') return true;
      if (verdict.kind === 'open') throw circuitOpen(api, verdict.until);
      await verdict.settled;
      if (stopping) throw stoppingError(api);
    }
  };

  /** Every source call goes through here: cycle maximum, parking, circuit breaker, then the budget. */
  const call = async <T>(c: Cycle, api: ApiId, fn: () => Promise<T>): Promise<T> => {
    const { env, manifest } = c.task;
    if (stopping) throw stoppingError(api);
    if (c.requests >= manifest.maxRequestsPerCycle)
      throw new BudgetExhaustedError(
        api,
        `${manifest.id} made the ${manifest.maxRequestsPerCycle} requests one cycle may make.`,
      );
    const parked = env.parked.get(api);
    if (parked) throw parked.error;
    const breaker = env.breakers[api];
    const probe = await passBreaker(breaker, api);
    c.requests++;
    let release: () => void;
    try {
      release = await env.gates[api].acquire({ priority: manifest.priority, deadline: c.deadline });
    } catch (error) {
      c.requests--;
      if (probe) breaker.abandon();
      throw error;
    }
    // The circuit may have opened while this call waited for a token.
    const until = probe ? null : breaker.openUntil(clock.now());
    if (until !== null) {
      release();
      c.requests--;
      throw circuitOpen(api, until);
    }
    try {
      const value = await fn();
      breaker.answered(probe);
      return value;
    } catch (error) {
      if (error instanceof SourceError && error.transient) {
        const reopens = breaker.failed(clock.now(), error.details.retryAfterMs ?? 0, probe);
        log(
          'warn',
          `The ${api} API failed (${error.kind}); DCAM pauses calls to it until ${new Date(reopens).toISOString()}.`,
          c.task,
        );
      } else {
        breaker.answered(probe);
        if (error instanceof SourceError && error.kind === 'vpc-sc') park(env, api, error);
      }
      throw error;
    } finally {
      release();
    }
  };

  const budgetedAirflow = (c: Cycle, api: AirflowApi): AirflowApi => ({
    version: () => call(c, 'airflow', () => api.version()),
    health: () => call(c, 'airflow', () => api.health()),
    dags: (page) => call(c, 'airflow', () => api.dags(page)),
    pools: () => call(c, 'airflow', () => api.pools()),
    importErrorCount: () => call(c, 'airflow', () => api.importErrorCount()),
    taskInstances: (query) => call(c, 'airflow', () => api.taskInstances(query)),
    canReadProviders: () => call(c, 'airflow', () => api.canReadProviders()),
  });
  const budgetedComposer = (c: Cycle, api: ComposerApi): ComposerApi => ({
    environment: (ref) => call(c, 'composer', () => api.environment(ref)),
  });
  const budgetedMonitoring = (c: Cycle, api: MonitoringApi): MonitoringApi => ({
    series: (query) => call(c, 'monitoring', () => api.series(query)),
  });

  const contextFor = (c: Cycle): CollectorContext => {
    const env = c.task.env;
    const sources = sourcesOf(env);
    const google = env.entry.source.kind === 'composer';
    return {
      env: env.entry,
      now: () => clock.now(),
      store: deps.store,
      composer: google && sources.composer ? budgetedComposer(c, sources.composer) : null,
      monitoring: google && sources.monitoring ? budgetedMonitoring(c, sources.monitoring) : null,
      airflow: () => {
        const url = env.shared.airflowBaseUrl;
        if (url === null)
          throw new SourceError('not-found', 'The Airflow web server URL is not known yet.', {
            fixHint: 'DCAM reads it from the Composer API; check the composer.config collector.',
          });
        if (env.airflow?.url !== url) env.airflow = { url, api: sources.airflow(url) };
        return budgetedAirflow(c, env.airflow.api);
      },
      shared: env.shared,
      reducedFidelity: (reason) => {
        c.reduced = reason;
      },
      countSeries: (n) => {
        env.series?.add(clock.now(), n);
      },
    };
  };

  const runCycle = async (task: Task): Promise<void> => {
    const start = clock.now();
    const c: Cycle = { task, deadline: start + task.cadenceMs, requests: 0, reduced: null };
    task.running = true;
    task.lastAttemptAt = start;
    let result: CollectorResult | null = null;
    let error: unknown = null;
    try {
      result = await task.collector.collect(contextFor(c));
    } catch (e) {
      error = e;
    }
    task.running = false;
    if (stopping) return;
    const end = clock.now();
    const factor = 1 + JITTER * (2 * random() - 1);
    const interval = task.cadenceMs * factor;
    const completed = result !== null || error instanceof BudgetExhaustedError;
    const counts = task.cycles.bucket(end);
    if (counts) {
      counts.cycles++;
      if (!completed) counts.failures++;
    }
    if (completed) {
      const reduced = c.reduced ?? (error instanceof BudgetExhaustedError ? error.message : null);
      if (result !== null) {
        task.lastSuccessAt = end;
        task.consecutiveFailures = 0;
        if (result.dataAsOf !== null) task.dataAsOf = Math.max(task.dataAsOf ?? -Infinity, result.dataAsOf);
      }
      task.slowRetry = false;
      if (reduced !== null) {
        task.env.reducedAt = end;
        if (task.lastOutcome !== 'reduced') log('info', `Reduced fidelity: ${reduced}`, task);
      }
      task.lastOutcome = reduced === null ? 'ok' : 'reduced';
      // Reduced fidelity lengthens the interval: the next cycle waits a full interval after this one.
      task.dueAt = reduced === null ? Math.max(start + interval, end) : end + interval;
      return;
    }
    const sourceError = error instanceof SourceError ? error : null;
    task.consecutiveFailures++;
    task.lastOutcome = 'failed';
    task.lastError = lastErrorOf(error, end);
    log(
      task.consecutiveFailures >= FAILING_AFTER ? 'error' : 'warn',
      `Cycle failed: ${task.lastError.message}`,
      task,
    );
    if (sourceError?.transient) {
      task.slowRetry = false;
      task.dueAt = Math.max(start + interval, end);
    } else {
      task.slowRetry = true;
      task.dueAt = end + Math.max(task.cadenceMs, SLOW_RETRY_MS) * factor;
    }
  };

  return {
    start() {
      if (started) return;
      started = true;
      const now = clock.now();
      for (const task of allTasks()) {
        if (task.disabled) continue;
        task.dueAt = now;
        loops.push(
          run(task).catch((e: unknown) => {
            log('error', `The scheduler stopped unexpectedly: ${messageOf(e)}`, task);
          }),
        );
      }
    },

    stop() {
      if (!stopped) {
        stopping = true;
        for (const env of envs.values()) {
          for (const g of Object.values(env.gates)) g.close();
          for (const b of Object.values(env.breakers)) b.abandon();
        }
        for (const task of allTasks()) wake(task);
        stopped = Promise.all(loops).then(() => undefined);
      }
      return stopped;
    },

    status() {
      const now = clock.now();
      return {
        mode: 'live',
        generated_at: new Date(now).toISOString(),
        environments: [...envs.values()].map((env) =>
          environmentStatus(env, now, (task) => {
            const parked = env.parked.get(task.manifest.api);
            return {
              nextRunAt: nextRunAt(task),
              parked: parked ? lastErrorOf(parked.error, parked.at) : null,
            };
          }),
        ),
      };
    },

    recordRequest(envId, api, request) {
      envs.get(envId)?.footprint[api]?.record(request);
    },

    recheck(envId) {
      const env = envs.get(envId);
      if (!env) return;
      const wasParked = new Set(env.parked.keys());
      env.parked.clear();
      const now = clock.now();
      for (const task of env.tasks) {
        if (task.disabled) continue;
        if (task.slowRetry || wasParked.has(task.manifest.api)) task.dueAt = Math.min(task.dueAt, now);
        wake(task);
      }
    },
  };
}

/** Shared facts of one environment; setting the Airflow URL wakes the collectors waiting for it. */
function sharedState(entry: EnvironmentEntry, onAirflowUrl: () => void): SharedEnvironmentState {
  let url = entry.source.kind === 'airflow' ? entry.source.baseUrl : null;
  return {
    get airflowBaseUrl() {
      return url;
    },
    set airflowBaseUrl(next: string | null) {
      const changed = next !== url;
      url = next;
      if (changed && next !== null) onAirflowUrl();
    },
    airflowVersion: null,
    imageVersion: null,
  };
}

function lastErrorOf(error: unknown, at: number): LastError {
  const sourceError = error instanceof SourceError ? error : null;
  return {
    kind: sourceError?.kind ?? 'internal',
    message: messageOf(error),
    fixHint: sourceError?.details.fixHint ?? null,
    at,
  };
}

function messageOf(error: unknown): string {
  if (error instanceof SourceError && error.kind === 'vpc-sc' && error.details.vpcScId)
    return `${error.message} (unique identifier ${error.details.vpcScId})`;
  return error instanceof Error ? error.message : String(error);
}
