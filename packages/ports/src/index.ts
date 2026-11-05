import type { TaskTry } from '@dcam/domain';

/** Injectable clock (spec §11.13): every computation takes "now" from here. */
export interface Clock {
  now(): number;
}

/** A task instance try as stored, with its environment and source watermark. */
export interface StoredTaskTry extends TaskTry {
  readonly envId: string;
  readonly state: string | null;
  readonly queuedAt: number | null;
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
