/**
 * Schedule intelligence (S-17, FR-BOTL-03, HM-009): where planned and actual DAG run starts fall in the
 * day, as an hour-of-day × minute-of-hour heatmap in UTC, and which minutes and schedules collide most.
 *
 * - **Planned** starts expand each unpaused DAG's cron schedule (`schedule.ts`) into average starts per
 *   day per cell; day-of-week, day-of-month and month restrictions become fractions. DCAM does not collect
 *   DAG time zones, so cron times are UTC.
 * - **Actual** starts come from task instance tries: DCAM stores no DAG runs, so a run starts with its first
 *   try start. Runs whose first try started before the range are left out, so the caller passes tries from
 *   before the range too. Before DCAM's history starts nothing is known: those hours are no days of the
 *   range (`days`, `coverage`), never zero starts.
 *
 * @implements FR-BOTL-03, HM-009
 */
import type { DagMeta } from './model';
import type { TaskTry } from './occupancy';
import { cronKey, dailyStartsByHourMinute } from './schedule';

const CELLS = 24 * 60;
const DAY_MS = 86_400_000;

export interface PlannedStarts {
  /** Starts per day, index `hour × 60 + minute` (UTC). */
  readonly cells: readonly number[];
  readonly totalDailyStarts: number;
  /** Unpaused DAGs with a cron schedule. */
  readonly scheduledDags: number;
  /** Unpaused DAGs without a fixed start minute (not counted). */
  readonly unscheduled: readonly string[];
}

export interface ActualStarts {
  /** Runs that started in each cell over the range, index `hour × 60 + minute` (UTC). */
  readonly cells: readonly number[];
  readonly runs: number;
  /** Days of the range with task history (cells ÷ days = runs per day); 0 without history. */
  readonly days: number;
  /** Where the task history starts; `null` without history. */
  readonly historyFrom: number | null;
  /** Share of the range with task history, 0–1. */
  readonly coverage: number;
}

export interface ActualStartsWindow {
  readonly from: number;
  readonly to: number;
  /**
   * Where the environment's task history starts (`null`: none yet). Absent means it covers the range.
   */
  readonly historyFrom?: number | null;
}

export interface CollidingMinute {
  readonly minute: number;
  readonly startsPerDay: number;
  /** Share of all planned daily starts, 0–1 (HM-009 collision index for the busiest minute). */
  readonly share: number;
  readonly dags: number;
  /** Schedules starting in the minute, by the number of DAGs that use them. */
  readonly schedules: ReadonlyArray<{ readonly schedule: string; readonly dags: number }>;
  /** DAGs starting in the minute, most starts there first. */
  readonly topDags: readonly string[];
}

export interface CollidingSchedule {
  /** The spelling most DAGs in the group use. */
  readonly schedule: string;
  readonly dags: number;
  readonly startsPerDay: number;
  /** Minutes of the hour it starts in. */
  readonly minutes: readonly number[];
  readonly exampleDags: readonly string[];
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

interface Expanded {
  readonly dag: DagMeta;
  readonly cells: readonly number[];
}

function expandAll(dags: readonly DagMeta[]): { expanded: Expanded[]; unscheduled: string[] } {
  const expanded: Expanded[] = [];
  const unscheduled: string[] = [];
  for (const dag of dags) {
    if (dag.paused) continue;
    const cells = dailyStartsByHourMinute(dag.schedule);
    if (cells) expanded.push({ dag, cells });
    else unscheduled.push(dag.dagId);
  }
  return { expanded, unscheduled };
}

export function plannedStarts(dags: readonly DagMeta[]): PlannedStarts {
  const { expanded, unscheduled } = expandAll(dags);
  const cells = new Array<number>(CELLS).fill(0);
  for (const e of expanded) e.cells.forEach((n, i) => n > 0 && (cells[i] = (cells[i] ?? 0) + n));
  return {
    cells,
    totalDailyStarts: cells.reduce((s, n) => s + n, 0),
    scheduledDags: expanded.length,
    unscheduled,
  };
}

export function actualRunStarts(tries: readonly TaskTry[], window: ActualStartsWindow): ActualStarts {
  const acc = createActualRunStarts(window);
  acc.add(tries);
  return acc.result(window.historyFrom);
}

/**
 * {@link actualRunStarts} over tries added in batches, for example one store slice a day at a time
 * (NFR-PERF-01). A run's start is its earliest try start, so a try read in two slices changes nothing. The
 * history start, often known only once the tries are read, is given to `result`.
 */
export function createActualRunStarts(window: Pick<ActualStartsWindow, 'from' | 'to'>) {
  // Nested on the tries' own strings: no composite key per try.
  const first = new Map<string, Map<string, number>>();
  return {
    add(tries: readonly TaskTry[]): void {
      for (const t of tries) {
        if (t.startAt === null) continue;
        let runs = first.get(t.dagId);
        if (!runs) first.set(t.dagId, (runs = new Map<string, number>()));
        const seen = runs.get(t.runId);
        if (seen === undefined || t.startAt < seen) runs.set(t.runId, t.startAt);
      }
    },
    /** `historyFrom` as in {@link ActualStartsWindow}: absent means the history covers the range. */
    result(historyFrom: number | null | undefined = undefined): ActualStarts {
      const cells = new Array<number>(CELLS).fill(0);
      let runs = 0;
      for (const byRun of first.values())
        for (const at of byRun.values()) {
          if (at < window.from || at >= window.to) continue;
          const d = new Date(at);
          const i = d.getUTCHours() * 60 + d.getUTCMinutes();
          cells[i] = (cells[i] ?? 0) + 1;
          runs++;
        }
      const start = historyFrom === undefined ? window.from : historyFrom;
      const length = window.to - window.from;
      const covered = start === null ? 0 : Math.max(0, window.to - Math.max(window.from, start));
      return {
        cells,
        runs,
        days: covered / DAY_MS,
        historyFrom: start,
        coverage: length > 0 ? Math.min(1, covered / length) : 0,
      };
    },
  };
}

/** Starts per day of each minute-of-hour for one DAG. */
const byMinute = (cells: readonly number[]) => {
  const out = new Array<number>(60).fill(0);
  cells.forEach((n, i) => (out[i % 60] = (out[i % 60] ?? 0) + n));
  return out;
};

/** The `limit` minutes of the hour with the most planned starts per day (FR-BOTL-03). */
export function collidingMinutes(dags: readonly DagMeta[], limit = 5): CollidingMinute[] {
  const { expanded } = expandAll(dags);
  const perDag = expanded.map((e) => ({ dag: e.dag, minutes: byMinute(e.cells) }));
  const totals = new Array<number>(60).fill(0);
  for (const d of perDag) d.minutes.forEach((n, m) => (totals[m] = (totals[m] ?? 0) + n));
  const all = totals.reduce((s, n) => s + n, 0);
  return totals
    .map((n, minute) => ({ minute, n }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n || a.minute - b.minute)
    .slice(0, limit)
    .map(({ minute, n }) => {
      const here = perDag
        .filter((d) => (d.minutes[minute] ?? 0) > 0)
        .sort((a, b) => (b.minutes[minute] ?? 0) - (a.minutes[minute] ?? 0) || cmp(a.dag.dagId, b.dag.dagId));
      const schedules = new Map<string, number>();
      for (const d of here) schedules.set(d.dag.schedule, (schedules.get(d.dag.schedule) ?? 0) + 1);
      return {
        minute,
        startsPerDay: n,
        share: all > 0 ? n / all : 0,
        dags: here.length,
        schedules: [...schedules]
          .sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))
          .slice(0, 5)
          .map(([schedule, count]) => ({ schedule, dags: count })),
        topDags: here.slice(0, 10).map((d) => d.dag.dagId),
      };
    });
}

/** Schedules that at least two unpaused DAGs share, most DAGs first (FR-BOTL-03 "most colliding schedules"). */
export function collidingSchedules(dags: readonly DagMeta[], limit = 10): CollidingSchedule[] {
  const { expanded } = expandAll(dags);
  const groups = new Map<string, Expanded[]>();
  for (const e of expanded) {
    const key = cronKey(e.dag.schedule);
    const list = groups.get(key);
    if (list) list.push(e);
    else groups.set(key, [e]);
  }
  return [...groups.values()]
    .filter((g) => g.length >= 2)
    .map((g): CollidingSchedule => {
      const spellings = new Map<string, number>();
      for (const e of g) spellings.set(e.dag.schedule, (spellings.get(e.dag.schedule) ?? 0) + 1);
      const [schedule] = [...spellings].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))[0] as [string, number];
      const cells = (g[0] as Expanded).cells;
      const minutes = byMinute(cells)
        .map((n, m) => (n > 0 ? m : -1))
        .filter((m) => m >= 0);
      return {
        schedule,
        dags: g.length,
        startsPerDay: g.length * cells.reduce((s, n) => s + n, 0),
        minutes,
        exampleDags: g
          .map((e) => e.dag.dagId)
          .sort(cmp)
          .slice(0, 5),
      };
    })
    .sort((a, b) => b.dags - a.dags || b.startsPerDay - a.startsPerDay || cmp(a.schedule, b.schedule))
    .slice(0, limit);
}
