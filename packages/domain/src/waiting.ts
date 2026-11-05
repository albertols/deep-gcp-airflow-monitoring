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
    const matches: WaitReasonId[] = [];
    if (!pool) matches.push('pool-missing');
    else if (ti.poolSlots > pool.slots) matches.push('task-larger-than-pool');
    if (parallelismFull) matches.push('parallelism');
    if (pool && ti.poolSlots <= pool.slots && pool.open < ti.poolSlots) matches.push('pool-exhausted');
    if ((s.dagActive[ti.dagId] ?? 0) >= limit) matches.push('dag-max-active-tasks');
    if (matches.length === 0)
      matches.push(s.at - ti.since >= PRE_QUEUE_GRACE_MS ? 'scheduler-throughput' : 'normal-latency');
    out.push({ ti, phase: 'pre-queue', reason: matches[0] as WaitReasonId, secondary: matches.slice(1) });
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
    out.push({ ti, phase: 'post-queue', reason, secondary: [] });
  }
  return out;
}
