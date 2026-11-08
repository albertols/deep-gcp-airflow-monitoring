/**
 * Ports for live collection (feature 002): what collectors persist, and the timer they wait on. Backfill
 * progress (feature 004).
 *
 * @implements FR-COLL-03, FR-COLL-04, FR-STORE-01, FR-STORE-06
 */
import type { DagMeta, EnvironmentConfig, PlatformHealth, WorkerSample } from '@dcam/domain';
import type { EnvironmentModelSource, StoredLiveSnapshot, StoredTaskTry, TaskInstanceStore } from './store';

/** Identity of one task instance try (the natural key of the task-instance fact table). */
export interface TryKey {
  readonly dagId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly mapIndex: number;
  readonly tryNumber: number;
}

/**
 * Everything live collection writes, persisted in DuckDB. It also serves the pages: it is the live
 * workspace's {@link TaskInstanceStore} and {@link EnvironmentModelSource}.
 */
export interface CollectionStore extends TaskInstanceStore, EnvironmentModelSource {
  saveConfig(envId: string, config: EnvironmentConfig): Promise<void>;
  /** Upserts by DAG id; DAGs missing from `dags` are kept, so an inventory may be saved page by page. */
  saveDags(envId: string, dags: readonly DagMeta[]): Promise<void>;
  /**
   * Replaces the environment's DAG set with `dags` in one transaction: a complete inventory pass, after
   * which deleted and inactive DAGs drop out.
   */
  replaceDags(envId: string, dags: readonly DagMeta[]): Promise<void>;
  /** Replaces the whole record. Collectors patch theirs instead ({@link patchPlatformHealth}). */
  savePlatformHealth(envId: string, health: PlatformHealth): Promise<void>;
  /**
   * Writes only the inputs given in `patch` (a key left out, or `undefined`, is kept; `null` means no data),
   * in one transaction. Collectors own different inputs (import errors from the Airflow API, the rest from
   * Cloud Monitoring) and run concurrently: reading the record and saving it whole lets one cycle undo
   * another's write (HM-028).
   */
  patchPlatformHealth(envId: string, patch: Partial<PlatformHealth>): Promise<void>;
  /** Stores the snapshot with its coverage, so that history tells a sample from a complete snapshot. */
  saveSnapshot(envId: string, snapshot: StoredLiveSnapshot): Promise<void>;
  /** Snapshots with `from <= at < to`, oldest first, with the coverage they were stored with. */
  snapshots(envId: string, from: number, to: number): Promise<StoredLiveSnapshot[]>;
  /** Upserts by `at` (one sample per minute; a re-read trailing window replaces its points). */
  saveWorkerSamples(envId: string, samples: readonly WorkerSample[]): Promise<void>;
  /**
   * `running` is every try running at `at`, from a live snapshot that read all of them. Every other stored
   * try of the environment still open in state `running` has finished: it ends when DCAM last saw it
   * running (`seenRunningAt`, else `at`), estimated and with state `null`, until `af.facts` stores its
   * finished row (FR-COLL-03, HM-003).
   */
  closeRunningTries(envId: string, running: readonly TryKey[], at: number): Promise<void>;
  /**
   * Records when tries were first seen ready (`scheduled`), keeping the earliest time per try. Tries
   * stored later get this as `readyAt` (Airflow 2.11 records no scheduled timestamp, HM-001/HM-006).
   */
  recordReady(envId: string, keys: readonly TryKey[], at: number): Promise<void>;
  /** The persisted watermark of a collector, or `null` before its first committed cycle (FR-COLL-03). */
  watermark(envId: string, collectorId: string): Promise<number | null>;
  /** Commits the facts of one cycle and its watermark in one transaction (FR-STORE-06). */
  commitFacts(
    envId: string,
    collectorId: string,
    tries: Parameters<TaskInstanceStore['upsertTaskTries']>[0],
    watermark: number,
  ): Promise<void>;
  /** The persisted plan and progress of a backfill, or `null` before it started (FR-COLL-04). */
  backfill(envId: string, collectorId: string): Promise<BackfillProgress | null>;
  /**
   * Commits the rows of one backfill cycle and its progress in one transaction (FR-STORE-06): tries upsert on
   * their natural key as {@link TaskInstanceStore.upsertTaskTries} does, samples by minute.
   */
  commitBackfill(
    envId: string,
    collectorId: string,
    progress: BackfillProgress,
    rows: BackfillRows,
  ): Promise<void>;
  /** Deletes snapshots and samples older than `before` (raw retention). */
  prune(before: number): Promise<void>;
}

/**
 * The plan and progress of one backfill on first add (FR-COLL-04), persisted so that a restart resumes it
 * (FR-COLL-03). A backfill reads `[from, to]` newest first; times are epoch milliseconds.
 */
export interface BackfillProgress {
  /** Where live collection starts: the backfill reads history up to here. */
  readonly to: number;
  /** The oldest time it reads back to: `to` minus the configured days. */
  readonly from: number;
  /** History is complete from here to `to`; `to` until the first window has been read. */
  readonly coveredFrom: number;
  /** Rows stored: task instance tries or worker samples. */
  readonly itemsRead: number;
  readonly requestsUsed: number;
  readonly startedAt: number;
  /** When `coveredFrom` reached `from`; `null` while the backfill runs. */
  readonly completedAt: number | null;
}

/** The rows of one backfill cycle. */
export interface BackfillRows {
  readonly tries?: readonly StoredTaskTry[];
  readonly samples?: readonly WorkerSample[];
}

/** Waiting between collection cycles; tests inject a fake that advances a fake clock. */
export interface Sleeper {
  /** Resolves after `ms`, or early (without throwing) when `signal` aborts. */
  sleep(
    ms: number,
    signal?: { readonly aborted: boolean; addEventListener(type: 'abort', fn: () => void): void },
  ): Promise<void>;
}
