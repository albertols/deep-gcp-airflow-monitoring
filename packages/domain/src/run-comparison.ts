/**
 * Two runs of one DAG compared task by task (FR-DAGD-09, S-13): per-task deltas of duration and queue wait, and
 * each task's contribution to the difference in run duration. Pure; times are epoch ms, durations seconds.
 *
 * - Per task, mapped task instances collapse to the longest map index (HM-007): the one with the most time from
 *   becoming ready (else queued, else started) to its last try's end. Retries add their wait and run time:
 *   duration is the running time of every try of that map index, queue wait (HM-001, `start − queued`) the sum
 *   over its tries. Skipped and upstream_failed task instances never ran ({@link ranTry}): no duration.
 * - Contribution: the task's time on run b's critical path (its steps' wait plus running time) minus its time on
 *   run a's, with the timing-estimated path of `critical-path.ts` (HM-007/timing, an estimate). Each path sums to
 *   its run's duration, so the contributions sum to the duration difference, and a task off both paths
 *   contributes 0, however much its own duration changed.
 * - Ranking: by contribution in the direction of the difference (the tasks that made b slower first when b is
 *   slower); with a run still in progress there is no path, and tasks rank by the change in their duration.
 *
 * @implements FR-DAGD-09, HM-007, HM-001
 */
import { criticalPath, type CriticalPath } from './critical-path';
import { ranTry, summariseRun, type DagTaskTry, type RunOptions, type RunSummary } from './dag-runs';

export interface TaskInRun {
  readonly taskId: string;
  /** State of the latest try of the collapsed map index (of any try when none ran). */
  readonly state: string | null;
  /** Map indexes of the task that ran in the run: 1 for an unmapped task, 0 when it never ran. */
  readonly mapIndexes: number;
  /** The map index the task collapses to (−1 unmapped); `null` when it never ran. */
  readonly mapIndex: number | null;
  /** Tries of that map index. */
  readonly tries: number;
  readonly startAt: number | null;
  readonly endAt: number | null;
  /** Running time over the map index's tries; `null` when it never ran or a try has not ended. */
  readonly durationSeconds: number | null;
  /** HM-001 queue wait over its tries; `null` when no try has a queued and a start time. */
  readonly queueWaitSeconds: number | null;
  readonly onCriticalPath: boolean;
  /** Time on the run's critical path: its steps' wait plus running time (0 when off it, or without a path). */
  readonly criticalSeconds: number;
  readonly criticalWaitSeconds: number;
  readonly criticalRunningSeconds: number;
}

export interface TaskDelta {
  readonly taskId: string;
  readonly a: TaskInRun | null;
  readonly b: TaskInRun | null;
  /** b − a; `null` unless both runs have a duration for the task. */
  readonly durationDeltaSeconds: number | null;
  readonly queueWaitDeltaSeconds: number | null;
  /** Critical-path time in b − in a; `null` unless both runs have a critical path. */
  readonly contributionSeconds: number | null;
  readonly contributionWaitSeconds: number | null;
  readonly contributionRunningSeconds: number | null;
}

export type RunRanking = 'critical-path' | 'duration-delta';

export interface RunComparison {
  readonly a: RunSummary;
  readonly b: RunSummary;
  /** `null` while the run is in progress. */
  readonly pathA: CriticalPath | null;
  readonly pathB: CriticalPath | null;
  /** b's duration − a's; `null` while either runs. */
  readonly durationDeltaSeconds: number | null;
  /** Σ contributions (b's critical path − a's); `null` without both paths. */
  readonly explainedSeconds: number | null;
  readonly ranking: RunRanking;
  readonly tasks: readonly TaskDelta[];
}

const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
const delta = (a: number | null | undefined, b: number | null | undefined) =>
  a === null || a === undefined || b === null || b === undefined ? null : b - a;

function sumOf(values: readonly number[]): number {
  let s = 0;
  for (const v of values) s += v;
  return s;
}

/** One task of one run, collapsed to its longest map index (HM-007). */
function taskInRun(taskId: string, tries: readonly DagTaskTry[], path: CriticalPath | null): TaskInRun {
  const byIndex = new Map<number, DagTaskTry[]>();
  for (const t of tries) {
    if (t.startAt === null || !ranTry(t)) continue;
    const list = byIndex.get(t.mapIndex);
    if (list) list.push(t);
    else byIndex.set(t.mapIndex, [t]);
  }
  const steps = path?.steps.filter((s) => s.taskId === taskId) ?? [];
  const critical = {
    onCriticalPath: steps.length > 0,
    criticalWaitSeconds: sumOf(steps.map((s) => s.waitSeconds)),
    criticalRunningSeconds: sumOf(steps.map((s) => s.runningSeconds)),
  };
  const withCritical = {
    ...critical,
    criticalSeconds: critical.criticalWaitSeconds + critical.criticalRunningSeconds,
  };
  if (byIndex.size === 0) {
    let latest: DagTaskTry | undefined;
    for (const t of tries) if (!latest || t.tryNumber > latest.tryNumber) latest = t;
    return {
      taskId,
      state: latest?.state ?? null,
      mapIndexes: 0,
      mapIndex: null,
      tries: 0,
      startAt: null,
      endAt: null,
      durationSeconds: null,
      queueWaitSeconds: null,
      ...withCritical,
    };
  }
  let chosen: { index: number; tries: DagTaskTry[]; elapsed: number; end: number } | null = null;
  for (const [index, list] of byIndex) {
    let first = Infinity;
    let end = -Infinity;
    for (const t of list) {
      first = Math.min(first, t.readyAt ?? Infinity, t.queuedAt ?? Infinity, t.startAt as number);
      end = Math.max(end, t.endAt ?? Infinity);
    }
    const elapsed = end - first;
    if (
      !chosen ||
      elapsed > chosen.elapsed ||
      (elapsed === chosen.elapsed && (end > chosen.end || (end === chosen.end && index < chosen.index)))
    )
      chosen = { index, tries: list, elapsed, end };
  }
  const picked = chosen as NonNullable<typeof chosen>;
  const ordered = [...picked.tries].sort((x, y) => x.tryNumber - y.tryNumber);
  const latest = ordered.at(-1) as DagTaskTry;
  const open = ordered.some((t) => t.endAt === null);
  const waits = ordered
    .filter((t) => t.queuedAt !== null && (t.startAt as number) >= t.queuedAt)
    .map((t) => ((t.startAt as number) - (t.queuedAt as number)) / 1000);
  return {
    taskId,
    state: latest.state,
    mapIndexes: byIndex.size,
    mapIndex: picked.index,
    tries: ordered.length,
    startAt: ordered[0]?.startAt ?? null,
    endAt: open ? null : latest.endAt,
    durationSeconds: open
      ? null
      : sumOf(ordered.map((t) => Math.max(0, (t.endAt as number) - (t.startAt as number)) / 1000)),
    queueWaitSeconds: waits.length ? sumOf(waits) : null,
    ...withCritical,
  };
}

function side(runTries: readonly DagTaskTry[], options: RunOptions) {
  const summary = summariseRun(runTries, options);
  if (!summary) return null;
  const path = summary.state === 'running' ? null : criticalPath(runTries);
  const byTask = new Map<string, DagTaskTry[]>();
  for (const t of runTries) {
    const list = byTask.get(t.taskId);
    if (list) list.push(t);
    else byTask.set(t.taskId, [t]);
  }
  const tasks = new Map([...byTask].map(([taskId, tries]) => [taskId, taskInRun(taskId, tries, path)]));
  return { summary, path, tasks };
}

/**
 * FR-DAGD-09: run b against run a, from all the tries of each run. `null` when either run has no started try.
 */
export function compareRuns(
  aTries: readonly DagTaskTry[],
  bTries: readonly DagTaskTry[],
  options: RunOptions = {},
): RunComparison | null {
  const a = side(aTries, options);
  const b = side(bTries, options);
  if (!a || !b) return null;
  const paths = a.path !== null && b.path !== null;
  const ids = [...new Set([...a.tasks.keys(), ...b.tasks.keys()])];
  const tasks = ids.map((taskId): TaskDelta => {
    const x = a.tasks.get(taskId) ?? null;
    const y = b.tasks.get(taskId) ?? null;
    const on = (
      t: TaskInRun | null,
      k: 'criticalSeconds' | 'criticalWaitSeconds' | 'criticalRunningSeconds',
    ) => t?.[k] ?? 0;
    return {
      taskId,
      a: x,
      b: y,
      durationDeltaSeconds: delta(x?.durationSeconds, y?.durationSeconds),
      queueWaitDeltaSeconds: delta(x?.queueWaitSeconds, y?.queueWaitSeconds),
      contributionSeconds: paths ? on(y, 'criticalSeconds') - on(x, 'criticalSeconds') : null,
      contributionWaitSeconds: paths ? on(y, 'criticalWaitSeconds') - on(x, 'criticalWaitSeconds') : null,
      contributionRunningSeconds: paths
        ? on(y, 'criticalRunningSeconds') - on(x, 'criticalRunningSeconds')
        : null,
    };
  });
  const explained = paths
    ? (b.path as CriticalPath).durationSeconds - (a.path as CriticalPath).durationSeconds
    : null;
  const direction = (explained ?? 0) < 0 ? -1 : 1;
  const size = (v: number | null) => (v === null ? -1 : Math.abs(v));
  tasks.sort(
    (x, y) =>
      (paths ? direction * ((y.contributionSeconds ?? 0) - (x.contributionSeconds ?? 0)) : 0) ||
      size(y.durationDeltaSeconds) - size(x.durationDeltaSeconds) ||
      cmp(x.taskId, y.taskId),
  );
  return {
    a: a.summary,
    b: b.summary,
    pathA: a.path,
    pathB: b.path,
    durationDeltaSeconds: delta(a.summary.durationSeconds, b.summary.durationSeconds),
    explainedSeconds: explained,
    ranking: paths ? 'critical-path' : 'duration-delta',
    tasks,
  };
}
