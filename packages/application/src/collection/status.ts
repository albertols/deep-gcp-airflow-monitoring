/**
 * Collector health as the DCAM health page shows it (FR-COLL-11): the engine's runtime state mapped to the
 * `Collection` contract.
 *
 * States: `disabled` (profile off, or the source does not apply), `failing` (three or more consecutive
 * failed cycles; the environment is then `failing` too), `degraded` (the last cycle failed, a budget cut it
 * short, or its API is parked after a VPC Service Controls denial), `waiting` (no cycle finished yet), `ok`.
 * A cycle cut short by a budget is not a failure. `lag_seconds` is the age of the newest data a collector
 * committed (`CollectorResult.dataAsOf`). `last_error` keeps the most recent error after a recovery, so
 * the page can say what happened.
 *
 * @implements FR-COLL-11, FR-COLL-06
 */
import type { CollectionEnvironment, CollectorStatus } from '@dcam/contracts';
import type { EnvironmentEntry } from '@dcam/ports';
import type { CollectorManifest } from './types';

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
}

export interface EnvironmentView<T extends TaskView = TaskView> {
  readonly entry: EnvironmentEntry;
  readonly tasks: readonly T[];
  /** When a cycle last ran out of budget or reported reduced fidelity. */
  reducedAt: number | null;
}

/** Per task facts only the engine knows. */
export interface TaskExtras {
  readonly nextRunAt: number | null;
  /** The error that parked the collector's API (VPC Service Controls), if any. */
  readonly parked: LastError | null;
}

const iso = (ms: number) => new Date(ms).toISOString();
const isoOrNull = (ms: number | null) => (ms === null ? null : iso(ms));

export function collectorStatus(task: TaskView, now: number, extras: TaskExtras): CollectorStatus {
  const lastError = extras.parked ?? task.lastError;
  return {
    id: task.manifest.id,
    source: task.manifest.source,
    state: stateOf(task, extras),
    cadence_seconds: Math.round(task.cadenceMs / 1_000),
    last_attempt_at: isoOrNull(task.lastAttemptAt),
    last_success_at: isoOrNull(task.lastSuccessAt),
    next_run_at: isoOrNull(extras.nextRunAt),
    lag_seconds: task.dataAsOf === null ? null : Math.max(0, (now - task.dataAsOf) / 1_000),
    consecutive_failures: task.consecutiveFailures,
    error_rate_1h: null,
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
  return {
    env_id: env.entry.id,
    profile: env.entry.profile,
    reduced_fidelity: env.reducedAt !== null && now - env.reducedAt < REDUCED_FIDELITY_MS,
    failing: env.tasks.some((t) => !t.disabled && t.consecutiveFailures >= FAILING_AFTER),
    collectors: env.tasks.map((t) => collectorStatus(t, now, extras(t))),
    footprint: [],
    series_24h: null,
  };
}
