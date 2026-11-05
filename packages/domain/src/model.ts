/**
 * Environment model shared by the signals (spec §7, §8): the configuration that can throttle work, DAG
 * metadata, live snapshots of waiting work (what the `af.live` collector captures every 30 s), worker
 * samples and platform-health inputs. Times are epoch milliseconds; durations are milliseconds unless
 * a field name says otherwise.
 */

export type Tier = 'dev' | 'test' | 'uat' | 'prod' | 'other';

/**
 * Why a ready task instance is not running (HM-006), in the order the classifier evaluates them,
 * followed by `normal-latency`: a wait shorter than the reason thresholds, which is not a platform limit.
 */
export const WAIT_REASONS = [
  'dag-max-active-runs',
  'pool-missing',
  'task-larger-than-pool',
  'parallelism',
  'pool-exhausted',
  'dag-max-active-tasks',
  'task-limit',
  'scheduler-throughput',
  'autoscaling-lag',
  'executor-slots-exhausted',
  'worker-pickup',
  'triggerer-capacity',
  'unknown',
  'normal-latency',
] as const;

export type WaitReasonId = (typeof WAIT_REASONS)[number];

export interface PoolConfig {
  readonly name: string;
  readonly slots: number;
}

/**
 * Where a limit's value comes from (spec §14.1 provenance labels): the configuration file of a
 * self-managed Airflow, a Composer override, a documented Composer or Airflow default, or `unknown`.
 */
export type LimitSource = 'configured' | 'override' | 'composer-default' | 'airflow-default' | 'unknown';
export type LimitKey = 'parallelism' | 'workerConcurrency' | 'maxActiveTasksPerDag' | 'maxActiveRunsPerDag';

/**
 * Placeholder for a limit DCAM does not know, for example `[core] parallelism` on Composer without an
 * override (Composer documents no default; HM-032 infers it later). It is far above any real limit
 * (Composer 3 allows at most 100 workers × 24 slots), so it never binds even where the provenance is
 * lost, and it survives JSON and integer columns, unlike `Infinity`.
 */
export const UNKNOWN_LIMIT = 1_000_000;

/** Limits that can make work wait (HM-006 inputs). */
export interface EnvironmentConfig {
  readonly envId: string;
  readonly tier: Tier;
  readonly composerImage: string;
  readonly airflowVersion: string;
  /** `[core] parallelism`, enforced per scheduler. */
  readonly parallelism: number;
  readonly schedulers: number;
  /** `[core] max_active_tasks_per_dag`: default for DAGs that do not set their own. */
  readonly maxActiveTasksPerDag: number;
  /** `[core] max_active_runs_per_dag`. */
  readonly maxActiveRunsPerDag: number;
  /** `[celery] worker_concurrency`. */
  readonly workerConcurrency: number;
  readonly minWorkers: number;
  readonly maxWorkers: number;
  readonly pools: readonly PoolConfig[];
  /**
   * Provenance of the limits. Absent entries are exact (demo mode, or `configured`). A limit marked
   * `unknown` holds {@link UNKNOWN_LIMIT}; signals do not evaluate reasons that depend on it.
   */
  readonly limitSources?: Readonly<Partial<Record<LimitKey, LimitSource>>>;
}

/** True unless the configuration marks the limit as unknown. */
export const limitKnown = (config: Pick<EnvironmentConfig, 'limitSources'>, key: LimitKey): boolean =>
  config.limitSources?.[key] !== 'unknown';

export interface DagMeta {
  readonly dagId: string;
  readonly fileloc: string;
  readonly owners: readonly string[];
  readonly tags: readonly string[];
  /** Team from the team-mapping rules (FR-DAGX-08). */
  readonly team: string;
  /** Cron expression or preset such as `@hourly`. */
  readonly schedule: string;
  readonly maxActiveTasks: number;
  readonly maxActiveRuns: number;
  readonly catchup: boolean;
  readonly paused: boolean;
}

/** A task instance as seen in one live snapshot, waiting in `scheduled` or `queued`. */
export interface SnapshotTaskInstance {
  readonly dagId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly mapIndex: number;
  readonly tryNumber: number;
  readonly pool: string;
  readonly poolSlots: number;
  readonly priorityWeight: number;
  /** When the task instance entered its current state (first seen in it). */
  readonly since: number;
}

export interface PoolState {
  readonly name: string;
  readonly slots: number;
  /** Slots held by running task instances (`pool_slots` each). */
  readonly running: number;
  /** Slots held by queued task instances. */
  readonly queued: number;
  readonly open: number;
}

export interface LiveSnapshot {
  readonly at: number;
  /** Ready to run (upstream satisfied), not yet queued: pre-queue waiting. */
  readonly scheduled: readonly SnapshotTaskInstance[];
  /** Queued in the executor, not yet running: post-queue waiting. */
  readonly queued: readonly SnapshotTaskInstance[];
  readonly pools: readonly PoolState[];
  /** Running plus queued task instances per DAG (what `max_active_tasks` counts on Airflow 2). */
  readonly dagActive: Readonly<Record<string, number>>;
  readonly executor: { readonly running: number; readonly queued: number };
  readonly workers: { readonly current: number; readonly target: number };
}

/** One sample per minute of worker capacity and load. */
export interface WorkerSample {
  readonly at: number;
  readonly workers: number;
  /** Autoscaler target (`scale_factor_target`). */
  readonly target: number;
  readonly running: number;
  readonly queued: number;
  /** Highest worker CPU utilisation in the minute, 0–1. */
  readonly cpu: number;
  /** Highest worker memory utilisation in the minute, 0–1. */
  readonly memory: number;
}

/** Inputs of the HM-028 health checks; `null` means no data. */
export interface PlatformHealth {
  /** Share of the last 4 h the environment reported healthy, 0–1. */
  readonly envHealthyRatio: number | null;
  readonly dbHealthyRatio: number | null;
  readonly heartbeatCompleteness: number | null;
  readonly webServerHealthyRatio: number | null;
  /** Highest Cloud SQL CPU or memory utilisation over 12 h, 0–1. */
  readonly dbCpuMemoryMax: number | null;
  readonly zombies24h: number | null;
  readonly workerRestarts24h: number | null;
  readonly importErrors: number | null;
  readonly parseLoopP95Seconds: number | null;
}
