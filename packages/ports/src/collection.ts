/**
 * Ports for live collection (feature 002): what collectors persist, and the timer they wait on.
 *
 * @implements FR-COLL-03, FR-STORE-01, FR-STORE-06
 */
import type { DagMeta, EnvironmentConfig, PlatformHealth, WorkerSample } from '@dcam/domain';
import type { EnvironmentModelSource, StoredLiveSnapshot, TaskInstanceStore } from './store';

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
  saveDags(envId: string, dags: readonly DagMeta[]): Promise<void>;
  savePlatformHealth(envId: string, health: PlatformHealth): Promise<void>;
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
  /** Deletes snapshots and samples older than `before` (raw retention). */
  prune(before: number): Promise<void>;
}

/** Waiting between collection cycles; tests inject a fake that advances a fake clock. */
export interface Sleeper {
  /** Resolves after `ms`, or early (without throwing) when `signal` aborts. */
  sleep(
    ms: number,
    signal?: { readonly aborted: boolean; addEventListener(type: 'abort', fn: () => void): void },
  ): Promise<void>;
}
