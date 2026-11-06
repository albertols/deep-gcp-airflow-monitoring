/**
 * Mapping from source shapes (ports) to the domain model, so live data means the same as demo data
 * (`packages/adapters/fakes`) and every page works unchanged.
 *
 * @implements FR-COLL-08, FR-COLL-09, FR-DAGX-08 (default team rule until the mapping rules land)
 */
import {
  UNKNOWN_LIMIT,
  type DagMeta,
  type EnvironmentConfig,
  type LimitKey,
  type LimitSource,
  type PoolConfig,
} from '@dcam/domain';
import {
  SourceError,
  type AirflowDag,
  type AirflowTaskInstance,
  type ComposerEnvironment,
  type EnvironmentEntry,
  type StaticLimits,
  type StoredTaskTry,
  type TryKey,
} from '@dcam/ports';
import type { CollectorContext } from '../types';

/**
 * Composer defaults where Composer overrides Airflow's: `core.max_active_tasks_per_dag` 16 and
 * `core.max_active_runs_per_dag` 25 (spec Appendix D L5184–L5185; Composer 3 "Optimize environment
 * performance and costs", #override-dag-concurrency and #override-max-active-runs,
 * https://docs.cloud.google.com/composer/docs/composer-3/optimize-environments, checked 2026-11-05).
 * Airflow 2.11.1's own defaults are 16 and 16
 * (https://airflow.apache.org/docs/apache-airflow/2.11.1/configurations-ref.html).
 */
export const COMPOSER_DEFAULT_MAX_ACTIVE_TASKS_PER_DAG = 16;
export const COMPOSER_DEFAULT_MAX_ACTIVE_RUNS_PER_DAG = 25;

/**
 * `[scheduler] catchup_by_default` is `True` on Airflow 2.11.1 (configuration reference above; Composer
 * does not change it, spec Appendix D). `GET /dags` does not return `catchup` (only `DAGDetail` has it,
 * `airflow/api_connexion/openapi/v1.yaml` at 2.11.1), so a DAG's own setting is unknown until the
 * details refresh lands; the documented default stands in.
 */
export const CATCHUP_BY_DEFAULT = true;

/** Airflow's default `priority_weight` of a task (BaseOperator, Airflow 2.11.1). */
const DEFAULT_PRIORITY_WEIGHT = 1;
/** Team of DAGs that no rule assigns (spec §17.2 `teams.mapping` example). */
export const UNASSIGNED = 'unassigned';
/** Airflow's default `owner` (`[operators] default_owner`), which names no team. */
const AIRFLOW_DEFAULT_OWNER = 'airflow';

export interface ImageVersion {
  /** Composer generation: 2 or 3. */
  readonly generation: number;
  readonly airflowVersion: string;
}

/**
 * Composer image versions: `composer-3-airflow-2.11.1-build.22` (Composer 3) and
 * `composer-2.9.7-airflow-2.9.3` (Composer 2), as listed on the Composer versions page
 * (https://docs.cloud.google.com/composer/docs/composer-versions).
 */
export function parseImageVersion(image: string): ImageVersion | null {
  const m = /^composer-(\d+)(?:\.\d+)*-airflow-(\d+\.\d+\.\d+)(?:-build\.\d+)?$/.exec(image.trim());
  if (!m) return null;
  return { generation: Number(m[1]), airflowVersion: m[2] as string };
}

/** Airflow 3 needs the REST API v2 adapter, planned for M4 (FR-COLL-08). */
export function assertAirflow2(version: string | null): void {
  if (version !== null && Number(version.split('.')[0]) >= 3)
    throw new SourceError('unsupported', 'Airflow 3 environments are supported from M4', {
      fixHint:
        'DCAM M1 reads Airflow 2 environments only. Track the Airflow 3 adapter in the roadmap (spec §22.2).',
    });
}

/** Refuses Airflow 3 once any collector has learned the version (FR-COLL-08). */
export const assertSupported = (ctx: CollectorContext) => assertAirflow2(ctx.shared.airflowVersion);

/**
 * `[core] parallelism` 0 is no limit: "Setting this value to zero allows unlimited parallelism" (Airflow
 * 2.11.1 configuration reference, https://airflow.apache.org/docs/apache-airflow/2.11.1/configurations-ref.html,
 * generated from `airflow/config_templates/config.yml`, checked at tag 2.11.1 on 2026-11-07). DCAM has
 * no "unlimited" limit source, so such an override counts as unknown: no signal treats it as binding,
 * and the workers' slots bound the work instead.
 */
const UNLIMITED_AT_ZERO: ReadonlySet<string> = new Set(['core-parallelism']);

/** A non-negative integer override such as `core-parallelism: "48"`, or `null`. */
function intOverride(overrides: Readonly<Record<string, string>>, key: string): number | null {
  const raw = overrides[key];
  if (raw === undefined || !/^\s*\d+\s*$/.test(raw)) return null;
  return Number(raw);
}

/**
 * The limits of a Composer environment. The Composer API returns overrides only (spec §2.3 L228), keyed
 * `section-option` (https://docs.cloud.google.com/composer/docs/composer-3/override-airflow-configurations).
 * Composer documents no default for `core.parallelism`, and on Composer 3 `celery.worker_concurrency`
 * is calculated from the worker resources with an unpublished formula (spec L221, L3081, L3084): without
 * an override both are {@link UNKNOWN_LIMIT} and marked `unknown`, so no signal treats them as binding.
 */
export function configFromComposer(
  entry: EnvironmentEntry,
  env: ComposerEnvironment,
  pools: readonly PoolConfig[],
  airflowVersion: string,
): EnvironmentConfig {
  const o = env.airflowConfigOverrides;
  const sources: Partial<Record<LimitKey, LimitSource>> = {};
  const pick = (key: LimitKey, override: string, fallback: number, source: LimitSource) => {
    const raw = intOverride(o, override);
    const v = raw === 0 && UNLIMITED_AT_ZERO.has(override) ? null : raw;
    sources[key] = v === null ? source : 'override';
    return v ?? fallback;
  };
  const parallelism = pick('parallelism', 'core-parallelism', UNKNOWN_LIMIT, 'unknown');
  const workerConcurrency = pick('workerConcurrency', 'celery-worker_concurrency', UNKNOWN_LIMIT, 'unknown');
  const maxActiveTasksPerDag = pick(
    'maxActiveTasksPerDag',
    'core-max_active_tasks_per_dag',
    COMPOSER_DEFAULT_MAX_ACTIVE_TASKS_PER_DAG,
    'composer-default',
  );
  const maxActiveRunsPerDag = pick(
    'maxActiveRunsPerDag',
    'core-max_active_runs_per_dag',
    COMPOSER_DEFAULT_MAX_ACTIVE_RUNS_PER_DAG,
    'composer-default',
  );
  const minWorkers = env.worker.minCount ?? 1;
  return {
    envId: entry.id,
    tier: entry.tier,
    composerImage: env.imageVersion ?? 'unknown',
    airflowVersion,
    parallelism,
    // ⚠️ VERIFY: Composer 2 and 3 always report `workloadsConfig.scheduler.count`; 1 stands in if absent.
    schedulers: env.schedulerCount ?? 1,
    maxActiveTasksPerDag,
    maxActiveRunsPerDag,
    workerConcurrency,
    minWorkers,
    maxWorkers: Math.max(minWorkers, env.worker.maxCount ?? minWorkers),
    pools: [...pools],
    limitSources: sources,
  };
}

/** The limits of a self-managed Airflow (the emulator), from `limits` in the configuration file. */
export function configFromLimits(
  entry: EnvironmentEntry & { readonly source: { readonly limits: StaticLimits } },
  pools: readonly PoolConfig[],
  airflowVersion: string | null,
): EnvironmentConfig {
  const l = entry.source.limits;
  return {
    envId: entry.id,
    tier: entry.tier,
    composerImage: 'none (self-managed Airflow)',
    airflowVersion: airflowVersion ?? 'unknown',
    parallelism: l.parallelism,
    schedulers: l.schedulers,
    maxActiveTasksPerDag: l.maxActiveTasksPerDag,
    maxActiveRunsPerDag: l.maxActiveRunsPerDag,
    workerConcurrency: l.workerConcurrency,
    minWorkers: l.workers,
    maxWorkers: l.workers,
    pools: [...pools],
    limitSources: {
      parallelism: 'configured',
      workerConcurrency: 'configured',
      maxActiveTasksPerDag: 'configured',
      maxActiveRunsPerDag: 'configured',
    },
  };
}

/**
 * The team of a DAG until the FR-DAGX-08 mapping rules arrive (M2): a `team:<name>` tag as in demo
 * mode, else the first owner other than Airflow's default `airflow`, else `unassigned`.
 */
export function teamOf(dag: Pick<AirflowDag, 'tags' | 'owners'>): string {
  const tag = dag.tags.find((t) => t.startsWith('team:') && t.length > 'team:'.length);
  if (tag) return tag.slice('team:'.length);
  const owner = dag.owners.find((o) => o.trim() !== '' && o !== AIRFLOW_DEFAULT_OWNER);
  return owner ?? UNASSIGNED;
}

/**
 * DAG metadata as the signals read it. An unscheduled DAG (`schedule_interval` null) becomes `None`,
 * Airflow's own spelling, which schedule parsing (HM-009) counts as "no fixed start minute".
 */
export function dagMetaOf(
  d: AirflowDag,
  defaults: Pick<EnvironmentConfig, 'maxActiveTasksPerDag' | 'maxActiveRunsPerDag'>,
): DagMeta {
  return {
    dagId: d.dagId,
    fileloc: d.fileloc,
    owners: [...d.owners],
    tags: [...d.tags],
    team: teamOf(d),
    schedule: d.schedule ?? 'None',
    maxActiveTasks: d.maxActiveTasks ?? defaults.maxActiveTasksPerDag,
    maxActiveRuns: d.maxActiveRuns ?? defaults.maxActiveRunsPerDag,
    catchup: CATCHUP_BY_DEFAULT,
    paused: d.paused,
  };
}

export const tryKeyOf = (t: TryKey): TryKey => ({
  dagId: t.dagId,
  runId: t.runId,
  taskId: t.taskId,
  mapIndex: t.mapIndex,
  tryNumber: t.tryNumber,
});

export const keyString = (t: TryKey) =>
  `${t.dagId}\u0000${t.runId}\u0000${t.taskId}\u0000${t.mapIndex}\u0000${t.tryNumber}`;

/**
 * A task instance row as a stored try. `readyAt` is left to the store, which fills it from the ready
 * times `af.live` recorded (HM-001, HM-006). `sourceUpdatedAt` is `null`: the Airflow 2.11.1 API v1
 * task instance has no `updated_at` field, although the list filters on it (`updated_at_gte`,
 * `updated_at_lte`). Checked 2026-11-07 in `components.schemas.TaskInstance` of
 * `airflow/api_connexion/openapi/v1.yaml` and `TaskInstanceSchema` of
 * `airflow/api_connexion/schemas/task_instance_schema.py`, both at tag 2.11.1
 * (https://github.com/apache/airflow/blob/2.11.1/airflow/api_connexion/openapi/v1.yaml). The try's end
 * or start is not its `updated_at` (marking a task again changes only the latter), so DCAM does not
 * pretend it is; `af.facts` keeps its watermark per collector (`commitFacts`).
 */
export function storedTryOf(envId: string, t: AirflowTaskInstance): StoredTaskTry {
  return {
    envId,
    ...tryKeyOf(t),
    pool: t.pool,
    poolSlots: t.poolSlots,
    startAt: t.startAt,
    endAt: t.endAt,
    state: t.state,
    queuedAt: t.queuedAt,
    readyAt: null,
    operator: t.operator,
    sourceUpdatedAt: null,
  };
}

export const priorityOf = (t: AirflowTaskInstance) => t.priorityWeight ?? DEFAULT_PRIORITY_WEIGHT;
