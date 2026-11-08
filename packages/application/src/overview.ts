/**
 * Use case: capacity overview for one environment (the M0 slice of the league table), over any range
 * preset; long ranges are read a day at a time (NFR-PERF-01).
 *
 * @implements HM-003, HM-011, FR-DAGX-03, FR-UI-01, NFR-PERF-01
 */
import type { EnvironmentOverview, Range } from '@dcam/contracts';
import { createCapacityAccumulator } from '@dcam/domain';
import type { Clock, TaskInstanceStore } from '@dcam/ports';
import { RANGE_MS } from './range';
import { earliestOf, historyCoverage, sliceTries, slicesOf } from './slices';

export type SourceId = EnvironmentOverview['sources'][number];

export interface OverviewDeps {
  readonly store: TaskInstanceStore;
  readonly clock: Clock;
}

export interface OverviewQuery {
  readonly envId: string;
  readonly range: Range;
  readonly sources: readonly SourceId[];
}

/** FR-DAGX-03: the smallest number of DAGs whose combined slot-seconds reach 80 % of the total. */
export function paretoCount(values: readonly number[]): number {
  const total = values.reduce((s, v) => s + v, 0);
  if (total <= 0) return 0;
  const sorted = [...values].sort((a, b) => b - a);
  let cumulative = 0;
  for (let i = 0; i < sorted.length; i++) {
    cumulative += sorted[i] as number;
    if (cumulative >= 0.8 * total - 1e-9) return i + 1;
  }
  return sorted.length;
}

export async function getEnvironmentOverview(
  deps: OverviewDeps,
  q: OverviewQuery,
): Promise<EnvironmentOverview> {
  const now = deps.clock.now();
  const window = { from: now - RANGE_MS[q.range], to: now, now };
  const capacity = createCapacityAccumulator(window);
  let earliest = Infinity;
  for (const slice of slicesOf(window.from, window.to)) {
    const tries = await sliceTries(deps.store, q.envId, slice);
    earliest = earliestOf(tries, earliest);
    capacity.add(tries, slice);
  }
  const seconds = capacity.result();
  const total = seconds.totalExecutorSlotSeconds;
  const ranked = [...seconds.byDag.entries()]
    .map(([dagId, s]) => ({ dag_id: dagId, executor_slot_seconds: s }))
    .filter((d) => d.executor_slot_seconds > 0)
    .sort((a, b) => b.executor_slot_seconds - a.executor_slot_seconds || a.dag_id.localeCompare(b.dag_id));
  return {
    env_id: q.envId,
    range: { from: new Date(window.from).toISOString(), to: new Date(window.to).toISOString() },
    coverage: historyCoverage(earliest, window),
    data_as_of: new Date(now).toISOString(),
    sources: [...q.sources],
    approximate: false,
    total_executor_slot_seconds: total,
    peak_concurrency: seconds.peakConcurrency,
    dag_count: ranked.length,
    pareto_80_dag_count: paretoCount(ranked.map((d) => d.executor_slot_seconds)),
    top_dags: ranked
      .slice(0, 10)
      .map((d) => ({ ...d, share: total > 0 ? d.executor_slot_seconds / total : 0 })),
  };
}
