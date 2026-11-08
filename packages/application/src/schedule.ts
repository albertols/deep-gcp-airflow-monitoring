/**
 * Use case: schedule intelligence (S-17). Planned starts from the DAG inventory's cron schedules and
 * actual run starts from task instance tries, by hour of day and minute of hour (UTC), with the HM-009
 * collision index against the REC-SCHED-01 threshold and the minutes and schedules that collide most.
 * Any range preset; tries are read a day at a time (NFR-PERF-01).
 *
 * The store returns the tries that overlap a window, so a run whose first task ended before the range would
 * start at its next task: the read reaches {@link RUN_START_LOOKBACK_MS} before the range to find each run's
 * first start. A run whose earlier tries all ended longer before (a task cleared days later) still counts
 * as starting at its later try. Before the environment's history starts the range is uncovered, not zero.
 *
 * @implements FR-BOTL-03, HM-009, FR-UI-01, NFR-PERF-01
 */
import type { Range, Schedule, SourceId } from '@dcam/contracts';
import {
  RULE_THRESHOLDS,
  collidingMinutes,
  createActualRunStarts,
  collidingSchedules,
  collisionDensity,
  plannedStarts,
} from '@dcam/domain';
import type { Clock, EnvironmentModelSource, TaskInstanceStore } from '@dcam/ports';
import { readHistoryStart } from './history';
import { RANGE_MS } from './range';
import { earliestOf, sliceTries, slicesOf } from './slices';
import { NO_SOURCE_USE, usedSources } from './sources';

/** How far before the range tries are read to find where runs that overlap it started. */
export const RUN_START_LOOKBACK_MS = 86_400_000;

export interface ScheduleDeps {
  readonly store: TaskInstanceStore;
  readonly model: EnvironmentModelSource;
  readonly clock: Clock;
}

export interface ScheduleQuery {
  readonly envId: string;
  readonly range: Range;
  readonly sources: readonly SourceId[];
}

const iso = (ms: number) => new Date(ms).toISOString();

/** The non-empty cells of a 24 × 60 heatmap (index `hour × 60 + minute`). */
function nonEmpty(cells: readonly number[]): Array<{ hour: number; minute: number; value: number }> {
  const out: Array<{ hour: number; minute: number; value: number }> = [];
  cells.forEach((value, i) => value > 0 && out.push({ hour: Math.floor(i / 60), minute: i % 60, value }));
  return out;
}

export async function getScheduleIntelligence(deps: ScheduleDeps, q: ScheduleQuery): Promise<Schedule> {
  const now = deps.clock.now();
  const from = now - RANGE_MS[q.range];
  const readFrom = from - RUN_START_LOOKBACK_MS;
  const [dags, storedHistory] = await Promise.all([
    deps.model.dags(q.envId),
    readHistoryStart(deps.store, q.envId),
  ]);
  const planned = plannedStarts(dags);
  const density = collisionDensity(dags);
  // A run's first start, the newest activity and the earliest try are the same however often a try is read,
  // so the slices need no de-duplication; a slice read 1 ms early must not add a try that ended then.
  const starts = createActualRunStarts({ from, to: now });
  let earliest = Infinity;
  let newest: number | null = null;
  for (const slice of slicesOf(readFrom, now)) {
    const tries = (await sliceTries(deps.store, q.envId, slice)).filter(
      (t) => t.startAt !== null && (t.endAt === null || t.endAt > readFrom),
    );
    starts.add(tries);
    earliest = earliestOf(tries, earliest);
    for (const t of tries) {
      const at = Math.min(now, Math.max(t.startAt ?? from, t.endAt ?? from));
      if (newest === null || at > newest) newest = at;
    }
  }
  const historyFrom =
    storedHistory !== undefined ? storedHistory : Number.isFinite(earliest) ? earliest : null;
  const actual = starts.result(historyFrom);

  // The newest activity the page shows; without runs the inventory is as fresh as this request.
  let latest: number | null = dags.length > 0 ? now : null;
  if (newest !== null) latest = Math.max(from, newest);

  return {
    env_id: q.envId,
    range: { from: iso(from), to: iso(now) },
    data_as_of: latest === null ? null : iso(latest),
    // Schedules and runs both come from the Airflow REST API; with neither, the page has no source.
    sources: latest === null ? [] : usedSources(q.sources, { ...NO_SOURCE_USE, airflow: true }),
    time_zone: 'UTC',
    collision: {
      index: density.collisionIndex,
      busiest_minute: density.busiestMinute,
      total_daily_starts: density.totalDailyStarts,
      threshold: RULE_THRESHOLDS['REC-SCHED-01'].minCollisionIndex,
      scheduled_dags: planned.scheduledDags,
      unscheduled_dags: planned.unscheduled.length,
    },
    planned: {
      cells: nonEmpty(planned.cells).map((c) => ({
        hour: c.hour,
        minute: c.minute,
        starts_per_day: c.value,
      })),
    },
    actual: {
      runs: actual.runs,
      days: actual.days,
      history_from: actual.historyFrom === null ? null : iso(actual.historyFrom),
      coverage: actual.coverage,
      cells: nonEmpty(actual.cells).map((c) => ({ hour: c.hour, minute: c.minute, runs: c.value })),
    },
    top_minutes: collidingMinutes(dags, 5).map((m) => ({
      minute: m.minute,
      starts_per_day: m.startsPerDay,
      share: m.share,
      dags: m.dags,
      schedules: m.schedules.map((s) => ({ schedule: s.schedule, dags: s.dags })),
      top_dags: [...m.topDags],
    })),
    top_schedules: collidingSchedules(dags, 10).map((s) => ({
      schedule: s.schedule,
      dags: s.dags,
      starts_per_day: s.startsPerDay,
      minutes: [...s.minutes],
      example_dags: [...s.exampleDags],
    })),
  };
}
