/**
 * One DAG in detail (spec §12.4 S-12): its runs, the tries of one run for a Gantt chart and per-task
 * statistics. How often the DAG's own `max_active_tasks` holds back its ready work (HM-005) is
 * `self-throttling.ts`, shared with the advisor. Pure; times are epoch ms, durations in the results are seconds.
 *
 * @implements FR-DAGD-02, FR-DAGD-03, FR-DAGD-04, HM-002
 */
import {
  groupBy,
  isFailedTry,
  logicalDateFromRunId,
  startedIn,
  triesByRun,
  type DagTaskTry,
  type RunOptions,
  type RunSummary,
} from './dag-runs';
import { MIN_SAMPLES_FOR_RATE, queueWaitsSeconds, runsInWindow } from './dag-league';
import type { SnapshotTaskInstance } from './model';
import { slotSeconds, type SweepWindow } from './occupancy';
import { dataIntervalEnd } from './schedule';
import { quantile, type Quantile } from './stats';

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * What a run's start delay (HM-002) is measured from:
 * - `data_interval_end`: the end of its data interval, from the schedule (the HM-002 method);
 * - `trigger_time`: the logical date, because the run started before its computed interval ended, so
 *   its timetable triggers at the logical date (for example `CronTriggerTimetable`);
 * - `logical_date`: the logical date, because DCAM cannot derive the data interval from the schedule;
 *   for an interval schedule the delay then includes one interval;
 * - `not_scheduled`: a manual, backfill or asset-triggered run, or a custom run ID: no delay (HM-002
 *   counts scheduled runs only).
 */
export type StartDelayBasis = 'data_interval_end' | 'trigger_time' | 'logical_date' | 'not_scheduled';

export interface DagRunRow extends RunSummary {
  /** Logical date from the run ID; `null` for custom run IDs. */
  readonly logicalDate: number | null;
  /** First task start − the expected start ({@link startDelayBasis}), seconds; `null` when not measured. */
  readonly startDelaySeconds: number | null;
  readonly startDelayBasis: StartDelayBasis;
}

/**
 * Airflow 2 names scheduler-created runs `scheduled__<logical date>` (`DagRunType.SCHEDULED`,
 * airflow/utils/types.py; `DagRun.generate_run_id`).
 */
const SCHEDULED_PREFIX = 'scheduled__';

function startDelay(
  run: RunSummary,
  logicalDate: number | null,
  schedule: string | null,
): Pick<DagRunRow, 'startDelaySeconds' | 'startDelayBasis'> {
  if (logicalDate === null || !run.runId.startsWith(SCHEDULED_PREFIX))
    return { startDelaySeconds: null, startDelayBasis: 'not_scheduled' };
  const end = schedule === null ? null : dataIntervalEnd(schedule, logicalDate);
  const seconds = (from: number) => {
    const s = (run.startAt - from) / 1000;
    return s >= 0 ? s : null;
  };
  if (end !== null && run.startAt >= end)
    return { startDelaySeconds: seconds(end), startDelayBasis: 'data_interval_end' };
  return {
    startDelaySeconds: seconds(logicalDate),
    startDelayBasis: end !== null ? 'trigger_time' : 'logical_date',
  };
}

/**
 * FR-DAGD-02: runs of one DAG with a try starting in the window, oldest first, with their start delay
 * (HM-002) measured from the end of the data interval of `schedule` where DCAM can derive it. The start
 * is the first task start, which follows the run's own start by the time to queue its first task.
 */
export function dagRuns(
  tries: readonly DagTaskTry[],
  w: SweepWindow,
  options: RunOptions = {},
  schedule: string | null = null,
): DagRunRow[] {
  return runsInWindow(tries, w, options)
    .map((r): DagRunRow => {
      const logicalDate = logicalDateFromRunId(r.runId);
      return { ...r, logicalDate, ...startDelay(r, logicalDate, schedule) };
    })
    .sort((a, b) => a.startAt - b.startAt || byId(a.runId, b.runId));
}

export interface GanttRow {
  readonly taskId: string;
  readonly mapIndex: number;
  readonly tryNumber: number;
  /** Try state, or `scheduled` / `queued` for work still waiting in the latest snapshot. */
  readonly state: string | null;
  readonly readyAt: number | null;
  readonly queuedAt: number | null;
  readonly startAt: number | null;
  readonly endAt: number | null;
}

/** Work of the run still waiting in the latest live snapshot. */
export interface WaitingWork {
  readonly scheduled: readonly SnapshotTaskInstance[];
  readonly queued: readonly SnapshotTaskInstance[];
}

const firstSeen = (r: GanttRow) => r.readyAt ?? r.queuedAt ?? r.startAt ?? Infinity;

/** FR-DAGD-03: every try of one run, plus its waiting task instances, in the order they became ready. */
export function runGantt(
  tries: readonly DagTaskTry[],
  dagId: string,
  runId: string,
  waiting: WaitingWork | null = null,
): GanttRow[] {
  const rows: GanttRow[] = tries
    .filter((t) => t.dagId === dagId && t.runId === runId)
    .map((t) => ({
      taskId: t.taskId,
      mapIndex: t.mapIndex,
      tryNumber: t.tryNumber,
      state: t.state,
      readyAt: t.readyAt,
      queuedAt: t.queuedAt,
      startAt: t.startAt,
      endAt: t.startAt === null ? null : t.endAt,
    }));
  const seen = new Set(rows.map((r) => `${r.taskId}|${r.mapIndex}|${r.tryNumber}`));
  const add = (ti: SnapshotTaskInstance, state: 'scheduled' | 'queued') => {
    if (ti.dagId !== dagId || ti.runId !== runId) return;
    const key = `${ti.taskId}|${ti.mapIndex}|${ti.tryNumber}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({
      taskId: ti.taskId,
      mapIndex: ti.mapIndex,
      tryNumber: ti.tryNumber,
      state,
      readyAt: state === 'scheduled' ? ti.since : null,
      queuedAt: state === 'queued' ? ti.since : null,
      startAt: null,
      endAt: null,
    });
  };
  for (const ti of waiting?.scheduled ?? []) add(ti, 'scheduled');
  for (const ti of waiting?.queued ?? []) add(ti, 'queued');
  return rows.sort(
    (a, b) =>
      firstSeen(a) - firstSeen(b) ||
      byId(a.taskId, b.taskId) ||
      a.mapIndex - b.mapIndex ||
      a.tryNumber - b.tryNumber,
  );
}

export interface TaskStats {
  readonly taskId: string;
  /** Tries starting in the window (all map indexes). */
  readonly tries: number;
  /** Finished tries: end − start. */
  readonly durationP50: Quantile;
  readonly durationP95: Quantile;
  readonly queueWaitP95: Quantile;
  readonly retries: number;
  /** Failed tries ÷ tries; `null` below 20 tries (HM-015). */
  readonly failureRate: number | null;
  /** Share of the DAG's executor slot-seconds in the window (HM-003). */
  readonly slotSecondsShare: number;
  /** Mean running time per run of the DAG in the window: the default sort (FR-DAGD-04). */
  readonly contributionSeconds: number;
}

/** FR-DAGD-04: statistics per task of one DAG, by contribution to run duration (largest first). */
export function taskStats(tries: readonly DagTaskTry[], w: SweepWindow): TaskStats[] {
  // Running time per task over the runs with a try starting in the window, measured whole.
  const runningMsByTask = new Map<string, number>();
  let runCount = 0;
  for (const runTries of triesByRun(tries)) {
    if (!runTries.some((t) => startedIn(t, w))) continue;
    runCount++;
    for (const t of runTries)
      if (t.startAt !== null)
        runningMsByTask.set(
          t.taskId,
          (runningMsByTask.get(t.taskId) ?? 0) + Math.max(0, (t.endAt ?? w.now) - t.startAt),
        );
  }
  // HM-003 per task: the same clipping as per DAG, keyed by task.
  const perTask = slotSeconds(tries, w, (t) => t.taskId).byDag;
  let dagSeconds = 0;
  for (const s of perTask.values()) dagSeconds += s.executorSlotSeconds;

  const stats: TaskStats[] = [];
  for (const [taskId, taskTries] of groupBy(tries, (t) => t.taskId)) {
    const started = taskTries.filter((t) => startedIn(t, w));
    const runningMs = runningMsByTask.get(taskId) ?? 0;
    if (started.length === 0 && runningMs === 0 && !perTask.has(taskId)) continue;
    const durations = started
      .filter((t) => t.startAt !== null && t.endAt !== null && t.endAt >= t.startAt)
      .map((t) => ((t.endAt as number) - (t.startAt as number)) / 1000);
    const seconds = perTask.get(taskId)?.executorSlotSeconds ?? 0;
    stats.push({
      taskId,
      tries: started.length,
      durationP50: quantile(durations, 0.5),
      durationP95: quantile(durations, 0.95),
      queueWaitP95: quantile(queueWaitsSeconds(started), 0.95),
      retries: started.filter((t) => t.tryNumber > 1).length,
      failureRate:
        started.length >= MIN_SAMPLES_FOR_RATE ? started.filter(isFailedTry).length / started.length : null,
      slotSecondsShare: dagSeconds > 0 ? Math.min(1, seconds / dagSeconds) : 0,
      contributionSeconds: runCount > 0 ? runningMs / 1000 / runCount : 0,
    });
  }
  return stats.sort((a, b) => b.contributionSeconds - a.contributionSeconds || byId(a.taskId, b.taskId));
}
