/**
 * Use case: capacity overview for one environment (the M0 slice of the league table).
 *
 * @implements HM-003, HM-011, FR-DAGX-03
 */
import type { EnvironmentOverview } from '@dcam/contracts';
import { TOTAL_KEY, occupancySeries, slotSeconds } from '@dcam/domain';
import type { Clock, TaskInstanceStore } from '@dcam/ports';

export type OverviewRange = '1h' | '6h' | '24h';
export type SourceId = EnvironmentOverview['sources'][number];

const RANGE_MS: Record<OverviewRange, number> = {
  '1h': 3_600_000,
  '6h': 6 * 3_600_000,
  '24h': 24 * 3_600_000,
};

export interface OverviewDeps {
  readonly store: TaskInstanceStore;
  readonly clock: Clock;
}

export interface OverviewQuery {
  readonly envId: string;
  readonly range: OverviewRange;
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
  const tries = await deps.store.taskTries(q.envId, window.from, window.to);
  const seconds = slotSeconds(tries, window);
  const total = seconds.totalExecutorSlotSeconds;
  const ranked = [...seconds.byDag.entries()]
    .map(([dagId, s]) => ({ dag_id: dagId, executor_slot_seconds: s.executorSlotSeconds }))
    .filter((d) => d.executor_slot_seconds > 0)
    .sort((a, b) => b.executor_slot_seconds - a.executor_slot_seconds || a.dag_id.localeCompare(b.dag_id));
  const occupancy = occupancySeries(tries, window).get(TOTAL_KEY) ?? [];
  return {
    env_id: q.envId,
    range: { from: new Date(window.from).toISOString(), to: new Date(window.to).toISOString() },
    data_as_of: new Date(now).toISOString(),
    sources: [...q.sources],
    approximate: false,
    total_executor_slot_seconds: total,
    peak_concurrency: occupancy.reduce((m, b) => Math.max(m, b.max), 0),
    dag_count: ranked.length,
    pareto_80_dag_count: paretoCount(ranked.map((d) => d.executor_slot_seconds)),
    top_dags: ranked
      .slice(0, 10)
      .map((d) => ({ ...d, share: total > 0 ? d.executor_slot_seconds / total : 0 })),
  };
}
