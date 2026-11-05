/**
 * Read-only sources of one monitored environment, as collectors need them. Adapters map the wire
 * formats (Airflow REST API v1, Composer API v1, Cloud Monitoring API v3) to these shapes, validate them
 * at the boundary, and throw {@link SourceError} for every failure. Times are epoch milliseconds.
 *
 * @implements FR-COLL-01, FR-COLL-08
 */

/** One page of a collection endpoint. */
export interface Page<T> {
  readonly items: readonly T[];
  /** `total_entries` as reported by the API for the whole query. */
  readonly total: number;
}

// ---- Airflow REST API v1 (Airflow 2), Appendix B -------------------------------------------------

export interface AirflowVersion {
  readonly version: string;
}

export interface AirflowHealth {
  /** `metadatabase.status`. */
  readonly metadatabase: 'healthy' | 'unhealthy' | null;
  readonly scheduler: {
    readonly status: 'healthy' | 'unhealthy' | null;
    readonly latestHeartbeat: number | null;
  };
}

export interface AirflowDag {
  readonly dagId: string;
  readonly fileloc: string;
  readonly owners: readonly string[];
  readonly tags: readonly string[];
  /** Cron expression or preset, a timedelta or timetable description, or `null` for unscheduled DAGs. */
  readonly schedule: string | null;
  readonly paused: boolean;
  readonly active: boolean;
  /** `null` when the API does not report it (the environment default applies). */
  readonly maxActiveTasks: number | null;
  readonly maxActiveRuns: number | null;
}

export interface AirflowPool {
  readonly name: string;
  readonly slots: number;
  readonly runningSlots: number;
  readonly queuedSlots: number;
  readonly openSlots: number;
  readonly scheduledSlots: number | null;
  readonly deferredSlots: number | null;
}

export interface AirflowTaskInstance {
  readonly dagId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly mapIndex: number;
  readonly tryNumber: number;
  readonly state: string | null;
  readonly pool: string;
  readonly poolSlots: number;
  readonly priorityWeight: number | null;
  readonly operator: string | null;
  readonly queue: string | null;
  readonly hostname: string | null;
  readonly queuedAt: number | null;
  readonly startAt: number | null;
  readonly endAt: number | null;
}

export interface TaskInstanceQuery {
  readonly states?: readonly string[];
  /** `updated_at_gte`, inclusive. */
  readonly updatedFrom?: number;
  /** `updated_at_lte`, inclusive. */
  readonly updatedTo?: number;
  /** Page size, at most 100 (Appendix B.1). */
  readonly limit: number;
  readonly offset: number;
}

/** The Airflow REST API of one environment. GET only; the guarded client enforces it. */
export interface AirflowApi {
  version(): Promise<AirflowVersion>;
  health(): Promise<AirflowHealth>;
  dags(page: { readonly limit: number; readonly offset: number }): Promise<Page<AirflowDag>>;
  pools(): Promise<readonly AirflowPool[]>;
  importErrorCount(): Promise<number>;
  taskInstances(query: TaskInstanceQuery): Promise<Page<AirflowTaskInstance>>;
  /**
   * Doctor privilege probe (§18.3): `true` when `GET /providers?limit=1` succeeds, which means the
   * identity has `Op` or higher; `false` on 403.
   */
  canReadProviders(): Promise<boolean>;
}

// ---- Composer API v1 ---------------------------------------------------------------------------------

export interface ComposerEnvironmentRef {
  readonly projectId: string;
  readonly location: string;
  readonly environment: string;
}

export interface ComposerEnvironment {
  /** `RUNNING`, `UPDATING`, `ERROR`, … as reported. */
  readonly state: string;
  readonly airflowUri: string | null;
  /** For example `composer-3-airflow-2.11.1-build.22`. */
  readonly imageVersion: string | null;
  /** `softwareConfig.airflowConfigOverrides`, keys like `core-parallelism`. */
  readonly airflowConfigOverrides: Readonly<Record<string, string>>;
  readonly worker: {
    readonly minCount: number | null;
    readonly maxCount: number | null;
    readonly cpu: number | null;
    readonly memoryGb: number | null;
  };
  readonly schedulerCount: number | null;
}

export interface ComposerApi {
  environment(ref: ComposerEnvironmentRef): Promise<ComposerEnvironment>;
}

// ---- Cloud Monitoring API v3 `timeSeries.list` ------------------------------------------------------

export type Aligner =
  | 'ALIGN_MAX'
  | 'ALIGN_MIN'
  | 'ALIGN_MEAN'
  | 'ALIGN_SUM'
  | 'ALIGN_DELTA'
  | 'ALIGN_RATE'
  | 'ALIGN_FRACTION_TRUE'
  | 'ALIGN_NEXT_OLDER';

export type Reducer = 'REDUCE_MAX' | 'REDUCE_MIN' | 'REDUCE_MEAN' | 'REDUCE_SUM' | 'REDUCE_COUNT';

export interface MetricQuery {
  readonly projectId: string;
  /** Full metric type, for example `composer.googleapis.com/environment/num_celery_workers`. */
  readonly metricType: string;
  readonly resourceType: string;
  /** Exact-match filters on `resource.labels.*`. */
  readonly resourceLabels: Readonly<Record<string, string>>;
  /** Exact-match filters on `metric.labels.*`. */
  readonly metricLabels?: Readonly<Record<string, string>>;
  readonly from: number;
  readonly to: number;
  readonly alignmentPeriodSeconds: number;
  readonly aligner: Aligner;
  readonly reducer?: Reducer;
  /** `aggregation.groupByFields`, for example `resource.labels.workload_name`. */
  readonly groupBy?: readonly string[];
}

export interface MetricSeries {
  readonly metricLabels: Readonly<Record<string, string>>;
  readonly resourceLabels: Readonly<Record<string, string>>;
  /** Oldest first; `at` is the end of each aligned interval. Booleans map to 0 and 1. */
  readonly points: ReadonlyArray<{ readonly at: number; readonly value: number }>;
}

export interface MonitoringApi {
  /** Every page of one `timeSeries.list` query (series budget: NFR-OBS-06 counts the series returned). */
  series(query: MetricQuery): Promise<readonly MetricSeries[]>;
}
