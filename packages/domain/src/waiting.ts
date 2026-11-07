/**
 * HM-006 "why is work waiting": classifies each waiting task instance in a live snapshot by the limit
 * that binds, in the order Airflow 2.11's scheduler checks them (first match wins; later matches are
 * kept as secondary evidence). Reasons whose inputs DCAM does not collect yet (run-level
 * `max_active_runs`, task-level limits, triggerer capacity) are never guessed.
 *
 * @implements HM-006
 */
import {
  limitKnown,
  type EnvironmentConfig,
  type LiveSnapshot,
  type SnapshotTaskInstance,
  type WaitReasonId,
} from './model';

/** Pre-queue waits shorter than this are normal scheduling latency (reason 8 threshold). */
export const PRE_QUEUE_GRACE_MS = 30_000;
/** Post-queue waits shorter than this, with free slots, are normal pickup latency (reason 11 threshold). */
export const POST_QUEUE_GRACE_MS = 60_000;

export type WaitPhase = 'run' | 'pre-queue' | 'post-queue' | 'deferral' | 'any';

export const REASON_PHASE: Readonly<Record<WaitReasonId, WaitPhase>> = {
  'dag-max-active-runs': 'run',
  'pool-missing': 'pre-queue',
  'task-larger-than-pool': 'pre-queue',
  parallelism: 'pre-queue',
  'pool-exhausted': 'pre-queue',
  'dag-max-active-tasks': 'pre-queue',
  'task-limit': 'pre-queue',
  'scheduler-throughput': 'pre-queue',
  'autoscaling-lag': 'post-queue',
  'executor-slots-exhausted': 'post-queue',
  'worker-pickup': 'post-queue',
  'triggerer-capacity': 'deferral',
  unknown: 'any',
  'normal-latency': 'any',
};

/** Reasons that need inputs the snapshot model does not carry yet. */
export const UNEVALUATED_REASONS: ReadonlySet<WaitReasonId> = new Set([
  'dag-max-active-runs',
  'task-limit',
  'triggerer-capacity',
]);

export interface ClassifierContext {
  readonly config: EnvironmentConfig;
  /** `max_active_tasks` per DAG; DAGs not listed use `config.maxActiveTasksPerDag`. */
  readonly dagMaxActiveTasks: ReadonlyMap<string, number>;
}

export interface ClassifiedWait {
  readonly ti: SnapshotTaskInstance;
  readonly phase: 'pre-queue' | 'post-queue';
  readonly reason: WaitReasonId;
  readonly secondary: readonly WaitReasonId[];
}

/** Shared empty list of secondary reasons: most waits match one reason. */
const NONE: readonly WaitReasonId[] = Object.freeze([]);

export function classifySnapshot(s: LiveSnapshot, ctx: ClassifierContext): ClassifiedWait[] {
  const { config } = ctx;
  const pools = new Map(s.pools.map((p) => [p.name, p]));
  // A limit DCAM does not know is never treated as binding (spec L1082: unevaluated, not guessed).
  const parallelismFull =
    limitKnown(config, 'parallelism') &&
    s.executor.running + s.executor.queued >= config.parallelism * config.schedulers;
  const slotsKnown = limitKnown(config, 'workerConcurrency');
  const slotsFull = slotsKnown && s.executor.running >= s.workers.current * config.workerConcurrency;
  const out: ClassifiedWait[] = [];

  for (const ti of s.scheduled) {
    const pool = pools.get(ti.pool);
    const limit = ctx.dagMaxActiveTasks.get(ti.dagId) ?? config.maxActiveTasksPerDag;
    // The matches in check order, without an array per task instance: most match one reason or none.
    const a: WaitReasonId | null = !pool
      ? 'pool-missing'
      : ti.poolSlots > pool.slots
        ? 'task-larger-than-pool'
        : null;
    const b: WaitReasonId | null = parallelismFull ? 'parallelism' : null;
    const c: WaitReasonId | null =
      pool && ti.poolSlots <= pool.slots && pool.open < ti.poolSlots ? 'pool-exhausted' : null;
    const d: WaitReasonId | null = (s.dagActive[ti.dagId] ?? 0) >= limit ? 'dag-max-active-tasks' : null;
    const first = a ?? b ?? c ?? d;
    if (first === null) {
      const reason = s.at - ti.since >= PRE_QUEUE_GRACE_MS ? 'scheduler-throughput' : 'normal-latency';
      out.push({ ti, phase: 'pre-queue', reason, secondary: NONE });
      continue;
    }
    const later =
      (a === null ? 0 : 1) + (b === null ? 0 : 1) + (c === null ? 0 : 1) + (d === null ? 0 : 1) > 1;
    const secondary: readonly WaitReasonId[] = later
      ? ([a, b, c, d] as (WaitReasonId | null)[]).filter((r): r is WaitReasonId => r !== null).slice(1)
      : NONE;
    out.push({ ti, phase: 'pre-queue', reason: first, secondary });
  }

  for (const ti of s.queued) {
    let reason: WaitReasonId;
    if (slotsFull) {
      if (s.workers.current >= config.maxWorkers) reason = 'executor-slots-exhausted';
      else if (s.workers.target > s.workers.current) reason = 'autoscaling-lag';
      else reason = 'unknown';
    } else if (s.at - ti.since < POST_QUEUE_GRACE_MS) reason = 'normal-latency';
    // Without worker_concurrency, free slots cannot be told from full ones.
    else reason = slotsKnown ? 'worker-pickup' : 'unknown';
    out.push({ ti, phase: 'post-queue', reason, secondary: NONE });
  }
  return out;
}
