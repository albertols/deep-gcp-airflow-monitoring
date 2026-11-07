/**
 * DAG league table (spec §12.4 S-11): per-DAG capacity, reliability and queueing over a window, ranked by
 * executor slot-seconds and compared with the previous window of equal length. Pure; times are epoch ms,
 * durations in the results are seconds.
 *
 * Window rule: a try belongs to the window it started in, and so do its run and task instance; capacity
 * (slot-seconds, concurrency) is the running time clipped to the window.
 *
 * @implements FR-DAGX-02, FR-DAGX-03 (Gini), HM-001 (queue wait), HM-003 (slot-seconds), HM-015 (flaky rate)
 */
import {
  flakiness,
  groupBy,
  runKey,
  startedIn,
  summariseRun,
  taskInstanceKey,
  type DagTaskTry,
  type RunOptions,
  type RunSummary,
} from './dag-runs';
import { TOTAL_KEY, occupancySeries, slotSeconds, type SweepWindow } from './occupancy';
import { quantile, type Quantile } from './stats';

/** HM-015: rates need at least 20 task instances (or tries) to be shown. */
export const MIN_SAMPLES_FOR_RATE = 20;

export interface DagWindowStats {
  readonly dagId: string;
  /** Runs with at least one try starting in the window. */
  readonly runs: number;
  readonly finishedRuns: number;
  readonly failedRuns: number;
  /** Successful ÷ finished runs; `null` without finished runs. */
  readonly successRate: number | null;
  /** Tries starting in the window. */
  readonly tries: number;
  /** Tries with try number > 1 starting in the window. */
  readonly retries: number;
  /** Task instances with a try starting in the window. */
  readonly taskInstances: number;
  /**
   * HM-015: task instances whose final try succeeded after a failed try ÷ task instances, observed or inferred
   * from the try number ({@link flakiness}); `null` below 20.
   */
  readonly flakyRate: number | null;
  /** Finished runs: last end − first start, seconds. */
  readonly runDurationP50: Quantile;
  readonly runDurationP95: Quantile;
  /** HM-003: running time clipped to the window, one slot per try, seconds. */
  readonly executorSlotSeconds: number;
  /** HM-011: most tries of this DAG running at once for a positive duration. */
  readonly peakConcurrency: number;
  /** HM-001: `start − queued` of tries starting in the window, seconds. */
  readonly queueWaitP95: Quantile;
  /** HM-006: `start − ready` of tries starting in the window, seconds. */
  readonly readyWaitP95: Quantile;
}

/** HM-001: queue wait in seconds of every try with both timestamps in order. */
export function queueWaitsSeconds(tries: readonly DagTaskTry[]): number[] {
  const waits: number[] = [];
  for (const t of tries)
    if (t.queuedAt !== null && t.startAt !== null && t.startAt >= t.queuedAt)
      waits.push((t.startAt - t.queuedAt) / 1000);
  return waits;
}

/**
 * HM-006: wait to start in seconds (`start − ready`), covering pre-queue and post-queue waiting.
 * Tries without a ready time (history older than DCAM's live collection) are skipped.
 */
export function readyWaitsSeconds(tries: readonly DagTaskTry[]): number[] {
  const waits: number[] = [];
  for (const t of tries)
    if (t.readyAt !== null && t.startAt !== null && t.startAt >= t.readyAt)
      waits.push((t.startAt - t.readyAt) / 1000);
  return waits;
}

/** Most tries running at once per DAG: one bucket spanning the window, so its max is the peak. */
export function peakConcurrencyByDag(tries: readonly DagTaskTry[], w: SweepWindow): Map<string, number> {
  const bucketMs = Math.max(1, Math.ceil(w.to - w.from));
  const series = occupancySeries(tries, w, { groupBy: (t) => t.dagId, bucketMs });
  const peaks = new Map<string, number>();
  for (const [key, buckets] of series)
    if (key !== TOTAL_KEY)
      peaks.set(
        key,
        buckets.reduce((m, b) => Math.max(m, b.max), 0),
      );
  return peaks;
}

export function emptyDagStats(dagId: string): DagWindowStats {
  const none = quantile([], 0.95);
  return {
    dagId,
    runs: 0,
    finishedRuns: 0,
    failedRuns: 0,
    successRate: null,
    tries: 0,
    retries: 0,
    taskInstances: 0,
    flakyRate: null,
    runDurationP50: quantile([], 0.5),
    runDurationP95: none,
    executorSlotSeconds: 0,
    peakConcurrency: 0,
    queueWaitP95: none,
    readyWaitP95: none,
  };
}

/** The runs that have a try starting in the window, summarised from all their tries. */
export function runsInWindow(
  tries: readonly DagTaskTry[],
  w: Pick<SweepWindow, 'from' | 'to'>,
  options: RunOptions = {},
): RunSummary[] {
  const byRun = groupBy(tries, (t) => runKey(t.dagId, t.runId));
  const keys = new Set(tries.filter((t) => startedIn(t, w)).map((t) => runKey(t.dagId, t.runId)));
  const runs: RunSummary[] = [];
  for (const k of keys) {
    const run = summariseRun(byRun.get(k) ?? [], options);
    if (run) runs.push(run);
  }
  return runs;
}

/** Per-DAG statistics for every DAG with a try running or starting in the window. */
export function dagWindowStats(
  tries: readonly DagTaskTry[],
  w: SweepWindow,
  options: RunOptions = {},
): Map<string, DagWindowStats> {
  const seconds = slotSeconds(tries, w).byDag;
  const peaks = peakConcurrencyByDag(tries, w);
  const byDag = groupBy(tries, (t) => t.dagId);
  const result = new Map<string, DagWindowStats>();
  for (const [dagId, dagTries] of byDag) {
    const started = dagTries.filter((t) => startedIn(t, w));
    const slot = seconds.get(dagId)?.executorSlotSeconds ?? 0;
    if (started.length === 0 && slot === 0) continue;

    const runs = runsInWindow(dagTries, w, options);
    const finished = runs.filter((r) => r.state !== 'running');
    const failedRuns = finished.filter((r) => r.state === 'failed').length;
    const byTi = groupBy(dagTries, taskInstanceKey);
    const tiKeys = new Set(started.map(taskInstanceKey));
    let flaky = 0;
    for (const k of tiKeys) if (flakiness(byTi.get(k) ?? []) !== null) flaky++;
    const durations = finished.map((r) => r.durationSeconds as number);
    result.set(dagId, {
      dagId,
      runs: runs.length,
      finishedRuns: finished.length,
      failedRuns,
      successRate: finished.length > 0 ? (finished.length - failedRuns) / finished.length : null,
      tries: started.length,
      retries: started.filter((t) => t.tryNumber > 1).length,
      taskInstances: tiKeys.size,
      flakyRate: tiKeys.size >= MIN_SAMPLES_FOR_RATE ? flaky / tiKeys.size : null,
      runDurationP50: quantile(durations, 0.5),
      runDurationP95: quantile(durations, 0.95),
      executorSlotSeconds: slot,
      peakConcurrency: peaks.get(dagId) ?? 0,
      queueWaitP95: quantile(queueWaitsSeconds(started), 0.95),
      readyWaitP95: quantile(readyWaitsSeconds(started), 0.95),
    });
  }
  return result;
}

/**
 * FR-DAGX-03: Gini coefficient of non-negative values (0 = evenly spread, → 1 = one DAG uses
 * everything); 0 for fewer than two values or a zero total.
 */
export function gini(values: readonly number[]): number {
  const xs = values.filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  const n = xs.length;
  const sum = xs.reduce((s, v) => s + v, 0);
  if (n < 2 || sum <= 0) return 0;
  const weighted = xs.reduce((s, v, i) => s + (i + 1) * v, 0);
  return Math.min(1, Math.max(0, (2 * weighted) / (n * sum) - (n + 1) / n));
}

export interface DagLeagueEntry extends DagWindowStats {
  /** Share of the environment's executor slot-seconds in the window, 0–1. */
  readonly share: number;
  /** Share of this DAG and every DAG ranked above it (Pareto). */
  readonly cumulativeShare: number;
  /** Share in the previous window; `null` when the DAG was inactive then. */
  readonly previousShare: number | null;
}

export interface DagLeagueInput extends RunOptions {
  readonly tries: readonly DagTaskTry[];
  readonly window: SweepWindow;
  /** The window of equal length before `window`, for "change vs previous period". */
  readonly previousWindow: SweepWindow;
  /** Every DAG known in the environment; inactive ones get a row with zero values. */
  readonly dagIds: readonly string[];
}

export interface DagLeagueResult {
  /** Rank order: slot-seconds descending, then DAG ID. */
  readonly rows: DagLeagueEntry[];
  readonly totalExecutorSlotSeconds: number;
  readonly previousTotalExecutorSlotSeconds: number;
  /** DAGs with slot-seconds in the window. */
  readonly activeDagCount: number;
  /** Concentration of slot-seconds across active DAGs. */
  readonly gini: number;
}

const ratio = (part: number, whole: number) => (whole > 0 ? Math.min(1, Math.max(0, part / whole)) : 0);
const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function dagLeague(input: DagLeagueInput): DagLeagueResult {
  const options: RunOptions = input.inProgress ? { inProgress: input.inProgress } : {};
  const current = dagWindowStats(input.tries, input.window, options);
  const previous = slotSeconds(input.tries, input.previousWindow).byDag;
  const ids = new Set([...input.dagIds, ...current.keys(), ...previous.keys()]);
  const stats = [...ids].map((id) => current.get(id) ?? emptyDagStats(id));
  stats.sort((a, b) => b.executorSlotSeconds - a.executorSlotSeconds || byId(a.dagId, b.dagId));

  // Summed in rank order, so the last active row's cumulative share is exactly 1.
  const total = stats.reduce((s, r) => s + r.executorSlotSeconds, 0);
  let previousTotal = 0;
  for (const p of previous.values()) previousTotal += p.executorSlotSeconds;

  let cumulative = 0;
  const rows = stats.map((r): DagLeagueEntry => {
    cumulative += r.executorSlotSeconds;
    const before = previous.get(r.dagId)?.executorSlotSeconds ?? 0;
    return {
      ...r,
      share: ratio(r.executorSlotSeconds, total),
      cumulativeShare: ratio(cumulative, total),
      previousShare: before > 0 ? ratio(before, previousTotal) : null,
    };
  });
  const active = stats.filter((r) => r.executorSlotSeconds > 0).map((r) => r.executorSlotSeconds);
  return {
    rows,
    totalExecutorSlotSeconds: total,
    previousTotalExecutorSlotSeconds: previousTotal,
    activeDagCount: active.length,
    gini: gini(active),
  };
}
