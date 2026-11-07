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
/**
 * Terminal task instance states: Airflow's `State.finished` (2.11.1 `airflow/utils/state.py` L162-170). Every
 * other state is unfinished (`State.unfinished`, L180-191): `None`, scheduled, queued, running, restarting,
 * up_for_retry, up_for_reschedule and deferred. Airflow sets the end of a try that becomes up_for_retry
 * (`TaskInstance._set_state`, `airflow/models/taskinstance.py` L2444), and DCAM's store closes a try that
 * stopped showing as running with state `NULL` and an estimated end until its finished row is read.
 */
const FINISHED_STATES: ReadonlySet<string> = new Set([
  'success',
  'failed',
  'skipped',
  'upstream_failed',
  'removed',
]);

/** True when the try reached a terminal state: an end time alone does not say the task instance is done. */
export const isFinishedTry = (t: Pick<DagTaskTry, 'state'>) =>
  t.state !== null && FINISHED_STATES.has(t.state);

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

/*
 * Grouping by run and task instance without composite keys. Maps are nested on the tries' own `dagId`,
 * `runId` and `taskId` strings, whose hashes V8 caches; a concatenated key is a new string to hash for every
 * try, which made grouping the largest cost of DAG detail over a week (NFR-PERF).
 */

/** The tries of each run (DAG and run ID), in order of each run's first try in the input. */
export function triesByRun<T extends Pick<TaskTry, 'dagId' | 'runId'>>(tries: readonly T[]): T[][] {
  const byDag = new Map<string, Map<string, T[]>>();
  const groups: T[][] = [];
  for (const t of tries) {
    let runs = byDag.get(t.dagId);
    if (!runs) byDag.set(t.dagId, (runs = new Map<string, T[]>()));
    let list = runs.get(t.runId);
    if (!list) {
      runs.set(t.runId, (list = []));
      groups.push(list);
    }
    list.push(t);
  }
  return groups;
}

/** The tries of each task instance among the tries of one run (task ID and map index). */
export function triesByTaskInstance<T extends Pick<TaskTry, 'taskId' | 'mapIndex'>>(
  runTries: readonly T[],
): T[][] {
  const byTask = new Map<string, Map<number, T[]>>();
  const groups: T[][] = [];
  for (const t of runTries) {
    let indexes = byTask.get(t.taskId);
    if (!indexes) byTask.set(t.taskId, (indexes = new Map<number, T[]>()));
    let list = indexes.get(t.mapIndex);
    if (!list) {
      indexes.set(t.mapIndex, (list = []));
      groups.push(list);
    }
    list.push(t);
  }
  return groups;
}

/** The tries of each task instance (DAG, run, task and map index). */
export function triesByTaskInstanceOf<T extends Pick<TaskTry, 'dagId' | 'runId' | 'taskId' | 'mapIndex'>>(
  tries: readonly T[],
): T[][] {
  return triesByRun(tries).flatMap((run) => triesByTaskInstance(run));
}

/**
 * HM-015 flakiness of one task instance: its latest try succeeded after a failed try.
 * - `observed`: an earlier failed try is stored.
 * - `inferred`: the latest try succeeded, its try number is above 1, and no earlier try is stored, or only
 *   earlier tries the store closed without a state (`NULL`: it stopped showing as running before its row was
 *   read, `closeRunningTries`). The backfill and
 *   `af.facts` read the current row of a task instance, so an earlier try retried before DCAM read it is
 *   never stored (spec 004). ⚠️ VERIFY: in Airflow 2.10+ clearing a task instance also raises `try_number`,
 *   so an inferred count is an upper bound.
 * `null` when the task instance is not flaky.
 */
export type Flakiness = 'observed' | 'inferred';

export function flakiness(taskInstanceTries: readonly DagTaskTry[]): Flakiness | null {
  let final: DagTaskTry | undefined;
  for (const t of taskInstanceTries) if (!final || t.tryNumber > final.tryNumber) final = t;
  if (!final || final.state !== 'success') return null;
  const last = final;
  const earlier = taskInstanceTries.filter((t) => t.tryNumber < last.tryNumber);
  if (earlier.some(isFailedTry)) return 'observed';
  // An earlier try the store closed without a state (its row never read) says no more than a missing one.
  return last.tryNumber > 1 && earlier.every((t) => t.state === null) ? 'inferred' : null;
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
 * One run from all its tries. Running while a try has not ended, the latest try of a task instance is not in
 * a terminal state ({@link isFinishedTry}: waiting for a retry or a reschedule, or closed by the store without
 * a state), or work is waiting; otherwise failed when the latest try of some task instance failed, else
 * successful. ⚠️ M1 takes the run state from the DAG runs collector; this derivation cannot see a task
 * instance that has no try yet.
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
  let failed = false;
  let unfinished = false;
  for (const ti of triesByTaskInstance(started)) {
    let latest = ti[0] as DagTaskTry;
    for (const t of ti) if (t.tryNumber > latest.tryNumber) latest = t;
    if (!isFinishedTry(latest)) unfinished = true;
    else if (FAILED_FINAL_STATES.has(latest.state as string)) failed = true;
  }
  const state: RunState = running || unfinished ? 'running' : failed ? 'failed' : 'success';
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
