/**
 * The DAG league table built from slices of the store instead of one query (NFR-PERF-01): for 30 or 90
 * days at 2,000 DAGs the tries of both windows do not fit in memory together. The store is read slice by
 * slice, the current window first, then the previous one; each slice is dropped after it is added, and
 * only per-DAG, per-run and per-task-instance totals are kept. The result equals {@link dagLeague} over
 * all tries at once (a property test checks every slicing).
 *
 * Each slice is what `TaskInstanceStore.taskTries(env, slice.from - 1, slice.to)` returns: started tries
 * whose running interval overlaps the slice, read 1 ms early so that a zero-length try on the slice's
 * first millisecond is not lost. A try that spans slices comes back in each of them and counts in
 * the slice it started in; the first slice of the previous window also takes the tries that started
 * before it. Peak concurrency is the highest of the slices' peaks, each from every try in its slice.
 *
 * Memory: one slice of tries, plus one small record per run with a try in the window and one number per
 * task instance of those runs (nested maps on the tries' own strings), plus the queue and ready waits.
 *
 * @implements NFR-PERF-01, FR-DAGX-02, FR-DAGX-03, HM-001, HM-003, HM-011, HM-015
 */
import {
  emptyDagStats,
  rankLeague,
  type DagLeagueResult,
  type DagWindowStats,
  MIN_SAMPLES_FOR_RATE,
} from './dag-league';
import {
  isFailedFinalState,
  isFailedTry,
  isFinishedTry,
  ranTry,
  type DagTaskTry,
  type RunOptions,
} from './dag-runs';
import { TOTAL_KEY, clippedInterval, occupancySeries, type SweepWindow, type TaskTry } from './occupancy';
import { quantile } from './stats';

/** A part of a window, `[from, to)`, read from the store in one query. */
export interface Slice {
  readonly from: number;
  readonly to: number;
}

export interface LeagueAccumulatorInput extends RunOptions {
  readonly window: SweepWindow;
  /** The window of equal length before `window`. */
  readonly previousWindow: SweepWindow;
}

export interface LeagueAccumulator {
  /** Adds one slice of the current window; slices cover `[window.from, window.to)`. */
  addCurrent(tries: readonly DagTaskTry[], slice: Slice): void;
  /**
   * Adds one slice of the previous window, after every current slice: tries that started before the
   * window only count for the runs and task instances that have a try in it, and for slot-seconds.
   */
  addPrevious(tries: readonly DagTaskTry[], slice: Slice): void;
  result(dagIds: readonly string[]): DagLeagueResult;
}

interface RunTotals {
  startAt: number;
  endAt: number;
  open: boolean;
  /** Task instances whose latest try ended in a state that fails the run. */
  failedTaskInstances: number;
  /** Task instances whose latest try is not in a terminal state: the run is still running. */
  unfinishedTaskInstances: number;
  /**
   * The run's task instances, by task ID and map index (nested maps on the tries' own strings: no composite
   * key per try). Each value packs the latest try and what the tries showed in one number.
   */
  readonly taskInstances: Map<string, Map<number, number>>;
}

/** The latest try's outcome (two bits): success, a state that fails the run, not terminal, or other. */
const FINAL_SUCCESS = 1;
const FINAL_FAILED = 2;
const FINAL_UNFINISHED = 3;
const CLASS = 3;
/** The latest try is a failed try (it fails an earlier one once a later try arrives). */
const LATEST_FAILED = 4;
/** The latest try has a state (an earlier one without, closed by the store, says nothing). */
const LATEST_HAS_STATE = 8;
/** A try below the latest failed (HM-015 flakiness, "observed"). */
const FAILED_BELOW = 16;
/** A try below the latest has a state ("inferred" needs every earlier try stateless or missing). */
const STATE_BELOW = 32;
/** A try of the task instance that ran started in the window. */
const IN_WINDOW = 64;
const TRY_UNIT = 128;

const finalClass = (t: Pick<DagTaskTry, 'state'>) =>
  !isFinishedTry(t)
    ? FINAL_UNFINISHED
    : t.state === 'success'
      ? FINAL_SUCCESS
      : isFailedFinalState(t.state)
        ? FINAL_FAILED
        : 0;
const latestFlags = (t: Pick<DagTaskTry, 'state'>) =>
  (isFailedTry(t) ? LATEST_FAILED : 0) | (t.state !== null ? LATEST_HAS_STATE : 0);

interface DagTotals {
  slotSeconds: number;
  previousSlotSeconds: number;
  peak: number;
  tries: number;
  retries: number;
  readonly queueWaits: number[];
  readonly readyWaits: number[];
  /** Runs with a try that started in the window, by run ID. */
  readonly runs: Map<string, RunTotals>;
}

/**
 * True when this slice counts the try: it started in the slice, or, for the first slice of a window, it
 * started earlier and was still running when the slice began (the slice is read 1 ms early, so a try
 * that ended exactly then also comes back and must not count).
 */
export function ownsTry(t: TaskTry, slice: Slice, first: boolean): boolean {
  if (t.startAt === null || t.startAt >= slice.to) return false;
  if (t.startAt >= slice.from) return true;
  return first && (t.endAt === null || t.endAt > slice.from);
}

const clippedSeconds = (t: TaskTry, w: SweepWindow) => {
  const iv = clippedInterval(t, w);
  return iv === null || iv === 'rejected' ? 0 : (iv.to - iv.from) / 1000;
};

export function createLeagueAccumulator(input: LeagueAccumulatorInput): LeagueAccumulator {
  const { window: w, previousWindow: p } = input;
  const dags = new Map<string, DagTotals>();
  const dagOf = (dagId: string): DagTotals => {
    let d = dags.get(dagId);
    if (!d) {
      d = {
        slotSeconds: 0,
        previousSlotSeconds: 0,
        peak: 0,
        tries: 0,
        retries: 0,
        queueWaits: [],
        readyWaits: [],
        runs: new Map(),
      };
      dags.set(dagId, d);
    }
    return d;
  };

  /** Adds a try to its run and task instance (the run must exist). */
  function addToRun(run: RunTotals, t: DagTaskTry, inWindow: boolean) {
    const start = t.startAt as number;
    run.startAt = Math.min(run.startAt, start);
    if (t.endAt === null) run.open = true;
    else run.endAt = Math.max(run.endAt, t.endAt);

    let indexes = run.taskInstances.get(t.taskId);
    if (!indexes) run.taskInstances.set(t.taskId, (indexes = new Map<number, number>()));
    const seen = indexes.get(t.mapIndex);
    const tryNumber = Math.max(0, t.tryNumber);
    const window = inWindow ? IN_WINDOW : 0;
    let code: number;
    let before = -1;
    if (seen === undefined) {
      code = tryNumber * TRY_UNIT + window + latestFlags(t) + finalClass(t);
    } else {
      before = (seen % TRY_UNIT) & CLASS;
      const seenTry = Math.floor(seen / TRY_UNIT);
      const bits = seen % TRY_UNIT;
      const below = bits & (FAILED_BELOW | STATE_BELOW);
      if (tryNumber > seenTry) {
        // The latest so far becomes an earlier try; this one decides the outcome.
        const demoted =
          (bits & LATEST_FAILED ? FAILED_BELOW : 0) | (bits & LATEST_HAS_STATE ? STATE_BELOW : 0);
        code =
          tryNumber * TRY_UNIT +
          ((bits | window) & IN_WINDOW) +
          (below | demoted) +
          latestFlags(t) +
          finalClass(t);
      } else if (tryNumber < seenTry) {
        const earlier = (isFailedTry(t) ? FAILED_BELOW : 0) | (t.state !== null ? STATE_BELOW : 0);
        code = seen - (bits & IN_WINDOW) + ((bits | window) & IN_WINDOW) - below + (below | earlier);
      } else {
        // The same try number twice: the first one seen stays the latest, as in flakiness and summariseRun.
        code = seen - (bits & IN_WINDOW) + ((bits | window) & IN_WINDOW);
      }
    }
    indexes.set(t.mapIndex, code);
    const after = (code % TRY_UNIT) & CLASS;
    if (before === after) return;
    if (before === FINAL_FAILED) run.failedTaskInstances--;
    if (before === FINAL_UNFINISHED) run.unfinishedTaskInstances--;
    if (after === FINAL_FAILED) run.failedTaskInstances++;
    if (after === FINAL_UNFINISHED) run.unfinishedTaskInstances++;
  }

  const newRun = (): RunTotals => ({
    startAt: Infinity,
    endAt: -Infinity,
    open: false,
    failedTaskInstances: 0,
    unfinishedTaskInstances: 0,
    taskInstances: new Map(),
  });

  return {
    addCurrent(tries, slice) {
      // Peaks per slice from every try running in it; the window's peak is the highest of them.
      const from = Math.max(slice.from, w.from);
      const to = Math.min(slice.to, w.to);
      if (to > from) {
        const peaks = occupancySeries(
          tries,
          { from, to, now: w.now },
          { groupBy: (t) => t.dagId, bucketMs: Math.max(1, Math.ceil(to - from)) },
        );
        for (const [key, buckets] of peaks) {
          if (key === TOTAL_KEY) continue;
          const peak = buckets.reduce((m, b) => Math.max(m, b.max), 0);
          const d = dagOf(key);
          d.peak = Math.max(d.peak, peak);
        }
      }
      for (const t of tries) {
        // Tries that started before this slice count in an earlier one.
        if (t.startAt === null || t.startAt < slice.from || t.startAt < w.from) continue;
        const d = dagOf(t.dagId);
        d.slotSeconds += clippedSeconds(t, w);
        if (t.startAt >= w.to) continue;
        // Skipped and upstream_failed task instances never ran: no tries, waits or task instances (HM-015).
        const ran = ranTry(t);
        if (ran) {
          d.tries++;
          if (t.tryNumber > 1) d.retries++;
          if (t.queuedAt !== null && t.startAt >= t.queuedAt)
            d.queueWaits.push((t.startAt - t.queuedAt) / 1000);
          if (t.readyAt !== null && t.startAt >= t.readyAt) d.readyWaits.push((t.startAt - t.readyAt) / 1000);
        }
        let run = d.runs.get(t.runId);
        if (!run) {
          run = newRun();
          d.runs.set(t.runId, run);
        }
        addToRun(run, t, ran);
      }
    },

    addPrevious(tries, slice) {
      const first = slice.from <= p.from;
      for (const t of tries) {
        if (t.startAt === null || t.startAt >= w.from) continue;
        if (!ownsTry(t, slice, first)) continue;
        const previousSeconds = clippedSeconds(t, p);
        const currentSeconds = clippedSeconds(t, w);
        const known = dags.get(t.dagId);
        const run = known?.runs.get(t.runId);
        if (previousSeconds === 0 && currentSeconds === 0 && !run) continue;
        const d = known ?? dagOf(t.dagId);
        d.previousSlotSeconds += previousSeconds;
        d.slotSeconds += currentSeconds;
        if (run) addToRun(run, t, false);
      }
    },

    result(dagIds) {
      const { inProgress } = input;
      const current = new Map<string, DagWindowStats>();
      const previous = new Map<string, number>();
      for (const [dagId, d] of dags) {
        if (d.previousSlotSeconds > 0) previous.set(dagId, d.previousSlotSeconds);
        if (d.tries === 0 && d.slotSeconds === 0) continue;
        const durations: number[] = [];
        let finished = 0;
        let failedRuns = 0;
        for (const [runId, r] of d.runs) {
          if (r.open || r.unfinishedTaskInstances > 0 || (inProgress?.(dagId, runId) ?? false)) continue;
          finished++;
          if (r.failedTaskInstances > 0) failedRuns++;
          durations.push(Math.max(0, r.endAt - r.startAt) / 1000);
        }
        let taskInstances = 0;
        let flaky = 0;
        let flakyInferred = 0;
        for (const r of d.runs.values())
          for (const indexes of r.taskInstances.values())
            for (const code of indexes.values()) {
              if (!(code & IN_WINDOW)) continue;
              taskInstances++;
              // HM-015 (`flakiness`): the latest try succeeded after a failed try, observed, or inferred from a
              // try number above 1 when no earlier try with a state is stored.
              if ((code & CLASS) !== FINAL_SUCCESS) continue;
              if (code & FAILED_BELOW) flaky++;
              else if (!(code & STATE_BELOW) && Math.floor(code / TRY_UNIT) > 1) {
                flaky++;
                flakyInferred++;
              }
            }
        current.set(dagId, {
          ...emptyDagStats(dagId),
          runs: d.runs.size,
          finishedRuns: finished,
          failedRuns,
          successRate: finished > 0 ? (finished - failedRuns) / finished : null,
          tries: d.tries,
          retries: d.retries,
          taskInstances,
          flaky,
          flakyInferred,
          flakyRate: taskInstances >= MIN_SAMPLES_FOR_RATE ? flaky / taskInstances : null,
          runDurationP50: quantile(durations, 0.5),
          runDurationP95: quantile(durations, 0.95),
          executorSlotSeconds: d.slotSeconds,
          peakConcurrency: d.peak,
          queueWaitP95: quantile(d.queueWaits, 0.95),
          readyWaitP95: quantile(d.readyWaits, 0.95),
        });
      }
      return rankLeague(current, previous, dagIds);
    },
  };
}

export interface CapacityTotals {
  /** HM-003: executor slot-seconds per DAG with a positive value. */
  readonly byDag: ReadonlyMap<string, number>;
  readonly totalExecutorSlotSeconds: number;
  /** HM-011: most tries running at once in the window. */
  readonly peakConcurrency: number;
}

/**
 * Executor slot-seconds per DAG and the environment's peak concurrency over slices of one window
 * (NFR-PERF-01), equal to {@link slotSeconds} and the {@link occupancySeries} peak over one query. Slices
 * are read 1 ms early, as for {@link createLeagueAccumulator}, and may come in any order; the slice that
 * starts at the window start is the first.
 */
export function createCapacityAccumulator(w: SweepWindow) {
  const byDag = new Map<string, number>();
  let totalMs = 0;
  let peak = 0;
  return {
    add(tries: readonly TaskTry[], slice: Slice): void {
      const from = Math.max(slice.from, w.from);
      const to = Math.min(slice.to, w.to);
      if (to > from) {
        const series = occupancySeries(
          tries,
          { from, to, now: w.now },
          { bucketMs: Math.max(1, Math.ceil(to - from)) },
        );
        for (const b of series.get(TOTAL_KEY) ?? []) peak = Math.max(peak, b.max);
      }
      const first = slice.from <= w.from;
      for (const t of tries) {
        if (!ownsTry(t, slice, first)) continue;
        const iv = clippedInterval(t, w);
        if (iv === null || iv === 'rejected') continue;
        byDag.set(t.dagId, (byDag.get(t.dagId) ?? 0) + (iv.to - iv.from) / 1000);
        totalMs += iv.to - iv.from;
      }
    },
    result(): CapacityTotals {
      return { byDag, totalExecutorSlotSeconds: totalMs / 1000, peakConcurrency: peak };
    },
  };
}
