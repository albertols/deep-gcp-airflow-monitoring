/**
 * Pools over a range (FR-ENV-08, the pools section of S-16): how many slots each pool ran and queued, how
 * much ready and queued work waited in it, when it starved, and which DAGs waited most. Each live snapshot
 * stands for the real gap to the next one, capped at two cadences (`snapshot-time.ts`), as in the HM-006
 * attribution, so both add up over the same time.
 *
 * "Starved" means zero open slots while ready (`scheduled`) work waited for the pool, the rule REC-CONC-02
 * and the attribution use. Deferred slots are not part of DCAM's snapshots and are not reported.
 *
 * @implements FR-ENV-08
 */
import type { EnvironmentConfig, LiveSnapshot } from './model';
import { observedCadenceMs, snapshotSpans } from './snapshot-time';

export interface PoolActivityOptions {
  readonly from: number;
  readonly to: number;
  readonly bucketMs: number;
  /** The `af.live` cadence to assume while fewer than two snapshots show the real one. */
  readonly fallbackCadenceMs: number;
}

export interface PoolActivity {
  readonly name: string;
  readonly slots: number;
  /** Time the snapshots that list the pool stand for, in ms. */
  readonly observedMs: number;
  /** Time-weighted mean slots held by running task instances; `null` without observations. */
  readonly runningSlotsAvg: number | null;
  /** Most running slots in one snapshot; `null` without observations. */
  readonly runningSlotsPeak: number | null;
  /** Time-weighted mean slots held by queued task instances; `null` without observations. */
  readonly queuedSlotsAvg: number | null;
  /** Ready task instances of the pool × time: pre-queue waiting in this pool, in task-ms. */
  readonly readyTaskMs: number;
  /** Queued task instances of the pool × time: post-queue waiting in this pool, in task-ms. */
  readonly queuedTaskMs: number;
  /** Zero open slots while ready work waited for the pool, in ms. */
  readonly starvedMs: number;
  /** Starved ms per bucket from `from`; `null` for buckets without a snapshot (a gap, never zero). */
  readonly starvedByBucket: readonly (number | null)[];
  /** Every DAG with ready or queued work in the pool, by waiting task-ms, largest first. */
  readonly topDags: ReadonlyArray<{ readonly dagId: string; readonly waitingMs: number }>;
}

interface Acc {
  observedMs: number;
  runningArea: number;
  queuedArea: number;
  peak: number;
  readyTaskMs: number;
  queuedTaskMs: number;
  starvedMs: number;
  starved: (number | null)[];
  dags: Map<string, number>;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function poolActivity(
  snapshots: readonly LiveSnapshot[],
  config: Pick<EnvironmentConfig, 'pools'>,
  opts: PoolActivityOptions,
): PoolActivity[] {
  const bucketCount = Math.max(0, Math.ceil((opts.to - opts.from) / opts.bucketMs));
  const acc = new Map<string, Acc>(
    config.pools.map((p) => [
      p.name,
      {
        observedMs: 0,
        runningArea: 0,
        queuedArea: 0,
        peak: 0,
        readyTaskMs: 0,
        queuedTaskMs: 0,
        starvedMs: 0,
        starved: new Array<number | null>(bucketCount).fill(null),
        dags: new Map(),
      },
    ]),
  );
  const inWindow = snapshots.filter((s) => s.at >= opts.from && s.at < opts.to);
  const spans = snapshotSpans(inWindow, observedCadenceMs(inWindow) ?? opts.fallbackCadenceMs, opts.to);

  inWindow.forEach((s, i) => {
    const span = spans[i] ?? 0;
    const bucket = Math.floor((s.at - opts.from) / opts.bucketMs);
    const ready = new Set<string>();
    for (const ti of s.scheduled) {
      const a = acc.get(ti.pool);
      if (!a) continue;
      ready.add(ti.pool);
      a.readyTaskMs += span;
      a.dags.set(ti.dagId, (a.dags.get(ti.dagId) ?? 0) + span);
    }
    for (const ti of s.queued) {
      const a = acc.get(ti.pool);
      if (!a) continue;
      a.queuedTaskMs += span;
      a.dags.set(ti.dagId, (a.dags.get(ti.dagId) ?? 0) + span);
    }
    for (const p of s.pools) {
      const a = acc.get(p.name);
      if (!a) continue;
      a.observedMs += span;
      a.runningArea += p.running * span;
      a.queuedArea += p.queued * span;
      a.peak = Math.max(a.peak, p.running);
      const starved = p.open === 0 && ready.has(p.name) ? span : 0;
      a.starvedMs += starved;
      if (bucket >= 0 && bucket < bucketCount) a.starved[bucket] = (a.starved[bucket] ?? 0) + starved;
    }
  });

  return config.pools.map((p) => {
    const a = acc.get(p.name) as Acc;
    const seen = a.observedMs > 0;
    return {
      name: p.name,
      slots: p.slots,
      observedMs: a.observedMs,
      runningSlotsAvg: seen ? a.runningArea / a.observedMs : null,
      runningSlotsPeak: seen ? a.peak : null,
      queuedSlotsAvg: seen ? a.queuedArea / a.observedMs : null,
      readyTaskMs: a.readyTaskMs,
      queuedTaskMs: a.queuedTaskMs,
      starvedMs: a.starvedMs,
      starvedByBucket: a.starved,
      topDags: [...a.dags]
        .sort((x, y) => y[1] - x[1] || cmp(x[0], y[0]))
        .map(([dagId, waitingMs]) => ({ dagId, waitingMs })),
    };
  });
}
