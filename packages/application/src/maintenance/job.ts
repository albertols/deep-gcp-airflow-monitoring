/**
 * The maintenance job of the local store (spec §11.7 "Retention and tiering", §9.4).
 *
 * Schedule
 * - A retention run on start, then every {@link RETENTION_EVERY_MS} (24 h after the last one: it stands for
 *   the spec's "nightly", since a laptop is often asleep at night). In between, a budget check every
 *   {@link BUDGET_CHECK_EVERY_MS}, so a store that fills up during the day is handled within the hour.
 * - One run at a time: a request while a run is in progress joins it. `stop()` lets the batch in flight
 *   finish, starts no other and waits.
 *
 * Retention run (FR-STORE-02): for every environment with data (configured or not), every family is deleted
 * older than now minus its class's days, in batches of {@link MAINTENANCE_BATCH_ROWS} rows. Each batch is one
 * store call, one transaction on one table; the store's write queue runs the collectors' writes between
 * batches, so collection waits for at most one batch. Then CHECKPOINT, so the freed blocks count as free.
 *
 * Disk budget (FR-STORE-07), after every run: measure the store. At or above 90 % of the budget, warn, thin
 * live snapshots older than 24 h to one per 5 minutes, CHECKPOINT and measure again. While still at or above
 * 90 %, delete everything older than the end of the oldest data's day (UTC), all families, oldest first, never
 * the last {@link BUDGET_FLOOR_MS} (8 days), CHECKPOINT and measure.
 *
 * Crash safety (FR-STORE-06): every step is idempotent and every batch commits on its own, so a run cut short
 * (crash, error, stop) leaves whole batches done and the next run finishes the rest with the same result.
 *
 * @implements FR-STORE-02, FR-STORE-06, FR-STORE-07
 */
import type { Collection, CollectionEnvironment, CollectionStorage } from '@dcam/contracts';
import {
  BUDGET_FLOOR_MS,
  BYTES_PER_GB,
  DAY_MS,
  DISK_WARN_SHARE,
  THIN_AFTER_MS,
  THIN_BUCKET_MS,
  diskUsageState,
} from '@dcam/domain';
import {
  RETAINED_FAMILIES,
  type Clock,
  type RetentionStore,
  type Sleeper,
  type StorageUsage,
  type WorkspaceConfig,
} from '@dcam/ports';
import { DEFAULT_SNAPSHOT_CADENCE_MS } from '../bottlenecks';
import type { CollectionLogEntry } from '../collection/engine';
import { FAMILY_CLASS, effectiveRetention, workspaceRetention } from './policy';

export const RETENTION_EVERY_MS = DAY_MS;
export const BUDGET_CHECK_EVERY_MS = 3_600_000;
export const MAINTENANCE_BATCH_ROWS = 5_000;

export type MaintenanceKind = 'retention' | 'budget-check';

export interface MaintenanceDeps {
  readonly store: RetentionStore;
  readonly clock: Clock;
  readonly sleeper: Sleeper;
  readonly config: Pick<WorkspaceConfig, 'retention' | 'environments'>;
  readonly log?: (entry: CollectionLogEntry) => void;
}

export interface MaintenanceJob {
  /** Runs retention now, then on schedule. */
  start(): void;
  /** Lets the batch in flight finish, starts no other, and resolves when the job is idle. */
  stop(): Promise<void>;
  /** Runs once now; joins the run in progress if there is one. Never rejects: errors go to the status. */
  run(kind: MaintenanceKind): Promise<void>;
  status(): CollectionStorage;
  /** The days the environment's data is kept, for its collection status. */
  retention(envId: string): NonNullable<CollectionEnvironment['retention']>;
}

interface RunRecord {
  readonly kind: MaintenanceKind;
  readonly startedAt: number;
  finishedAt: number | null;
  deletedRows: number;
  thinnedSnapshots: number;
  error: string | null;
}

interface BudgetAction {
  readonly at: number;
  readonly thinnedBefore: number;
  deletedBefore: number | null;
  floorReached: boolean;
}

/** Thrown between batches once `stop()` was called. */
class Stopping extends Error {}

const iso = (ms: number) => new Date(ms).toISOString();
const gb = (bytes: number) => `${(bytes / BYTES_PER_GB).toFixed(2)} GB`;

export function createMaintenanceJob(deps: MaintenanceDeps): MaintenanceJob {
  const { store, clock, sleeper, config } = deps;
  const budgetBytes = Math.max(1, Math.round(workspaceRetention(config).diskBudgetGb * BYTES_PER_GB));
  const abort = new AbortController();
  let usage: { readonly value: StorageUsage; readonly at: number } | null = null;
  let lastRun: RunRecord | null = null;
  let action: BudgetAction | null = null;
  let nextRunAt: number | null = null;
  let current: Promise<void> | null = null;
  let loop: Promise<void> | null = null;
  let stopping = false;

  const log = (level: CollectionLogEntry['level'], message: string) => deps.log?.({ level, message });
  const check = () => {
    if (stopping) throw new Stopping();
  };

  /** Deletes the family's rows older than `before`, one batch per call, until none is left. */
  const drain = async (
    envId: string,
    family: (typeof RETAINED_FAMILIES)[number],
    before: number,
    r: RunRecord,
  ) => {
    for (;;) {
      check();
      const deleted = await store.deleteExpired(envId, family, before, MAINTENANCE_BATCH_ROWS);
      r.deletedRows += deleted;
      if (deleted < MAINTENANCE_BATCH_ROWS) return;
    }
  };

  const measure = async (): Promise<number> => {
    const value = await store.storageUsage();
    usage = { value, at: clock.now() };
    return value.usedBytes;
  };
  const over = (used: number) => diskUsageState(used, budgetBytes) === 'warning';

  const retain = async (envs: readonly string[], now: number, r: RunRecord) => {
    for (const envId of envs) {
      const days = effectiveRetention(config, envId);
      for (const family of RETAINED_FAMILIES)
        await drain(envId, family, now - days[FAMILY_CLASS[family]] * DAY_MS, r);
    }
    check();
    await store.checkpoint();
  };

  /** The oldest row that can expire, over every environment and family. */
  const oldestRow = async (envs: readonly string[]): Promise<number | null> => {
    let oldest: number | null = null;
    for (const envId of envs)
      for (const family of RETAINED_FAMILIES) {
        const t = await store.oldest(envId, family);
        if (t !== null && (oldest === null || t < oldest)) oldest = t;
      }
    return oldest;
  };

  const enforceBudget = async (envs: readonly string[], now: number, r: RunRecord) => {
    let used = await measure();
    if (!over(used)) return;
    log(
      'warn',
      `DCAM's store uses ${gb(used)} of its ${gb(budgetBytes)} disk budget, ${Math.round((used / budgetBytes) * 100)} %. ` +
        'DCAM thins live snapshots older than 24 h to one per 5 minutes, then deletes the oldest data. ' +
        'To keep more history, raise retention.diskBudgetGb in dcam.config.yaml.',
    );
    const thinnedBefore = Math.floor((now - THIN_AFTER_MS) / THIN_BUCKET_MS) * THIN_BUCKET_MS;
    const options = {
      before: thinnedBefore,
      bucketMs: THIN_BUCKET_MS,
      fallbackCadenceMs: DEFAULT_SNAPSHOT_CADENCE_MS,
    };
    for (const envId of envs)
      for (;;) {
        check();
        const thinned = await store.thinSnapshots(envId, options);
        r.thinnedSnapshots += thinned.dropped;
        if (thinned.done) break;
      }
    const act: BudgetAction = {
      at: now,
      thinnedBefore,
      deletedBefore: action?.deletedBefore ?? null,
      floorReached: false,
    };
    action = act;
    check();
    await store.checkpoint();
    used = await measure();

    const floor = now - BUDGET_FLOOR_MS;
    while (over(used)) {
      check();
      const oldest = await oldestRow(envs);
      if (oldest === null || oldest >= floor) {
        act.floorReached = true;
        log(
          'error',
          `DCAM's store is still above ${Math.round(DISK_WARN_SHARE * 100)} % of its disk budget with only the last 8 days left, which DCAM keeps. ` +
            'Raise retention.diskBudgetGb or lower retention.rawMetricPointsDays in dcam.config.yaml.',
        );
        return;
      }
      const before = Math.min(Math.floor(oldest / DAY_MS) * DAY_MS + DAY_MS, floor);
      for (const envId of envs) for (const family of RETAINED_FAMILIES) await drain(envId, family, before, r);
      act.deletedBefore = Math.max(act.deletedBefore ?? before, before);
      check();
      await store.checkpoint();
      used = await measure();
    }
  };

  const run = (kind: MaintenanceKind): Promise<void> => {
    if (current) return current;
    const r: RunRecord = {
      kind,
      startedAt: clock.now(),
      finishedAt: null,
      deletedRows: 0,
      thinnedSnapshots: 0,
      error: null,
    };
    lastRun = r;
    current = (async () => {
      try {
        const envs = await store.retainedEnvironments();
        if (kind === 'retention') await retain(envs, r.startedAt, r);
        await enforceBudget(envs, r.startedAt, r);
      } catch (error) {
        if (!(error instanceof Stopping)) {
          r.error = error instanceof Error ? error.message : String(error);
          log('error', `Store maintenance stopped early (${r.error}); the next run resumes it.`);
        }
      } finally {
        r.finishedAt = clock.now();
        current = null;
      }
    })();
    return current;
  };

  return {
    start() {
      if (loop || stopping) return;
      loop = (async () => {
        let nextRetention = clock.now();
        while (!stopping) {
          const startedAt = clock.now();
          const kind: MaintenanceKind = startedAt >= nextRetention ? 'retention' : 'budget-check';
          if (kind === 'retention') nextRetention = startedAt + RETENTION_EVERY_MS;
          await run(kind);
          if (stopping) break;
          nextRunAt = Math.min(nextRetention, clock.now() + BUDGET_CHECK_EVERY_MS);
          await sleeper.sleep(Math.max(0, nextRunAt - clock.now()), abort.signal);
        }
        nextRunAt = null;
      })();
    },
    async stop() {
      stopping = true;
      abort.abort();
      await loop;
      await current;
    },
    run,
    status() {
      const measured = usage;
      return {
        measured_at: measured ? iso(measured.at) : null,
        file_bytes: measured ? Math.round(measured.value.fileBytes) : null,
        used_bytes: measured ? Math.round(measured.value.usedBytes) : null,
        budget_bytes: budgetBytes,
        warn_share: DISK_WARN_SHARE,
        state: measured ? diskUsageState(measured.value.usedBytes, budgetBytes) : 'unknown',
        last_run: lastRun && {
          kind: lastRun.kind,
          started_at: iso(lastRun.startedAt),
          finished_at: lastRun.finishedAt === null ? null : iso(lastRun.finishedAt),
          deleted_rows: lastRun.deletedRows,
          thinned_snapshots: lastRun.thinnedSnapshots,
          error: lastRun.error,
        },
        next_run_at: nextRunAt === null ? null : iso(nextRunAt),
        budget_action: action && {
          at: iso(action.at),
          thinned_before: iso(action.thinnedBefore),
          deleted_before: action.deletedBefore === null ? null : iso(action.deletedBefore),
          floor_reached: action.floorReached,
        },
      };
    },
    retention(envId) {
      const days = effectiveRetention(config, envId);
      return {
        raw_task_instances_days: days.rawTaskInstancesDays,
        raw_metric_points_days: days.rawMetricPointsDays,
      };
    },
  };
}

/** The collection status with the store's status and each environment's retention (live mode). */
export function withMaintenance(collection: Collection, job: MaintenanceJob): Collection {
  return {
    ...collection,
    storage: job.status(),
    environments: collection.environments.map((e) => ({ ...e, retention: job.retention(e.env_id) })),
  };
}
