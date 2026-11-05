/**
 * Use cases: the DAG league table (S-11) and one DAG in detail (S-12), over task tries, the environment
 * model and the injected clock.
 *
 * @implements FR-DAGX-01, FR-DAGX-02, FR-DAGX-03, FR-DAGD-01, FR-DAGD-02, FR-DAGD-03, FR-DAGD-04,
 *   HM-001, HM-003, HM-005, HM-015
 */
import type { DagDetail, DagLeague, FindingRef, Quantile, Range, SourceId } from '@dcam/contracts';
import {
  dagLeague,
  dagRuns,
  dagWindowStats,
  emptyDagStats,
  runGantt,
  runKey,
  selfThrottledRatio,
  slotSeconds,
  taskStats,
  type DagMeta,
  type EnvironmentConfig,
  type LiveSnapshot,
  type Quantile as DomainQuantile,
  type SweepWindow,
} from '@dcam/domain';
import type { Clock, EnvironmentModelSource, StoredTaskTry, TaskInstanceStore } from '@dcam/ports';
import { paretoCount } from './overview';

const RANGE_MS: Record<Range, number> = {
  '1h': 3_600_000,
  '6h': 6 * 3_600_000,
  '24h': 24 * 3_600_000,
};

/** A snapshot older than this cannot tell whether a run still has work waiting (cadence is 30 s). */
const FRESH_SNAPSHOT_MS = 2 * 60_000;
/** Team shown for DAGs that have tries but no metadata (for example deleted DAGs). */
export const UNASSIGNED_TEAM = 'unassigned';

export interface DagsDeps {
  readonly store: TaskInstanceStore;
  readonly model: EnvironmentModelSource;
  readonly clock: Clock;
}

const iso = (ms: number) => new Date(ms).toISOString();
const toQuantile = (q: DomainQuantile): Quantile => ({
  value_seconds: q.value,
  samples: q.samples,
  low_sample: q.lowSample,
});

/** The selected range ending now, and the previous range of equal length. */
function windowsFor(now: number, range: Range): { current: SweepWindow; previous: SweepWindow } {
  const length = RANGE_MS[range];
  return {
    current: { from: now - length, to: now, now },
    previous: { from: now - 2 * length, to: now - length, now },
  };
}

function freshLatest(snapshots: readonly LiveSnapshot[], now: number): LiveSnapshot | null {
  const latest = snapshots.at(-1);
  return latest && latest.at >= now - FRESH_SNAPSHOT_MS ? latest : null;
}

/** Runs with task instances still waiting in the latest live snapshot. */
function waitingIn(snapshot: LiveSnapshot | null): (dagId: string, runId: string) => boolean {
  const keys = new Set(
    [...(snapshot?.scheduled ?? []), ...(snapshot?.queued ?? [])].map((ti) => runKey(ti.dagId, ti.runId)),
  );
  return (dagId, runId) => keys.has(runKey(dagId, runId));
}

export interface DagLeagueQuery {
  readonly envId: string;
  readonly range: Range;
  readonly sources: readonly SourceId[];
  /** Open findings per DAG, from the advisor; 0 when absent. */
  readonly openFindings?: ReadonlyMap<string, number>;
}

export async function getDagLeague(deps: DagsDeps, q: DagLeagueQuery): Promise<DagLeague> {
  const now = deps.clock.now();
  const { current, previous } = windowsFor(now, q.range);
  const [tries, dags, recent] = await Promise.all([
    deps.store.taskTries(q.envId, previous.from, now),
    deps.model.dags(q.envId),
    deps.model.snapshots(q.envId, now - FRESH_SNAPSHOT_MS, now + 1),
  ]);
  const league = dagLeague({
    tries,
    window: current,
    previousWindow: previous,
    dagIds: dags.map((d) => d.dagId),
    inProgress: waitingIn(freshLatest(recent, now)),
  });
  const metaById = new Map(dags.map((d) => [d.dagId, d]));
  const rows = league.rows.map((r): DagLeague['rows'][number] => {
    const meta = metaById.get(r.dagId);
    return {
      dag_id: r.dagId,
      team: meta?.team ?? UNASSIGNED_TEAM,
      owners: [...(meta?.owners ?? [])],
      tags: [...(meta?.tags ?? [])],
      schedule: meta?.schedule ?? '',
      paused: meta?.paused ?? false,
      runs: r.runs,
      failed_runs: r.failedRuns,
      success_rate: r.successRate,
      tries: r.tries,
      retries: r.retries,
      flaky_rate: r.flakyRate,
      run_duration_p50: toQuantile(r.runDurationP50),
      run_duration_p95: toQuantile(r.runDurationP95),
      executor_slot_seconds: r.executorSlotSeconds,
      share: r.share,
      cumulative_share: r.cumulativeShare,
      previous_share: r.previousShare,
      peak_concurrency: r.peakConcurrency,
      queue_wait_p95: toQuantile(r.queueWaitP95),
      ready_wait_p95: toQuantile(r.readyWaitP95),
      open_findings: q.openFindings?.get(r.dagId) ?? 0,
    };
  });
  return {
    env_id: q.envId,
    range: { from: iso(current.from), to: iso(current.to) },
    previous_range: { from: iso(previous.from), to: iso(previous.to) },
    data_as_of: iso(now),
    sources: [...q.sources],
    total_executor_slot_seconds: league.totalExecutorSlotSeconds,
    dag_count: rows.length,
    active_dag_count: league.activeDagCount,
    pareto_80_dag_count: paretoCount(rows.map((r) => r.executor_slot_seconds)),
    gini: league.gini,
    rows,
  };
}

export interface DagDetailQuery {
  readonly envId: string;
  readonly dagId: string;
  readonly range: Range;
  /** Run shown in the Gantt chart; the latest run by default. */
  readonly runId?: string;
  readonly sources: readonly SourceId[];
  /** Findings for this DAG, from the advisor. */
  readonly findings?: readonly FindingRef[];
}

export type DagDetailResult =
  | { readonly kind: 'ok'; readonly detail: DagDetail }
  | { readonly kind: 'unknown-environment' }
  | { readonly kind: 'unknown-dag' }
  | { readonly kind: 'unknown-run' };

/** FR-DAGD-01: the DAG's own limits, its pools, and the environment-wide ceilings. */
function limitsOf(
  meta: DagMeta,
  config: EnvironmentConfig,
  tries: readonly StoredTaskTry[],
  snapshots: readonly LiveSnapshot[],
): DagDetail['meta']['limits'] {
  const poolSlots = new Map<string, number>();
  const note = (pool: string, slots: number) =>
    poolSlots.set(pool, Math.max(poolSlots.get(pool) ?? 1, slots));
  for (const t of tries) note(t.pool, t.poolSlots);
  for (const s of snapshots)
    for (const ti of [...s.scheduled, ...s.queued]) if (ti.dagId === meta.dagId) note(ti.pool, ti.poolSlots);
  const sizes = new Map(config.pools.map((p) => [p.name, p.slots]));
  return {
    max_active_tasks: meta.maxActiveTasks,
    max_active_runs: meta.maxActiveRuns,
    pools: [...poolSlots]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, slots]) => ({ name, slots: sizes.get(name) ?? 0, pool_slots: Math.max(1, slots) })),
    parallelism: config.parallelism * config.schedulers,
    worker_slots: config.maxWorkers * config.workerConcurrency,
  };
}

export async function getDagDetail(deps: DagsDeps, q: DagDetailQuery): Promise<DagDetailResult> {
  const now = deps.clock.now();
  const { current, previous } = windowsFor(now, q.range);
  const [dags, config] = await Promise.all([deps.model.dags(q.envId), deps.model.config(q.envId)]);
  if (!config) return { kind: 'unknown-environment' };
  const meta = dags.find((d) => d.dagId === q.dagId);
  if (!meta) return { kind: 'unknown-dag' };

  // Tries from the previous range too, so runs that began before the range are seen whole.
  const [tries, snapshots] = await Promise.all([
    deps.store.taskTries(q.envId, previous.from, now),
    deps.model.snapshots(q.envId, current.from, now + 1),
  ]);
  const dagTries = tries.filter((t) => t.dagId === q.dagId);
  if (q.runId !== undefined && !dagTries.some((t) => t.runId === q.runId)) return { kind: 'unknown-run' };

  const latest = freshLatest(snapshots, now);
  const options = { inProgress: waitingIn(latest) };
  const stats = dagWindowStats(dagTries, current, options).get(q.dagId) ?? emptyDagStats(q.dagId);
  const environmentSeconds = slotSeconds(tries, current).totalExecutorSlotSeconds;
  const runs = dagRuns(dagTries, current, options);
  const ganttRunId = q.runId ?? runs.at(-1)?.runId ?? null;
  const gantt = ganttRunId === null ? [] : runGantt(dagTries, q.dagId, ganttRunId, latest);
  const isoOrNull = (ms: number | null) => (ms === null ? null : iso(ms));

  return {
    kind: 'ok',
    detail: {
      env_id: q.envId,
      dag_id: q.dagId,
      range: { from: iso(current.from), to: iso(current.to) },
      data_as_of: iso(now),
      sources: [...q.sources],
      meta: {
        fileloc: meta.fileloc,
        owners: [...meta.owners],
        tags: [...meta.tags],
        team: meta.team,
        schedule: meta.schedule,
        paused: meta.paused,
        catchup: meta.catchup,
        limits: limitsOf(meta, config, dagTries, latest ? [latest] : []),
      },
      stats: {
        runs: stats.runs,
        success_rate: stats.successRate,
        executor_slot_seconds: stats.executorSlotSeconds,
        share: environmentSeconds > 0 ? Math.min(1, stats.executorSlotSeconds / environmentSeconds) : 0,
        run_duration_p95: toQuantile(stats.runDurationP95),
        queue_wait_p95: toQuantile(stats.queueWaitP95),
        self_throttled_ratio: selfThrottledRatio(snapshots, q.dagId, meta.maxActiveTasks),
      },
      runs: runs.map((r) => ({
        run_id: r.runId,
        state: r.state,
        // Custom run IDs carry no logical date; the first start stands in (the start delay stays null).
        logical_date: iso(r.logicalDate ?? r.startAt),
        start: iso(r.startAt),
        end: isoOrNull(r.endAt),
        duration_seconds: r.durationSeconds,
        start_delay_seconds: r.startDelaySeconds,
        tries: r.tries,
      })),
      gantt: {
        run_id: ganttRunId,
        rows: gantt.map((g) => ({
          task_id: g.taskId,
          try_number: Math.max(1, g.tryNumber),
          state: g.state,
          ready_at: isoOrNull(g.readyAt),
          queued_at: isoOrNull(g.queuedAt),
          start: isoOrNull(g.startAt),
          end: isoOrNull(g.endAt),
        })),
      },
      tasks: taskStats(dagTries, current).map((t) => ({
        task_id: t.taskId,
        tries: t.tries,
        duration_p50: toQuantile(t.durationP50),
        duration_p95: toQuantile(t.durationP95),
        queue_wait_p95: toQuantile(t.queueWaitP95),
        retries: t.retries,
        failure_rate: t.failureRate,
        slot_seconds_share: t.slotSecondsShare,
        contribution_seconds: t.contributionSeconds,
      })),
      findings: [...(q.findings ?? [])],
    },
  };
}
