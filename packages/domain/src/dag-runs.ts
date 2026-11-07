/**
 * DAG runs and task instances reconstructed from task instance tries: the shared basis of the league
 * table and DAG detail signals. Pure functions; times are epoch milliseconds.
 *
 * @implements FR-DAGX-02 (runs, failed runs), HM-015 (task instance outcomes)
 */
import type { SweepWindow, TaskTry } from './occupancy';

/**
 * A task instance try with the timestamps the DAG signals need. `StoredTaskTry` from the ports is
 * structurally compatible.
 */
export interface DagTaskTry extends TaskTry {
  /** Airflow task instance state of this try, for example `success`, `failed` or `running`. */
  readonly state: string | null;
  /** When the try was queued for the executor (`queued_dttm`). */
  readonly queuedAt: number | null;
  /** When the try became ready to run (first seen `scheduled`); `null` before DCAM observed it. */
  readonly readyAt: number | null;
}

export type RunState = 'success' | 'failed' | 'running';

/**
 * Try states that count as a failed attempt. ⚠️ VERIFY in M1: which state the Airflow REST API reports
 * for an earlier, retried try (`failed` in task instance history, `up_for_retry` on the live row).
 */
const FAILED_TRY_STATES: ReadonlySet<string> = new Set(['failed', 'up_for_retry']);
/** Final task instance states that make the DAG run fail. */
const FAILED_FINAL_STATES: ReadonlySet<string> = new Set(['failed', 'upstream_failed']);

export const isFailedTry = (t: Pick<DagTaskTry, 'state'>) =>
  t.state !== null && FAILED_TRY_STATES.has(t.state);

export const runKey = (dagId: string, runId: string) => `${dagId}\u0000${runId}`;
export const taskInstanceKey = (t: Pick<TaskTry, 'dagId' | 'runId' | 'taskId' | 'mapIndex'>) =>
  `${t.dagId}\u0000${t.runId}\u0000${t.taskId}\u0000${t.mapIndex}`;

/** True when the try started inside `[from, to)`: how tries, runs and task instances are assigned to a window. */
export const startedIn = (t: TaskTry, w: Pick<SweepWindow, 'from' | 'to'>) =>
  t.startAt !== null && t.startAt >= w.from && t.startAt < w.to;

export function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = groups.get(k);
    if (list) list.push(item);
    else groups.set(k, [item]);
  }
  return groups;
}

/** The latest try of each task instance among the given tries. */
export function finalTries<T extends DagTaskTry>(tries: readonly T[]): T[] {
  const latest = new Map<string, T>();
  for (const t of tries) {
    const k = taskInstanceKey(t);
    const seen = latest.get(k);
    if (!seen || t.tryNumber > seen.tryNumber) latest.set(k, t);
  }
  return [...latest.values()];
}

export interface RunSummary {
  readonly dagId: string;
  readonly runId: string;
  readonly state: RunState;
  /** First try start of the run. */
  readonly startAt: number;
  /** Last try end; `null` while the run is running. */
  readonly endAt: number | null;
  /** `endAt − startAt` in seconds; `null` while running. */
  readonly durationSeconds: number | null;
  readonly tries: number;
}

export interface RunOptions {
  /**
   * Runs that still have work waiting (for example task instances in the latest live snapshot): a run
   * whose tries have all ended may still be between tasks.
   */
  readonly inProgress?: (dagId: string, runId: string) => boolean;
}

/**
 * One run from all its tries. Running while a try has not ended or work is waiting; otherwise failed
 * when the latest try of some task instance failed, else successful. ⚠️ M1 takes the run state from the
 * DAG runs collector; this derivation cannot see a retry that has not started yet.
 */
export function summariseRun(tries: readonly DagTaskTry[], options: RunOptions = {}): RunSummary | null {
  const started = tries.filter((t) => t.startAt !== null);
  const first = started[0];
  if (!first) return null;
  let startAt = Infinity;
  let endAt = -Infinity;
  let open = false;
  for (const t of started) {
    startAt = Math.min(startAt, t.startAt as number);
    if (t.endAt === null) open = true;
    else endAt = Math.max(endAt, t.endAt);
  }
  const running = open || (options.inProgress?.(first.dagId, first.runId) ?? false);
  const failed = finalTries(started).some((t) => t.state !== null && FAILED_FINAL_STATES.has(t.state));
  const state: RunState = running ? 'running' : failed ? 'failed' : 'success';
  const end = state === 'running' ? null : endAt;
  return {
    dagId: first.dagId,
    runId: first.runId,
    state,
    startAt,
    endAt: end,
    durationSeconds: end === null ? null : Math.max(0, end - startAt) / 1000,
    tries: started.length,
  };
}

const RUN_ID_DATE = /__(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * The logical date encoded in Airflow's generated run IDs, such as `scheduled__2026-11-05T12:00:00+00:00`
 * or `manual__2026-11-05T12:00:00.123456+00:00`; `null` for custom run IDs.
 */
export function logicalDateFromRunId(runId: string): number | null {
  const m = RUN_ID_DATE.exec(runId);
  if (!m) return null;
  const fraction = m[2] ? m[2].slice(0, 4).padEnd(4, '0') : '';
  const zone = (m[3] ?? 'Z').replace(/^([+-]\d{2})(\d{2})$/, '$1:$2');
  const at = Date.parse(`${m[1]}${fraction}${zone}`);
  return Number.isFinite(at) ? at : null;
}
