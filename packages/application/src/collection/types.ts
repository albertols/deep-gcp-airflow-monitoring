/**
 * The seam between the collection engine and the collectors (feature 002). The engine schedules
 * collectors, enforces budgets and records their health; a collector runs one cycle against budgeted
 * sources and writes what it found to the store.
 *
 * @implements FR-COLL-01
 */
import type {
  AirflowApi,
  CollectionStore,
  ComposerApi,
  EnvironmentEntry,
  MonitoringApi,
  ProfileCadences,
} from '@dcam/ports';
import type { SourceId } from '@dcam/contracts';

export type CollectorId = 'composer.config' | 'af.inventory' | 'af.live' | 'af.facts' | 'mon.core';
export type ApiId = 'airflow' | 'composer' | 'monitoring';

/** What a collector declares; the engine refuses one without a budget or an output (FR-COLL-01). */
export interface CollectorManifest {
  readonly id: CollectorId;
  readonly source: Exclude<SourceId, 'DEMO'>;
  readonly api: ApiId;
  /** Which profile cadence drives it. */
  readonly cadence: keyof ProfileCadences;
  /** Priority class (§7.11 item 2): live > standard > background; background work always yields. */
  readonly priority: 'live' | 'standard' | 'background';
  /** Most requests one cycle may make before it must stop and report reduced fidelity. */
  readonly maxRequestsPerCycle: number;
  /** What it writes; `config` covers `EnvironmentConfig` and `dags` covers `DagMeta`. */
  readonly outputs: ReadonlyArray<'config' | 'dags' | 'health' | 'snapshots' | 'samples' | 'tries'>;
  /** Source kinds it applies to; others show it as disabled. */
  readonly sourceKinds: ReadonlyArray<EnvironmentEntry['source']['kind']>;
}

/**
 * What the composition root provides per environment. The engine wraps every call with the budget,
 * the circuit breaker and the footprint before a collector sees it.
 */
export interface EnvironmentSources {
  readonly composer?: ComposerApi;
  readonly monitoring?: MonitoringApi;
  /** The Airflow API at a base URL: `airflowUri` from Composer, or the configured URL of a self-managed Airflow. */
  airflow(baseUrl: string): AirflowApi;
}

/** Facts one collector learns that others need in the same environment. */
export interface SharedEnvironmentState {
  /** Base URL of the Airflow web server, once known (`composer.config`, or the configuration). */
  airflowBaseUrl: string | null;
  /** Airflow version from `GET /version` or the image (FR-COLL-08). */
  airflowVersion: string | null;
  /** Composer image version, for the Composer generation (FR-COLL-09). */
  imageVersion: string | null;
}

export interface CollectorContext {
  readonly env: EnvironmentEntry;
  readonly now: () => number;
  readonly store: CollectionStore;
  /** Budgeted sources. A call that would exceed the budget throws {@link BudgetExhaustedError}. */
  readonly composer: ComposerApi | null;
  readonly monitoring: MonitoringApi | null;
  /** The budgeted Airflow API, or a `SourceError` (`not-found`/`unsupported`) until its base URL is known. */
  airflow(): AirflowApi;
  readonly shared: SharedEnvironmentState;
  /** Report that this cycle stopped early or skipped work to stay within budget (FR-COLL-06). */
  reducedFidelity(reason: string): void;
  /** Count Cloud Monitoring time series returned (NFR-OBS-06). */
  countSeries(n: number): void;
}

export interface CollectorResult {
  /** Time of the newest data the cycle committed (for the lag shown on the health page), if any. */
  readonly dataAsOf: number | null;
}

export interface Collector {
  readonly manifest: CollectorManifest;
  collect(ctx: CollectorContext): Promise<CollectorResult>;
}

/** Thrown by budgeted sources when the cycle may not make another request now. */
export class BudgetExhaustedError extends Error {
  override readonly name = 'BudgetExhaustedError';
  constructor(
    readonly api: ApiId,
    message = `The ${api} request budget is used up for now.`,
  ) {
    super(message);
  }
}
