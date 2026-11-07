/**
 * Failures, retries and flakiness per DAG and task (HM-015, spec §8.6 L1330; FR-TASK-02). Pure; times are
 * epoch ms, durations in the results are seconds.
 *
 * | Measure           | Definition                                                                 |
 * | ----------------- | -------------------------------------------------------------------------- |
 * | Try failure rate  | failed tries ÷ tries                                                        |
 * | Run failure rate  | failed DAG runs ÷ finished DAG runs                                         |
 * | Retry rate        | task instances with try number > 1 ÷ task instances                         |
 * | Flaky rate        | task instances that succeeded after ≥ 1 failed try ÷ task instances         |
 * | MTTR              | mean time from the first failure to the next success                        |
 *
 * Window rule as elsewhere: a try, its task instance and its run count in the window the try started in.
 * Rates need 20 samples of their denominator (HM-015); counts are always returned. An outage opens at the end
 * of a failure that started in the window and closes at the end of the next success, which may be after the
 * window. Error signatures need Cloud Logging and are not computed here.
 *
 * @implements HM-015, FR-TASK-02 (failure rate, retry rate, flakiness, MTTR per DAG and task)
 */
import { MIN_SAMPLES_FOR_RATE, runsInWindow } from './dag-league';
import {
  flakiness,
  groupBy,
  isFailedTry,
  startedIn,
  taskInstanceKey,
  type DagTaskTry,
  type RunOptions,
} from './dag-runs';

export interface TaskReliability {
  /** Tries starting in the window. */
  readonly tries: number;
  readonly failedTries: number;
  /** `failedTries ÷ tries`; `null` below 20 tries. */
  readonly tryFailureRate: number | null;
  /** Task instances with a try starting in the window. */
  readonly taskInstances: number;
  /** Task instances whose highest try number is above 1. */
  readonly retried: number;
  /** `retried ÷ taskInstances`; `null` below 20 task instances. */
  readonly retryRate: number | null;
  /** Flaky task instances, observed and inferred ({@link flakiness}). */
  readonly flaky: number;
  /** Of {@link flaky}, those inferred from the try number alone. */
  readonly flakyInferred: number;
  /** `flaky ÷ taskInstances`; `null` below 20 task instances. */
  readonly flakyRate: number | null;
  /** Outages (failure → next success) that closed. */
  readonly recoveries: number;
  /** Outages still open: no success after the failure yet. */
  readonly unrecovered: number;
  /** Mean of the closed outages, seconds; `null` without one. */
  readonly mttrSeconds: number | null;
}

export interface DagReliability {
  /** Finished runs with a try starting in the window. */
  readonly finishedRuns: number;
  readonly failedRuns: number;
  /** `failedRuns ÷ finishedRuns`; `null` below 20 finished runs. */
  readonly runFailureRate: number | null;
  readonly runRecoveries: number;
  readonly runUnrecovered: number;
  /** Mean time from a failed run's end to the next successful run's end, seconds. */
  readonly runMttrSeconds: number | null;
  /** Every task of the DAG together. */
  readonly tasks: TaskReliability;
  readonly byTask: ReadonlyMap<string, TaskReliability>;
}

interface Span {
  readonly from: number;
  readonly to: number;
}

const rate = (part: number, whole: number) => (whole >= MIN_SAMPLES_FOR_RATE ? part / whole : null);

interface Outages {
  readonly recoveries: number[];
  unrecovered: number;
}

/**
 * Outages along one timeline of finished outcomes, ordered by end: a failure that started in the window
 * opens one (unless one is open), the next success closes it.
 */
function outages(events: ReadonlyArray<{ end: number; failed: boolean; inWindow: boolean }>): Outages {
  const sorted = [...events].sort((a, b) => a.end - b.end);
  const recoveries: number[] = [];
  let openAt: number | null = null;
  for (const e of sorted) {
    if (e.failed) {
      if (openAt === null && e.inWindow) openAt = e.end;
    } else if (openAt !== null) {
      recoveries.push((e.end - openAt) / 1000);
      openAt = null;
    }
  }
  return { recoveries, unrecovered: openAt === null ? 0 : 1 };
}

const mean = (xs: readonly number[]) => (xs.length > 0 ? xs.reduce((s, v) => s + v, 0) / xs.length : null);

/** Try outcomes of one task as a timeline: failed tries and successes, finished ones only. */
function tryOutages(tries: readonly DagTaskTry[], w: Span): Outages {
  const events: Array<{ end: number; failed: boolean; inWindow: boolean }> = [];
  for (const t of tries) {
    if (t.startAt === null || t.endAt === null) continue;
    const failed = isFailedTry(t);
    if (!failed && t.state !== 'success') continue;
    events.push({ end: t.endAt, failed, inWindow: startedIn(t, w) });
  }
  return outages(events);
}

function reliabilityOf(tries: readonly DagTaskTry[], w: Span, outage: Outages): TaskReliability {
  const started = tries.filter((t) => startedIn(t, w));
  const byTi = groupBy(tries, taskInstanceKey);
  const keys = new Set(started.map(taskInstanceKey));
  let retried = 0;
  let flaky = 0;
  let inferred = 0;
  for (const k of keys) {
    const tiTries = byTi.get(k) ?? [];
    if (tiTries.some((t) => t.tryNumber > 1)) retried++;
    const f = flakiness(tiTries);
    if (f !== null) flaky++;
    if (f === 'inferred') inferred++;
  }
  const failedTries = started.filter(isFailedTry).length;
  return {
    tries: started.length,
    failedTries,
    tryFailureRate: rate(failedTries, started.length),
    taskInstances: keys.size,
    retried,
    retryRate: rate(retried, keys.size),
    flaky,
    flakyInferred: inferred,
    flakyRate: rate(flaky, keys.size),
    recoveries: outage.recoveries.length,
    unrecovered: outage.unrecovered,
    mttrSeconds: mean(outage.recoveries),
  };
}

/** HM-015 for one DAG over `w`: `tries` are its tries, including those of runs that began before `w`. */
export function dagReliability(
  tries: readonly DagTaskTry[],
  w: Span,
  options: RunOptions = {},
): DagReliability {
  const byTask = new Map<string, TaskReliability>();
  const allRecoveries: number[] = [];
  let allUnrecovered = 0;
  for (const [taskId, taskTries] of groupBy(tries, (t) => t.taskId)) {
    if (!taskTries.some((t) => startedIn(t, w))) continue;
    const outage = tryOutages(taskTries, w);
    allRecoveries.push(...outage.recoveries);
    allUnrecovered += outage.unrecovered;
    byTask.set(taskId, reliabilityOf(taskTries, w, outage));
  }
  const finished = runsInWindow(tries, w, options).filter((r) => r.state !== 'running');
  const failedRuns = finished.filter((r) => r.state === 'failed').length;
  const runOutage = outages(
    finished.map((r) => ({
      end: r.endAt as number,
      failed: r.state === 'failed',
      inWindow: r.startAt >= w.from && r.startAt < w.to,
    })),
  );
  return {
    finishedRuns: finished.length,
    failedRuns,
    runFailureRate: rate(failedRuns, finished.length),
    runRecoveries: runOutage.recoveries.length,
    runUnrecovered: runOutage.unrecovered,
    runMttrSeconds: mean(runOutage.recoveries),
    tasks: reliabilityOf(tries, w, { recoveries: allRecoveries, unrecovered: allUnrecovered }),
    byTask,
  };
}
