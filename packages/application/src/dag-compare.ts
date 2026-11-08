/**
 * Use cases: compare 2 to 4 DAGs from the same or different environments (S-14, FR-DAGD-08), and compare two runs
 * of one DAG (S-13, FR-DAGD-09), over task tries, the environment model and the injected clock.
 *
 * Reads, for the ~2,000-DAG environments DCAM targets: each DAG's own tries (`dagTaskTries`), and each
 * environment's totals through the store's aggregate (`environmentLoad`) where it has one with `historyStart`;
 * otherwise the environment's tries of the range, a day at a time (NFR-PERF-01). Times are UTC throughout. Every
 * range preset works, 15 minutes to 90 days (FR-UI-01).
 *
 * @implements FR-DAGD-08, FR-DAGD-09, HM-001, HM-003, HM-007, HM-015
 */
import type {
  Range,
  DagComparison,
  RunComparison,
  SourceId,
  TaskInRun as TaskInRunDto,
} from '@dcam/contracts';
import {
  compareRuns,
  dagWindowStats,
  durationDistribution,
  createEnvironmentLoad,
  emptyDagStats,
  histogram,
  hourlyLoadProfile,
  limitKnown,
  ownsTry,
  runsInWindow,
  sharedLogBins,
  slotSeconds,
  startedIn,
  type DagMeta,
  type EnvironmentConfig,
  type EnvironmentLoad,
  type RunSummary,
  type SweepWindow,
  type TaskInRun,
} from '@dcam/domain';
import type { Clock, EnvironmentModelSource, StoredTaskTry, TaskInstanceStore } from '@dcam/ports';
import { freshLatest, waitingIn } from './dags';
import { readHistoryStart } from './history';
import { RANGE_MS } from './range';
import { earliestOf, sliceTries, slicesOf } from './slices';

const HOUR = 3_600_000;
/** Tries this long before the range are read too, so that runs which began just before it are seen whole. */
const RUN_MARGIN_MS = 24 * HOUR;
/** How far back the latest live snapshot is looked for (as the league): five eco-profile cadences. */
const RECENT_SNAPSHOTS_MS = 10 * 60_000;
/** Duration histogram bins shared by the DAGs compared. */
const DURATION_BINS = 12;

export interface CompareDeps {
  readonly store: TaskInstanceStore;
  readonly model: EnvironmentModelSource;
  readonly clock: Clock;
}

const iso = (ms: number) => new Date(ms).toISOString();
const isoOrNull = (ms: number | null) => (ms === null ? null : iso(ms));
const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const ratio = (part: number, whole: number) => (whole > 0 ? Math.min(1, Math.max(0, part / whole)) : null);

/**
 * One DAG's tries over `[from, to)`, through the per-DAG read where the store has it; otherwise the environment is
 * read a day at a time (NFR-PERF-01) and only the DAG's tries are kept, each once.
 */
async function triesOfDag(store: TaskInstanceStore, envId: string, dagId: string, from: number, to: number) {
  if (store.dagTaskTries) return store.dagTaskTries(envId, dagId, from, to);
  const kept: StoredTaskTry[] = [];
  for (const slice of slicesOf(from, to)) {
    const first = slice.from <= from;
    for (const t of await sliceTries(store, envId, slice))
      if (t.dagId === dagId && ownsTry(t, slice, first)) kept.push(t);
  }
  return kept;
}

/** The latest live snapshot's waiting runs, so that a run between tasks is not called finished. */
async function inProgressOf(model: EnvironmentModelSource, envId: string, now: number) {
  const recent = await model.snapshots(envId, now - RECENT_SNAPSHOTS_MS, now + 1);
  return waitingIn(freshLatest(recent, now));
}

interface EnvironmentContext {
  readonly config: EnvironmentConfig;
  readonly dags: ReadonlyMap<string, DagMeta>;
  readonly historyFrom: number | null;
  /** On whole UTC hours from the hour holding the range start. */
  readonly load: EnvironmentLoad;
  readonly inProgress: (dagId: string, runId: string) => boolean;
}

/** One environment's configuration, DAGs, history start and load over the window: an aggregate, or its tries. */
async function environmentContext(
  deps: CompareDeps,
  envId: string,
  w: SweepWindow,
): Promise<EnvironmentContext | null> {
  const config = await deps.model.config(envId);
  if (!config) return null;
  const { store } = deps;
  const origin = Math.floor(w.from / HOUR) * HOUR;
  // The aggregate only with the store's history start: one DAG's tries cannot date the environment's history.
  // Otherwise the environment's tries of the range are read a day at a time (NFR-PERF-01), only summed.
  const readLoad = async (): Promise<{ load: EnvironmentLoad; earliest: number }> => {
    if (store.environmentLoad && store.historyStart)
      return { load: await store.environmentLoad(envId, w.from, w.to, w.now, HOUR), earliest: Infinity };
    const acc = createEnvironmentLoad(w, HOUR, origin);
    let earliest = Infinity;
    for (const slice of slicesOf(w.from, w.to)) {
      const tries = await sliceTries(store, envId, slice);
      earliest = earliestOf(tries, earliest);
      acc.add(tries, slice);
    }
    return { load: acc.result(), earliest };
  };
  const [dags, inProgress, stored, load] = await Promise.all([
    deps.model.dags(envId),
    inProgressOf(deps.model, envId, w.now),
    readHistoryStart(store, envId),
    readLoad(),
  ]);
  return {
    config,
    dags: new Map(dags.map((d) => [d.dagId, d])),
    historyFrom: stored !== undefined ? stored : Number.isFinite(load.earliest) ? load.earliest : null,
    load: load.load,
    inProgress,
  };
}

/** Time of the window with collected history, ms. */
function coveredMs(w: SweepWindow, historyFrom: number | null): number {
  if (historyFrom === null) return 0;
  return Math.max(0, Math.min(w.to, w.now) - Math.max(w.from, historyFrom));
}

export interface DagRef {
  readonly envId: string;
  readonly dagId: string;
}

export interface DagComparisonQuery {
  /** 2 to 4 distinct DAGs, validated by the caller; the response keeps their order. */
  readonly items: readonly DagRef[];
  readonly range: Range;
  readonly sources: readonly SourceId[];
}

export type DagComparisonResult =
  | { readonly kind: 'ok'; readonly comparison: DagComparison }
  | { readonly kind: 'unknown-environment'; readonly envId: string }
  | { readonly kind: 'unknown-dag'; readonly envId: string; readonly dagId: string };

function capacityContext(
  envId: string,
  e: EnvironmentContext,
  w: SweepWindow,
): DagComparison['environments'][number] {
  const { config } = e;
  const total = e.load.executorSlotSeconds.reduce((a, b) => a + b, 0);
  const concurrencyKnown = limitKnown(config, 'workerConcurrency');
  const workerSlots = concurrencyKnown ? config.maxWorkers * config.workerConcurrency : null;
  const covered = coveredMs(w, e.historyFrom) / 1000;
  return {
    env_id: envId,
    tier: config.tier,
    airflow_version: config.airflowVersion,
    history_from: isoOrNull(e.historyFrom),
    coverage: w.to > w.from ? covered / ((w.to - w.from) / 1000) : 0,
    executor_slot_seconds: total,
    worker_slots: workerSlots,
    worker_concurrency: concurrencyKnown ? config.workerConcurrency : null,
    min_workers: config.minWorkers,
    max_workers: config.maxWorkers,
    parallelism: limitKnown(config, 'parallelism') ? config.parallelism * config.schedulers : null,
    max_active_tasks_per_dag: limitKnown(config, 'maxActiveTasksPerDag') ? config.maxActiveTasksPerDag : null,
    pools: config.pools.map((p) => ({ name: p.name, slots: p.slots })),
    utilisation:
      workerSlots !== null && workerSlots > 0 && covered > 0 ? total / (workerSlots * covered) : null,
  };
}

export async function getDagComparison(
  deps: CompareDeps,
  q: DagComparisonQuery,
): Promise<DagComparisonResult> {
  const now = deps.clock.now();
  const w: SweepWindow = { from: now - RANGE_MS[q.range], to: now, now };
  const envIds = [...new Set(q.items.map((i) => i.envId))];
  const contexts = new Map<string, EnvironmentContext>();
  for (const envId of envIds) {
    const context = await environmentContext(deps, envId, w);
    if (!context) return { kind: 'unknown-environment', envId };
    contexts.set(envId, context);
  }
  for (const i of q.items)
    if (!contexts.get(i.envId)?.dags.has(i.dagId))
      return { kind: 'unknown-dag', envId: i.envId, dagId: i.dagId };

  const triesByItem = await Promise.all(
    q.items.map((i) =>
      triesOfDag(deps.store, i.envId, i.dagId, w.from - Math.min(RUN_MARGIN_MS, w.to - w.from), now),
    ),
  );
  const measured = q.items.map((item, k) => {
    const e = contexts.get(item.envId) as EnvironmentContext;
    const tries = triesByItem[k] ?? [];
    const options = { inProgress: e.inProgress };
    const stats = dagWindowStats(tries, w, options).get(item.dagId) ?? emptyDagStats(item.dagId);
    const durations = runsInWindow(tries, w, options)
      .filter((r) => r.state === 'success' && r.durationSeconds !== null)
      .map((r) => r.durationSeconds as number);
    return { item, e, tries, stats, durations };
  });
  const bins = sharedLogBins(
    measured.map((m) => m.durations),
    DURATION_BINS,
  );

  const dags = measured.map(({ item, e, tries, stats, durations }): DagComparison['dags'][number] => {
    const meta = e.dags.get(item.dagId) as DagMeta;
    const total = e.load.executorSlotSeconds.reduce((a, b) => a + b, 0);
    const pools = slotSeconds(tries, w).byPool;
    const quantile = (x: typeof stats.runDurationP50) => ({
      value_seconds: x.value,
      samples: x.samples,
      low_sample: x.lowSample,
    });
    const d = durationDistribution(durations);
    return {
      env_id: item.envId,
      dag_id: item.dagId,
      team: meta.team,
      schedule: meta.schedule,
      paused: meta.paused,
      max_active_tasks: meta.maxActiveTasks,
      kpis: {
        runs: stats.runs,
        finished_runs: stats.finishedRuns,
        success_rate: stats.successRate,
        tries: stats.tries,
        retries: stats.retries,
        flaky_rate: stats.flakyRate,
        flaky_inferred: stats.flakyInferred,
        run_duration_p50: quantile(stats.runDurationP50),
        run_duration_p95: quantile(stats.runDurationP95),
        queue_wait_p95: quantile(stats.queueWaitP95),
        peak_concurrency: stats.peakConcurrency,
      },
      duration: {
        samples: d.samples,
        min: d.min,
        p25: d.p25,
        p50: d.p50,
        p75: d.p75,
        p95: d.p95,
        max: d.max,
        low_sample: d.lowSample,
      },
      duration_histogram: histogram(durations, bins),
      hourly_profile: hourlyLoadProfile({
        dagTries: tries,
        environment: e.load,
        window: w,
        historyFrom: e.historyFrom,
      }).map((h) => ({
        hour: h.hour,
        covered_hours: h.coveredHours,
        running_avg: h.runningAvg,
        share: h.share,
      })),
      resources: {
        executor_slot_seconds: stats.executorSlotSeconds,
        share: ratio(stats.executorSlotSeconds, total),
        pools: [...pools]
          .sort(([x], [y]) => byName(x, y))
          .map(([pool, seconds]) => ({
            pool,
            pool_slot_seconds: seconds,
            share: ratio(seconds, e.load.poolSlotSeconds.get(pool) ?? 0),
          })),
      },
    };
  });

  return {
    kind: 'ok',
    comparison: {
      range: { from: iso(w.from), to: iso(w.to) },
      data_as_of: iso(now),
      sources: [...q.sources],
      time_zone: 'UTC',
      duration_bins_seconds: bins,
      environments: envIds.map((envId) =>
        capacityContext(envId, contexts.get(envId) as EnvironmentContext, w),
      ),
      dags,
    },
  };
}

export interface RunComparisonQuery {
  readonly envId: string;
  readonly dagId: string;
  /** Run IDs: b is compared with a (deltas are b − a). */
  readonly a: string;
  readonly b: string;
  /** Both runs must have a try that started in this range. */
  readonly range: Range;
  readonly sources: readonly SourceId[];
}

export type RunComparisonResult =
  | { readonly kind: 'ok'; readonly comparison: RunComparison }
  | { readonly kind: 'unknown-environment' }
  | { readonly kind: 'unknown-dag' }
  | { readonly kind: 'unknown-run'; readonly runId: string };

const RANKING: Record<'critical-path' | 'duration-delta', RunComparison['ranking']> = {
  'critical-path': 'critical_path',
  'duration-delta': 'duration_delta',
};

function toTaskInRun(t: TaskInRun | null): TaskInRunDto | null {
  if (!t) return null;
  return {
    state: t.state,
    map_indexes: t.mapIndexes,
    map_index: t.mapIndex,
    tries: t.tries,
    start: isoOrNull(t.startAt),
    end: isoOrNull(t.endAt),
    duration_seconds: t.durationSeconds,
    queue_wait_seconds: t.queueWaitSeconds,
    on_critical_path: t.onCriticalPath,
    critical_path_seconds: t.criticalSeconds,
  };
}

const toSide = (r: RunSummary, pathSeconds: number | null): RunComparison['a'] => ({
  run_id: r.runId,
  state: r.state,
  start: iso(r.startAt),
  end: isoOrNull(r.endAt),
  duration_seconds: r.durationSeconds,
  tries: r.tries,
  critical_path_seconds: pathSeconds,
});

export async function getRunComparison(
  deps: CompareDeps,
  q: RunComparisonQuery,
): Promise<RunComparisonResult> {
  const now = deps.clock.now();
  const w: SweepWindow = { from: now - RANGE_MS[q.range], to: now, now };
  const [config, dags] = await Promise.all([deps.model.config(q.envId), deps.model.dags(q.envId)]);
  if (!config) return { kind: 'unknown-environment' };
  if (!dags.some((d) => d.dagId === q.dagId)) return { kind: 'unknown-dag' };
  const [tries, inProgress] = await Promise.all([
    triesOfDag(deps.store, q.envId, q.dagId, w.from - RUN_MARGIN_MS, now),
    inProgressOf(deps.model, q.envId, now),
  ]);
  const runTries = (runId: string) => tries.filter((t) => t.runId === runId);
  const aTries = runTries(q.a);
  const bTries = runTries(q.b);
  for (const [runId, list] of [
    [q.a, aTries],
    [q.b, bTries],
  ] as const)
    if (!list.some((t) => startedIn(t, w))) return { kind: 'unknown-run', runId };
  const c = compareRuns(aTries, bTries, { inProgress });
  if (!c) return { kind: 'unknown-run', runId: q.a };
  return {
    kind: 'ok',
    comparison: {
      env_id: q.envId,
      dag_id: q.dagId,
      range: { from: iso(w.from), to: iso(w.to) },
      data_as_of: iso(now),
      sources: [...q.sources],
      method: 'HM-007/timing',
      ranking: RANKING[c.ranking],
      a: toSide(c.a, c.pathA?.durationSeconds ?? null),
      b: toSide(c.b, c.pathB?.durationSeconds ?? null),
      duration_delta_seconds: c.durationDeltaSeconds,
      explained_seconds: c.explainedSeconds,
      tasks: c.tasks.map((t) => ({
        task_id: t.taskId,
        a: toTaskInRun(t.a),
        b: toTaskInRun(t.b),
        duration_delta_seconds: t.durationDeltaSeconds,
        queue_wait_delta_seconds: t.queueWaitDeltaSeconds,
        contribution_seconds: t.contributionSeconds,
        contribution_wait_seconds: t.contributionWaitSeconds,
        contribution_running_seconds: t.contributionRunningSeconds,
      })),
    },
  };
}
