/**
 * HM-003 totals of a whole environment per time bucket: the denominator of every "share of the environment"
 * (FR-DAGD-06, FR-DAGD-08). Stores may compute the same in their query engine (`TaskInstanceStore.environmentLoad`);
 * this is the reference they are tested against, and the fallback over tries already read. Pure.
 *
 * Clipping is `slotSeconds`'s: a try without a start, or ending before it starts, is no load; a running try ends at
 * `now`; time after `now` has not happened. Executor slot-seconds count one slot per running try; pool
 * slot-seconds weigh by `pool_slots`. Buckets start at an origin at or before the window start: the window start
 * itself by default, or a UTC-aligned time (the hour, for hour-of-day profiles); a store's grid is aligned so.
 *
 * @implements HM-003, FR-DAGD-06, FR-DAGD-08
 */
import type { SweepWindow, TaskTry } from './occupancy';

export interface EnvironmentLoad {
  /** Start of the first bucket, at or before the window start. */
  readonly origin: number;
  readonly bucketMs: number;
  /** Executor slot-seconds per bucket from the origin, `ceil((to − origin) ÷ bucket)` entries. */
  readonly executorSlotSeconds: readonly number[];
  /** Pool slot-seconds per pool over the window. */
  readonly poolSlotSeconds: ReadonlyMap<string, number>;
}

export function environmentLoad(
  tries: readonly TaskTry[],
  w: SweepWindow,
  bucketMs: number,
  origin: number = w.from,
): EnvironmentLoad {
  if (!Number.isInteger(bucketMs) || bucketMs <= 0)
    throw new RangeError(`bucketMs must be a positive integer, not ${bucketMs}`);
  if (origin > w.from) throw new RangeError('the bucket origin must be at or before the window start');
  const count = Math.max(0, Math.ceil((w.to - origin) / bucketMs));
  const end = Math.min(w.to, Math.max(w.from, w.now));
  const executorMs = new Array<number>(count).fill(0);
  const poolMs = new Map<string, number>();
  for (const t of tries) {
    if (t.startAt === null) continue;
    const stop = t.endAt ?? w.now;
    if (stop < t.startAt) continue;
    const from = Math.max(t.startAt, w.from);
    const to = Math.min(stop, end);
    if (!(to > from)) continue;
    poolMs.set(t.pool, (poolMs.get(t.pool) ?? 0) + (to - from) * t.poolSlots);
    for (let k = Math.floor((from - origin) / bucketMs); k < count; k++) {
      const bFrom = origin + k * bucketMs;
      if (bFrom >= to) break;
      const overlap = Math.min(to, bFrom + bucketMs) - Math.max(from, bFrom);
      if (overlap > 0) executorMs[k] = (executorMs[k] as number) + overlap;
    }
  }
  return {
    origin,
    bucketMs,
    executorSlotSeconds: executorMs.map((ms) => ms / 1000),
    poolSlotSeconds: new Map([...poolMs].map(([pool, ms]) => [pool, ms / 1000])),
  };
}

/**
 * Which buckets DCAM has task history for: those that end after the environment's history start and begin before
 * `now`. The others are gaps (NFR-DATA-03), never zero. All `false` without history.
 */
export function coveredBuckets(w: SweepWindow, bucketMs: number, historyFrom: number | null): boolean[] {
  const count = Math.max(0, Math.ceil((w.to - w.from) / bucketMs));
  const end = Math.max(w.from, w.now);
  return Array.from({ length: count }, (_, k) => {
    const start = w.from + k * bucketMs;
    return historyFrom !== null && start + bucketMs > historyFrom && start < end;
  });
}
