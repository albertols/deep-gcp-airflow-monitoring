/**
 * HM-005 DAG self-throttling (spec §8.3 L1023), read from live snapshots: the time a DAG's running and queued
 * task instances were at its `max_active_tasks` while its own task instances were ready and not queued, against
 * the time it was active. One computation for the advisor (REC-DAG-01, `advisor-signals.ts`) and DAG detail
 * (FR-DAGD-05), so both say the same.
 *
 * - A snapshot stands for the real gap to the next one, capped at two cadences (`snapshot-time.ts`): a
 *   collection gap is neither active nor at the limit.
 * - Active: the DAG has running or queued task instances (`dagActive`, what the limit counts on Airflow 2) or
 *   ready ones. At the limit: `dagActive ≥ max_active_tasks` with at least one own ready task instance.
 * - Scope: Airflow 2 counts running and queued task instances across all active runs of the DAG (HM-005 caveat,
 *   checked in the scheduler source); Airflow 3's per-run scope is not modelled.
 * - Headroom: at-limit snapshots in which the environment had free worker slots; unknown while
 *   `worker_concurrency` is unknown (HM-032).
 *
 * @implements HM-005, REC-DAG-01, FR-DAGD-05
 */
import { limitKnown, type EnvironmentConfig, type LiveSnapshot } from './model';
import { rawCadenceMs, snapshotSpans } from './snapshot-time';

/** HM-005 totals of one DAG over a window. Times in ms. */
export interface DagLimitTotals {
  /** Snapshots in which the DAG had running, queued or ready task instances. */
  readonly activeObservations: number;
  /** Time those snapshots stand for. */
  readonly activeMs: number;
  /** Snapshots at `max_active_tasks` with ready task instances of its own. */
  readonly atLimitObservations: number;
  /** Time those snapshots stand for. */
  readonly atLimitMs: number;
  /** Task-time its own ready task instances waited while it was at the limit. */
  readonly ownWaitingMs: number;
  /** Highest running + queued + ready task instances of the DAG at the limit. */
  readonly peakDemand: number;
  /**
   * At-limit snapshots with free worker slots in the environment; `null` while `worker_concurrency` is unknown
   * (HM-032), because free slots cannot be told from full ones.
   */
  readonly headroomObservations: number | null;
  readonly lastAtLimit: number | null;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
export type DagLimitTally = Mutable<DagLimitTotals>;

type SlotsConfig = Pick<EnvironmentConfig, 'workerConcurrency' | 'limitSources'>;

export function emptyDagLimitTally(config: SlotsConfig): DagLimitTally {
  return {
    activeObservations: 0,
    activeMs: 0,
    atLimitObservations: 0,
    atLimitMs: 0,
    ownWaitingMs: 0,
    peakDemand: 0,
    headroomObservations: limitKnown(config, 'workerConcurrency') ? 0 : null,
    lastAtLimit: null,
  };
}

/** True when the snapshot shows free worker slots; never while `worker_concurrency` is unknown (HM-032). */
export const freeWorkerSlots = (s: LiveSnapshot, config: SlotsConfig): boolean =>
  limitKnown(config, 'workerConcurrency') &&
  s.executor.running < s.workers.current * config.workerConcurrency;

/** What one snapshot shows about one DAG that is active in it. */
export interface DagLimitObservation {
  readonly at: number;
  /** Time the snapshot stands for. */
  readonly spanMs: number;
  /** Running + queued task instances of the DAG (`dagActive`). */
  readonly inFlight: number;
  /** Own ready (scheduled) task instances. */
  readonly ready: number;
  readonly limit: number;
  readonly freeSlots: boolean;
}

/** Adds one snapshot in which the DAG is active to its tally. */
export function observeDagLimit(d: DagLimitTally, o: DagLimitObservation): void {
  d.activeObservations++;
  d.activeMs += o.spanMs;
  if (o.inFlight < o.limit || o.ready === 0) return;
  d.atLimitObservations++;
  d.atLimitMs += o.spanMs;
  d.ownWaitingMs += o.ready * o.spanMs;
  d.peakDemand = Math.max(d.peakDemand, o.inFlight + o.ready);
  if (o.freeSlots && d.headroomObservations !== null) d.headroomObservations++;
  d.lastAtLimit = o.at;
}

export interface DagSelfThrottlingInput {
  /** Live snapshots, oldest first; those outside `[from, to)` are ignored. */
  readonly snapshots: readonly LiveSnapshot[];
  readonly from: number;
  readonly to: number;
  /** The `af.live` cadence to assume while fewer than two raw snapshots show the real one. */
  readonly fallbackCadenceMs: number;
  readonly dagId: string;
  /** The DAG's `max_active_tasks` (its own, else `max_active_tasks_per_dag`). */
  readonly limit: number;
  readonly config: SlotsConfig;
}

/** HM-005 for one DAG over a window, as the advisor computes it for every DAG. */
export function dagSelfThrottling(input: DagSelfThrottlingInput): DagLimitTotals {
  const { dagId } = input;
  const inWindow = input.snapshots.filter((s) => s.at >= input.from && s.at < input.to);
  const spans = snapshotSpans(inWindow, rawCadenceMs(inWindow) ?? input.fallbackCadenceMs, input.to);
  const d = emptyDagLimitTally(input.config);
  inWindow.forEach((s, i) => {
    let ready = 0;
    for (const ti of s.scheduled) if (ti.dagId === dagId) ready++;
    const inFlight = s.dagActive[dagId];
    if (inFlight === undefined && ready === 0) return;
    observeDagLimit(d, {
      at: s.at,
      spanMs: spans[i] ?? 0,
      inFlight: inFlight ?? 0,
      ready,
      limit: input.limit,
      freeSlots: freeWorkerSlots(s, input.config),
    });
  });
  return d;
}

/** Share of the active time at the limit with own work waiting, 0–1; `null` without active time. */
export const atLimitShare = (d: Pick<DagLimitTotals, 'activeMs' | 'atLimitMs'>): number | null =>
  d.activeMs > 0 ? Math.min(1, d.atLimitMs / d.activeMs) : null;
