/**
 * What the maintenance job does to DCAM's own store (spec §11.7 "Retention and tiering"): delete expired
 * rows, thin live snapshots, checkpoint and measure. Nothing here reaches a monitored system.
 *
 * @implements FR-STORE-02, FR-STORE-06, FR-STORE-07
 */

/**
 * Time series that retention deletes by age. Task tries are of the raw task instance class; first-seen ready
 * times, live snapshots and worker samples of the raw metric point class (spec §9.4 FR-STORE-02).
 */
export type RetainedFamily = 'task-tries' | 'ready-times' | 'snapshots' | 'worker-samples';

export const RETAINED_FAMILIES: readonly RetainedFamily[] = [
  'task-tries',
  'ready-times',
  'snapshots',
  'worker-samples',
];

export interface StorageUsage {
  /** Database file plus its write-ahead log on disk, in bytes. */
  readonly fileBytes: number;
  /**
   * Bytes of database blocks that hold data, plus the write-ahead log: what deleting reduces. Freed blocks
   * are reused before the file grows, so the file itself keeps its size.
   */
  readonly usedBytes: number;
}

/** How far back an environment's data of one family is complete. */
export interface RetentionHorizon {
  /** Rows older than this were deleted, by retention or by the disk budget; `null` when none were. */
  readonly deletedBefore: number | null;
  /** Snapshots older than this are thinned to one per 5 minutes; `null` when none are. */
  readonly thinnedBefore: number | null;
}

export interface ThinOptions {
  /** Snapshots older than this are thinned; it is rounded down to a bucket boundary. */
  readonly before: number;
  readonly bucketMs: number;
  /** The `af.live` cadence to assume where fewer than two raw snapshots show it. */
  readonly fallbackCadenceMs: number;
}

export interface ThinResult {
  /** Snapshots deleted by this call. */
  readonly dropped: number;
  /** `true` when no snapshot older than `before` is left to thin. */
  readonly done: boolean;
}

export interface RetentionStore {
  /** Environments with rows in any retained family, including environments no longer configured. */
  retainedEnvironments(): Promise<string[]>;
  /** Time of the oldest row of the family for the environment that could expire; `null` when none. */
  oldest(envId: string, family: RetainedFamily): Promise<number | null>;
  /**
   * Deletes at most `limit` rows of the family older than `before` for one environment, in one transaction
   * that also records `before` as the family's horizon, and returns how many it deleted: fewer than `limit`
   * means none is left. A task try is as old as its end; open tries (started, no end) are never deleted.
   */
  deleteExpired(envId: string, family: RetainedFamily, before: number, limit: number): Promise<number>;
  /**
   * Thins one environment's snapshots older than `options.before` to one per bucket (domain
   * `thinSnapshots`): at most one day of snapshots per call, oldest first, in one transaction.
   */
  thinSnapshots(envId: string, options: ThinOptions): Promise<ThinResult>;
  horizon(envId: string, family: RetainedFamily): Promise<RetentionHorizon>;
  /** Moves the write-ahead log into the database file, so the blocks that deletes freed count as free. */
  checkpoint(): Promise<void>;
  storageUsage(): Promise<StorageUsage>;
}
