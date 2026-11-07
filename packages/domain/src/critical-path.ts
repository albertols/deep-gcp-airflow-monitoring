/**
 * Critical path of a DAG run (HM-007, spec §8.4 L1223): the chain of tries that set the run's duration, and
 * how often each task is on it across runs. Pure; times are epoch ms, durations in the results are seconds.
 *
 * HM-007 builds the path from the task graph (`downstream_task_ids`). DCAM does not collect the graph yet
 * (`GET /dags/{dag_id}/tasks`), so this is the timing method, an estimate: start at the try that ended last
 * and step back, to the earlier try of the same task instance when the step is a retry, else to the try that
 * ended last before the step became ready (first seen ready, else queued, else started). An upstream task
 * must end before its downstream task becomes ready, so the true predecessor is among the candidates; a
 * parallel branch that happened to end later, but still before, is chosen instead (the method's bias).
 * Each step's wait is the gap since the previous step ended (since the run's first start for the first),
 * so the path sums to the run duration. Slack per task needs the graph and is not computed.
 *
 * Mapped task instances collapse to the map index that ended last, skipped ones never started, and retries
 * add their wait and run time, as HM-007 asks.
 *
 * @implements HM-007 (timing method), FR-DAGD-03 (critical path)
 */
import { runsInWindow } from './dag-league';
import { groupBy, runKey, taskInstanceKey, type DagTaskTry, type RunOptions } from './dag-runs';

export interface CriticalStep {
  readonly taskId: string;
  readonly mapIndex: number;
  readonly tryNumber: number;
  readonly startAt: number;
  readonly endAt: number;
  /** Time since the previous step ended (the run's first start for the first step), seconds. */
  readonly waitSeconds: number;
  readonly runningSeconds: number;
}

export interface CriticalPath {
  /** `timing`: estimated from start and end times without the task graph. */
  readonly method: 'timing';
  /** First to last. */
  readonly steps: readonly CriticalStep[];
  /** Last end − the run's first start: the run duration. */
  readonly durationSeconds: number;
  readonly waitingSeconds: number;
  readonly runningSeconds: number;
}

type Finished = DagTaskTry & { readonly startAt: number; readonly endAt: number };

const tryKey = (t: DagTaskTry) => `${taskInstanceKey(t)}\u0000${t.tryNumber}`;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byEnd = (a: Finished, b: Finished) =>
  a.endAt - b.endAt ||
  a.startAt - b.startAt ||
  cmp(a.taskId, b.taskId) ||
  a.mapIndex - b.mapIndex ||
  a.tryNumber - b.tryNumber;

/** When the try was first known to be ready: the latest moment its upstream tasks can have ended. */
const readyBound = (t: Finished) => Math.min(t.readyAt ?? Infinity, t.queuedAt ?? Infinity, t.startAt);

/** Index of the last try in `sorted` (by end) that ended at or before `at`; −1 when none. */
function lastEndingBy(sorted: readonly Finished[], at: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((sorted[mid] as Finished).endAt <= at) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/** HM-007 for one finished run: `runTries` are all its tries. `null` while a try runs, or without tries. */
export function criticalPath(runTries: readonly DagTaskTry[]): CriticalPath | null {
  const started = runTries.filter((t) => t.startAt !== null);
  if (started.length === 0 || started.some((t) => t.endAt === null)) return null;
  const finished = started.filter((t): t is Finished => (t.endAt as number) >= (t.startAt as number));
  if (finished.length === 0) return null;
  const sorted = [...finished].sort(byEnd);
  const runStart = started.reduce((m, t) => Math.min(m, t.startAt as number), Infinity);
  const byTi = groupBy(finished, taskInstanceKey);

  const visited = new Set<string>();
  const chain: Finished[] = [];
  let current: Finished | undefined = sorted.at(-1);
  while (current) {
    const step: Finished = current;
    chain.push(step);
    visited.add(tryKey(step));
    // A retry follows its own earlier try (the retry exists because that try failed).
    let previous: Finished | undefined = (byTi.get(taskInstanceKey(step)) ?? [])
      .filter((t) => t.tryNumber < step.tryNumber && t.endAt <= step.startAt && !visited.has(tryKey(t)))
      .sort((a, b) => b.tryNumber - a.tryNumber)[0];
    if (!previous) {
      for (let i = lastEndingBy(sorted, readyBound(step)); i >= 0; i--) {
        const candidate = sorted[i] as Finished;
        if (!visited.has(tryKey(candidate))) {
          previous = candidate;
          break;
        }
      }
    }
    current = previous;
  }
  chain.reverse();

  let waiting = 0;
  let running = 0;
  const steps = chain.map((t, i): CriticalStep => {
    const since = i === 0 ? runStart : (chain[i - 1] as Finished).endAt;
    const waitSeconds = Math.max(0, t.startAt - since) / 1000;
    const runningSeconds = (t.endAt - t.startAt) / 1000;
    waiting += waitSeconds;
    running += runningSeconds;
    return {
      taskId: t.taskId,
      mapIndex: t.mapIndex,
      tryNumber: t.tryNumber,
      startAt: t.startAt,
      endAt: t.endAt,
      waitSeconds,
      runningSeconds,
    };
  });
  const last = chain.at(-1) as Finished;
  return {
    method: 'timing',
    steps,
    durationSeconds: (last.endAt - runStart) / 1000,
    waitingSeconds: waiting,
    runningSeconds: running,
  };
}

export interface CriticalPathFrequency {
  /** Finished runs with a try starting in the window, each with a critical path. */
  readonly runs: number;
  /** Runs in which the task was on the critical path. */
  readonly byTask: ReadonlyMap<string, number>;
}

/** HM-007 across runs: how often each task is on the critical path of the window's finished runs. */
export function criticalPathFrequency(
  tries: readonly DagTaskTry[],
  w: { readonly from: number; readonly to: number },
  options: RunOptions = {},
): CriticalPathFrequency {
  const byRun = groupBy(tries, (t) => runKey(t.dagId, t.runId));
  const byTask = new Map<string, number>();
  let runs = 0;
  for (const run of runsInWindow(tries, w, options)) {
    if (run.state === 'running') continue;
    const path = criticalPath(byRun.get(runKey(run.dagId, run.runId)) ?? []);
    if (!path) continue;
    runs++;
    for (const taskId of new Set(path.steps.map((s) => s.taskId)))
      byTask.set(taskId, (byTask.get(taskId) ?? 0) + 1);
  }
  return { runs, byTask };
}
