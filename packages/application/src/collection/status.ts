/**
 * Collector health and DCAM's footprint as the DCAM health page shows them: the engine's runtime state
 * mapped to the `Collection` contract.
 *
 * - States: `disabled` (profile off, or the source does not apply), `failing` (three or more consecutive
 *   failed cycles; the environment is then `failing` too, FR-COLL-11), `degraded` (the last cycle failed, a
 *   budget cut it short, or its API is parked after a VPC Service Controls denial), `waiting` (no cycle
 *   finished yet), `ok`. A cycle cut short by a budget is not a failure.
 * - `lag_seconds`: age of the newest data a collector committed (`CollectorResult.dataAsOf`).
 * - `refresh_seconds`: how often that data is refreshed, the longer of the cadence and the manifest's
 *   `refreshMs` (the DAG inventory's hourly pass); §12.10 staleness compares the lag with it.
 * - `delay_seconds`: how long after the fact the data is read by design (`af.facts`' settling delay);
 *   staleness does not count it.
 * - `error_rate_1h`: failed cycles / finished cycles in the last hour (minute buckets, see `footprint.ts`);
 *   `null` when no cycle finished in that hour.
 * - `last_error` keeps the most recent error after a recovery, so the page can say what happened.
 * - `reduced_fidelity`: a cycle ran out of budget, or reported reduced fidelity, in the last 15 min.
 * - `footprint`: one entry per API the environment uses (a self-managed Airflow only has the Airflow API);
 *   `budget_per_minute` is the effective budget of the environment's profile, for Monitoring the
 *   project's budget, which the project's environments share.
 * - `series_24h`: Cloud Monitoring time series returned in the last 24 h (NFR-OBS-06); `null` without
 *   Monitoring.
 * - `backfill`: every backfill collector that applies to the environment, with its last report (FR-COLL-04);
 *   `waiting` until its first cycle reports.
 *
 * @implements FR-COLL-11, FR-COLL-06, FR-COLL-04, FR-SELF-01, HM-030, NFR-OBS-06
 */
import type { ApiFootprint, BackfillStatus, CollectionEnvironment, CollectorStatus } from '@dcam/contracts';
import type { EnvironmentEntry } from '@dcam/ports';
import type { EffectiveBudgets } from './budget';
import { HOUR_MINUTES, type FootprintCounter, type MinuteBuckets, type RollingSum } from './footprint';
import type { ApiId, BackfillReport, CollectorManifest } from './types';

/** Cycles that fail in a row before a collector is `failing` (FR-COLL-11). */
export const FAILING_AFTER = 3;
/** How long a cycle that ran out of budget keeps the environment's "reduced fidelity" banner. */
export const REDUCED_FIDELITY_MS = 15 * 60_000;

export interface LastError {
  readonly kind: string;
  readonly message: string;
  readonly fixHint: string | null;
  readonly at: number;
}

export interface CycleCounts {
  cycles: number;
  failures: number;
}

/** What the status needs from one (environment, collector) task. */
export interface TaskView {
  readonly manifest: CollectorManifest;
  readonly disabled: boolean;
  readonly cadenceMs: number;
  running: boolean;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  dataAsOf: number | null;
  lastOutcome: 'ok' | 'reduced' | 'failed' | null;
  consecutiveFailures: number;
  lastError: LastError | null;
  /** Finished cycles per minute, over the last hour. */
  readonly cycles: MinuteBuckets<CycleCounts>;
  /** A backfill collector's last progress report (FR-COLL-04); `null` for other collectors. */
  backfill: BackfillReport | null;
}

export interface EnvironmentView<T extends TaskView = TaskView> {
  readonly entry: EnvironmentEntry;
  readonly budgets: EffectiveBudgets;
  readonly tasks: readonly T[];
  /** DCAM's requests per API the environment uses. */
  readonly footprint: Readonly<Partial<Record<ApiId, FootprintCounter>>>;
  /** Cloud Monitoring time series returned; `null` without Monitoring. */
  readonly series: RollingSum | null;
  /** When a cycle last ran out of budget or reported reduced fidelity. */
  reducedAt: number | null;
}

/** Per task facts only the engine knows. */
export interface TaskExtras {
  readonly nextRunAt: number | null;
  /** The error that parked the collector's API (VPC Service Controls), if any. */
  readonly parked: LastError | null;
}

const APIS: readonly ApiId[] = ['airflow', 'composer', 'monitoring'];

const iso = (ms: number) => new Date(ms).toISOString();
const isoOrNull = (ms: number | null) => (ms === null ? null : iso(ms));

export function collectorStatus(task: TaskView, now: number, extras: TaskExtras): CollectorStatus {
  const lastError = extras.parked ?? task.lastError;
  const hour = task.cycles.recent(now, HOUR_MINUTES);
  const cycles = hour.reduce((sum, b) => sum + b.cycles, 0);
  const failures = hour.reduce((sum, b) => sum + b.failures, 0);
  return {
    id: task.manifest.id,
    source: task.manifest.source,
    state: stateOf(task, extras),
    cadence_seconds: Math.round(task.cadenceMs / 1_000),
    // A disabled collector (cadence 0) refreshes nothing.
    refresh_seconds:
      task.cadenceMs <= 0 ? 0 : Math.round(Math.max(task.cadenceMs, task.manifest.refreshMs ?? 0) / 1_000),
    delay_seconds: Math.round((task.manifest.delayMs ?? 0) / 1_000),
    last_attempt_at: isoOrNull(task.lastAttemptAt),
    last_success_at: isoOrNull(task.lastSuccessAt),
    next_run_at: isoOrNull(extras.nextRunAt),
    lag_seconds: task.dataAsOf === null ? null : Math.max(0, (now - task.dataAsOf) / 1_000),
    consecutive_failures: task.consecutiveFailures,
    error_rate_1h: cycles === 0 ? null : failures / cycles,
    last_error:
      lastError === null
        ? null
        : {
            kind: lastError.kind,
            message: lastError.message,
            fix_hint: lastError.fixHint,
            at: iso(lastError.at),
          },
  };
}

function stateOf(task: TaskView, extras: TaskExtras): CollectorStatus['state'] {
  if (task.disabled) return 'disabled';
  if (task.consecutiveFailures >= FAILING_AFTER) return 'failing';
  if (extras.parked) return 'degraded';
  if (task.lastOutcome === null) return 'waiting';
  return task.lastOutcome === 'ok' ? 'ok' : 'degraded';
}

export function environmentStatus<T extends TaskView>(
  env: EnvironmentView<T>,
  now: number,
  extras: (task: T) => TaskExtras,
): CollectionEnvironment {
  const footprint: ApiFootprint[] = [];
  for (const api of APIS) {
    const counter = env.footprint[api];
    if (counter) footprint.push({ api, budget_per_minute: env.budgets[api], ...counter.summary(now) });
  }
  return {
    env_id: env.entry.id,
    profile: env.entry.profile,
    reduced_fidelity: env.reducedAt !== null && now - env.reducedAt < REDUCED_FIDELITY_MS,
    failing: env.tasks.some((t) => !t.disabled && t.consecutiveFailures >= FAILING_AFTER),
    collectors: env.tasks.map((t) => collectorStatus(t, now, extras(t))),
    footprint,
    series_24h: env.series === null ? null : env.series.total(now),
    backfill: env.tasks.flatMap((t) => {
      const kind = t.manifest.backfill;
      return kind && !t.disabled && t.backfill ? [backfillStatus(t.manifest.id, kind, t.backfill)] : [];
    }),
  };
}

export function backfillStatus(
  collectorId: string,
  kind: BackfillStatus['kind'],
  r: BackfillReport,
): BackfillStatus {
  return {
    collector_id: collectorId,
    kind,
    state: r.state,
    days: r.days,
    from: isoOrNull(r.from),
    to: isoOrNull(r.to),
    covered_from: isoOrNull(r.coveredFrom),
    items_read: r.itemsRead,
    requests_used: r.requestsUsed,
    eta_seconds: r.etaSeconds === null ? null : Math.max(0, r.etaSeconds),
  };
}
