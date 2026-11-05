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
  /** Source `updated_at`, used as the incremental watermark (FR-COLL-03). */
  readonly sourceUpdatedAt: number | null;
}

/** Fact storage for task instance tries (spec §11.7). Upserts are idempotent on the natural key. */
export interface TaskInstanceStore {
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
