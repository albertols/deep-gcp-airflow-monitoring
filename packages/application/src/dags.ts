/**
 * Use cases: the DAG league table (S-11) and one DAG in detail (S-12), over task tries, the environment
 * model and the injected clock.
 *
 * @implements FR-DAGX-01, FR-DAGX-02, FR-DAGX-03, FR-DAGD-01, FR-DAGD-02, FR-DAGD-03, FR-DAGD-04,
 *   FR-TASK-01, FR-TASK-02, HM-001, HM-003, HM-005, HM-007, HM-015, HM-016
 */
import type {
  DagDetail,
  DagLeague,
  DurationDistribution,
  DurationRegression,
  FindingRef,
  Quantile,
  Range,
  SourceId,
  TaskReliability,
} from '@dcam/contracts';
import {
  DURATION_REGRESSION_RULE,
  SNAPSHOT_GAP_CADENCES,
  criticalPath,
  criticalPathFrequency,
  dagDurationRegression,
  dagLeague,
  dagReliability,
  dagRuns,
  dagWindowStats,
  emptyDagStats,
  limitKnown,
  observedCadenceMs,
  runGantt,
  runKey,
  selfThrottledRatio,
  slotSeconds,
  taskStats,
  type DagMeta,
  type DurationDistribution as DomainDistribution,
  type EnvironmentConfig,
  type LiveSnapshot,
  type Quantile as DomainQuantile,
  type RegressionVerdict,
  type SweepWindow,
  type TaskReliability as DomainTaskReliability,
} from '@dcam/domain';
import type { Clock, EnvironmentModelSource, StoredTaskTry, TaskInstanceStore } from '@dcam/ports';
import { DEFAULT_SNAPSHOT_CADENCE_MS } from './bottlenecks';
import { earliestTry, historyStartOf, readHistoryStart } from './history';
import { paretoCount } from './overview';

const RANGE_MS: Record<Range, number> = {
  '1h': 3_600_000,
  '6h': 6 * 3_600_000,
  '24h': 24 * 3_600_000,
};

/** How far back the league looks for the latest live snapshot: five eco-profile cadences (120 s). */
const RECENT_SNAPSHOTS_MS = 10 * 60_000;
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

/**
 * The latest live snapshot while it can still tell whether a run has work waiting: within two observed
 * `af.live` cadences (10 s live, 30 s standard, 120 s eco by default); older means collection stopped.
 */
function freshLatest(snapshots: readonly LiveSnapshot[], now: number): LiveSnapshot | null {
  const latest = snapshots.at(-1);
  if (!latest) return null;
  const cadenceMs = observedCadenceMs(snapshots.slice(-10)) ?? DEFAULT_SNAPSHOT_CADENCE_MS;
  return now - latest.at <= SNAPSHOT_GAP_CADENCES * cadenceMs ? latest : null;
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

/**
 * Share of a window with collected task history, from where the environment's history starts. History
 * starts at the earliest stored try of the environment (`history.ts`): `af.facts` reads one hour before
 * DCAM's first cycle, and `af.backfill` (FR-COLL-04) reads the days before that newest first, so the stored
 * history stays contiguous back to that try. A quiet start of the window reads as uncovered, so DCAM says
 * "no data" rather than claim a DAG did not run.
 */
function historyCoverage(historyFrom: number | null, w: SweepWindow): number {
  if (historyFrom === null) return 0;
  return Math.min(1, Math.max(0, (w.to - Math.max(w.from, historyFrom)) / (w.to - w.from)));
}

export async function getDagLeague(deps: DagsDeps, q: DagLeagueQuery): Promise<DagLeague> {
  const now = deps.clock.now();
  const { current, previous } = windowsFor(now, q.range);
  const [tries, dags, recent] = await Promise.all([
    deps.store.taskTries(q.envId, previous.from, now),
    deps.model.dags(q.envId),
    deps.model.snapshots(q.envId, now - RECENT_SNAPSHOTS_MS, now + 1),
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
      flaky_inferred: r.flakyInferred,
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
    previous_coverage: historyCoverage(earliestTry(tries), previous),
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
  /** Run shown in the Gantt chart; the latest finished run by default. */
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
    // Limits DCAM does not know are null, never the placeholder (HM-032).
    parallelism: limitKnown(config, 'parallelism') ? config.parallelism * config.schedulers : null,
    worker_slots: limitKnown(config, 'workerConcurrency')
      ? config.maxWorkers * config.workerConcurrency
      : null,
  };
}

const DAY_MS = 86_400_000;

const toDistribution = (d: DomainDistribution): DurationDistribution => ({
  samples: d.samples,
  min: d.min,
  p25: d.p25,
  p50: d.p50,
  p75: d.p75,
  p95: d.p95,
  max: d.max,
  low_sample: d.lowSample,
});

const REGRESSION_STATUS: Record<RegressionVerdict['status'], DurationRegression['status']> = {
  regression: 'regression',
  'within-baseline': 'within_baseline',
  'low-sample': 'low_sample',
  'no-baseline': 'no_baseline',
};

const toRegression = (v: RegressionVerdict): DurationRegression => ({
  status: REGRESSION_STATUS[v.status],
  current: toDistribution(v.current),
  baseline: toDistribution(v.baseline),
  ratio: v.ratio,
  p_value: v.pValue,
  q_value: v.qValue,
});

const toReliability = (r: DomainTaskReliability): TaskReliability => ({
  tries: r.tries,
  failed_tries: r.failedTries,
  try_failure_rate: r.tryFailureRate,
  task_instances: r.taskInstances,
  retried: r.retried,
  retry_rate: r.retryRate,
  flaky: r.flaky,
  flaky_inferred: r.flakyInferred,
  flaky_rate: r.flakyRate,
  recoveries: r.recoveries,
  unrecovered: r.unrecovered,
  mttr_seconds: r.mttrSeconds,
});

const tryIdentity = (t: StoredTaskTry) =>
  `${t.runId}\u0000${t.taskId}\u0000${t.mapIndex}\u0000${t.tryNumber}`;

/**
 * HM-016: the DAG's tries from `from` up to `to` (the start of the range's previous period, which the
 * environment-wide read already covers), through the store's per-DAG read where it has one. The fallback reads
 * the environment and filters; it also returns other DAGs' tries, which date the start of the history.
 */
async function olderTries(
  store: TaskInstanceStore,
  envId: string,
  dagId: string,
  from: number,
  to: number,
): Promise<StoredTaskTry[]> {
  if (from >= to) return [];
  return store.dagTaskTries ? store.dagTaskTries(envId, dagId, from, to) : store.taskTries(envId, from, to);
}

/** The DAG's tries over the whole baseline and range: recent ones plus older ones not already read. */
function withOlder(recent: readonly StoredTaskTry[], older: readonly StoredTaskTry[], dagId: string) {
  const seen = new Set(recent.map(tryIdentity));
  return [...older.filter((t) => t.dagId === dagId && !seen.has(tryIdentity(t))), ...recent];
}

export async function getDagDetail(deps: DagsDeps, q: DagDetailQuery): Promise<DagDetailResult> {
  const now = deps.clock.now();
  const { current, previous } = windowsFor(now, q.range);
  const [dags, config] = await Promise.all([deps.model.dags(q.envId), deps.model.config(q.envId)]);
  if (!config) return { kind: 'unknown-environment' };
  const meta = dags.find((d) => d.dagId === q.dagId);
  if (!meta) return { kind: 'unknown-dag' };

  // HM-016: the 28 days before the range, excluding it.
  const baselineWindow: SweepWindow = {
    from: current.from - DURATION_REGRESSION_RULE.baselineDays * DAY_MS,
    to: current.from,
    now,
  };
  // Tries from the previous range too, so runs that began before the range are seen whole; older ones of
  // this DAG for its baseline.
  const [tries, snapshots, older, storedHistory] = await Promise.all([
    deps.store.taskTries(q.envId, previous.from, now),
    deps.model.snapshots(q.envId, current.from, now + 1),
    olderTries(deps.store, q.envId, q.dagId, baselineWindow.from, previous.from),
    readHistoryStart(deps.store, q.envId),
  ]);
  const dagTries = tries.filter((t) => t.dagId === q.dagId);
  if (q.runId !== undefined && !dagTries.some((t) => t.runId === q.runId)) return { kind: 'unknown-run' };

  const latest = freshLatest(snapshots, now);
  const options = { inProgress: waitingIn(latest) };
  const stats = dagWindowStats(dagTries, current, options).get(q.dagId) ?? emptyDagStats(q.dagId);
  const environmentSeconds = slotSeconds(tries, current).totalExecutorSlotSeconds;
  const runs = dagRuns(dagTries, current, options, meta.schedule);
  // Default to the latest finished run: the newest one is often still starting and shows little.
  const ganttRunId =
    q.runId ?? [...runs].reverse().find((r) => r.state !== 'running')?.runId ?? runs.at(-1)?.runId ?? null;
  const gantt = ganttRunId === null ? [] : runGantt(dagTries, q.dagId, ganttRunId, latest);
  const isoOrNull = (ms: number | null) => (ms === null ? null : iso(ms));

  const regression = dagDurationRegression(
    withOlder(dagTries, older, q.dagId),
    current,
    baselineWindow,
    options,
  );
  const reliability = dagReliability(dagTries, current, options);
  const frequency = criticalPathFrequency(dagTries, current, options);
  const path =
    ganttRunId === null || options.inProgress(q.dagId, ganttRunId)
      ? null
      : criticalPath(dagTries.filter((t) => t.runId === ganttRunId));
  const rowIndex = new Map(gantt.map((g, i) => [`${g.taskId}\u0000${g.mapIndex}\u0000${g.tryNumber}`, i]));
  // The environment's history, not this DAG's: a DAG first seen 3 days ago did not run before (HM-016). The
  // per-DAG read holds this DAG's tries only, so without the store's history start it does not date it.
  const historyFrom = historyStartOf(storedHistory, deps.store.dagTaskTries ? tries : [...older, ...tries]);

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
        start_delay_basis: r.startDelayBasis,
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
        critical_path: path && {
          method: path.method,
          row_indexes: path.steps
            .map((s) => rowIndex.get(`${s.taskId}\u0000${s.mapIndex}\u0000${s.tryNumber}`))
            .filter((i): i is number => i !== undefined),
          duration_seconds: path.durationSeconds,
          waiting_seconds: path.waitingSeconds,
          running_seconds: path.runningSeconds,
        },
      },
      baseline: {
        from: iso(baselineWindow.from),
        to: iso(baselineWindow.to),
        history_from: historyFrom === null ? null : iso(historyFrom),
        coverage: historyCoverage(historyFrom, baselineWindow),
        margin: DURATION_REGRESSION_RULE.margin,
      },
      regression: toRegression(regression.run),
      reliability: {
        finished_runs: reliability.finishedRuns,
        failed_runs: reliability.failedRuns,
        run_failure_rate: reliability.runFailureRate,
        run_recoveries: reliability.runRecoveries,
        run_unrecovered: reliability.runUnrecovered,
        run_mttr_seconds: reliability.runMttrSeconds,
        tasks: toReliability(reliability.tasks),
      },
      tasks: taskStats(dagTries, current).map((t) => {
        const verdict = regression.tasks.get(t.taskId);
        const outcomes = reliability.byTask.get(t.taskId);
        const onPath = frequency.byTask.get(t.taskId) ?? 0;
        return {
          task_id: t.taskId,
          tries: t.tries,
          duration_p50: toQuantile(t.durationP50),
          duration_p95: toQuantile(t.durationP95),
          queue_wait_p95: toQuantile(t.queueWaitP95),
          retries: t.retries,
          failure_rate: t.failureRate,
          slot_seconds_share: t.slotSecondsShare,
          contribution_seconds: t.contributionSeconds,
          ...(verdict ? { duration_regression: toRegression(verdict) } : {}),
          ...(outcomes ? { reliability: toReliability(outcomes) } : {}),
          critical_path_runs: onPath,
          critical_path_share: frequency.runs > 0 ? onPath / frequency.runs : null,
        };
      }),
      findings: [...(q.findings ?? [])],
    },
  };
}
