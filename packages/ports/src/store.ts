import type {
  DagMeta,
  EnvironmentConfig,
  LiveSnapshot,
  PlatformHealth,
  TaskTry,
  WorkerSample,
} from '@dcam/domain';

/** Injectable clock (spec §11.13): every computation takes "now" from here. */
export interface Clock {
  now(): number;
}

/** A task instance try as stored, with its environment and source watermark. */
export interface StoredTaskTry extends TaskTry {
  readonly envId: string;
  readonly state: string | null;
  readonly queuedAt: number | null;
  /**
   * When the try became ready to run (first seen `scheduled`). Airflow 2.11 does not record it, so it
   * comes from live snapshots and is `null` for history older than DCAM's own collection (HM-006).
   */
  readonly readyAt: number | null;
  /** Operator class name, for example `PythonOperator` (sensor detection, HM-008). */
  readonly operator: string | null;
  /**
   * Source `updated_at`, used as the incremental watermark (FR-COLL-03); `null` when the source does not
   * return it (the Airflow 2 API v1 task instance has no such field).
   */
  readonly sourceUpdatedAt: number | null;
  /**
   * When DCAM last saw the try running (the time of an `af.live` snapshot that listed it): the earliest its
   * end can be. Absent or `null` for tries read finished.
   */
  readonly seenRunningAt?: number | null;
  /**
   * `true` when `endAt` is DCAM's estimate, not the source's: the try stopped showing as running (or a later
   * try of its task instance appeared) before its finished row was read. The finished row replaces it
   * (FR-COLL-03, HM-003). Absent means `false`.
   */
  readonly endEstimated?: boolean;
}

/**
 * How much of the non-terminal task instances a live snapshot read. Spec §7.5: "when a state has more rows
 * than the page budget allows, the rows read are a sample and are labelled as such".
 */
export interface SnapshotCoverage {
  /** Task instance tries read. */
  readonly read: number;
  /** Task instances in the states read, from `total_entries`; `null` when a page could not be read. */
  readonly total: number | null;
  /** `true` when every non-terminal task instance was read; otherwise the snapshot is a sample. */
  readonly complete: boolean;
}

/** A live snapshot as collected and stored. `coverage` is absent on demo snapshots, which are complete. */
export interface StoredLiveSnapshot extends LiveSnapshot {
  readonly coverage?: SnapshotCoverage;
}

/** Fact storage for task instance tries (spec §11.7). Upserts are idempotent on the natural key. */
export interface TaskInstanceStore {
  /**
   * Upserts on the natural key; when a batch repeats a key, a row with a true end wins, else the last row.
   * A row without `endAt` never replaces a stored try whose end is true (not estimated): a running row read
   * before the try finished must not undo its finished row. Afterwards, a stored try still open while a
   * later try of its task instance exists ends at that try's earliest known time (ready, queued or
   * start), estimated: a failed try rescheduled before its own row was read would otherwise run forever.
   * A row without `readyAt` takes the recorded first-seen ready time, else keeps the stored one.
   */
  upsertTaskTries(rows: readonly StoredTaskTry[]): Promise<void>;
  /** Tries of one environment whose running interval overlaps [from, to), or that are still running. */
  taskTries(envId: string, from: number, to: number): Promise<StoredTaskTry[]>;
  countTaskTries(envId: string): Promise<number>;
}

/**
 * Everything about an environment besides task tries: configuration, DAG metadata, live snapshots of
 * waiting work, worker samples and platform-health inputs. The demo serves it from the simulator; M1
 * fills it from the `composer.config`, `af.inventory`, `af.live` and `mon.core` collectors.
 */
export interface EnvironmentModelSource {
  config(envId: string): Promise<EnvironmentConfig | null>;
  dags(envId: string): Promise<DagMeta[]>;
  /** Snapshots with `from <= at < to`, oldest first. */
  snapshots(envId: string, from: number, to: number): Promise<LiveSnapshot[]>;
  /** Samples with `from <= at < to`, oldest first. */
  workerSamples(envId: string, from: number, to: number): Promise<WorkerSample[]>;
  platformHealth(envId: string): Promise<PlatformHealth>;
}
