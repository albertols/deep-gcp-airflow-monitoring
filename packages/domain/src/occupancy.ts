/**
 * Occupancy sweep: the core derivation behind slot-seconds, queue analysis and capacity
 * (spec §11.8 step 2). Pure functions over task instance tries; times are epoch milliseconds.
 *
 * @implements HM-003 (slot-seconds per DAG), HM-011 (capacity utilisation: concurrency series)
 */

/** One task instance try, reduced to the fields the sweep needs. */
export interface TaskTry {
  readonly dagId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly mapIndex: number;
  readonly tryNumber: number;
  readonly pool: string;
  /** Pool slots the try occupies while running (`pool_slots`). */
  readonly poolSlots: number;
  /** Start of the running interval; `null` if the try never started. */
  readonly startAt: number | null;
  /** End of the running interval; `null` while the try is still running. */
  readonly endAt: number | null;
}

export interface SweepWindow {
  /** Inclusive window start (epoch ms). */
  readonly from: number;
  /** Exclusive window end (epoch ms). */
  readonly to: number;
  /** Injected clock: the end of tries that are still running. */
  readonly now: number;
}

export interface DagSlotSeconds {
  /** One executor (worker) slot per running try, regardless of `pool_slots`. */
  readonly executorSlotSeconds: number;
  /** Running time multiplied by `pool_slots`. */
  readonly poolSlotSeconds: number;
}

export interface SlotSecondsResult {
  readonly byDag: ReadonlyMap<string, DagSlotSeconds>;
  readonly byPool: ReadonlyMap<string, number>;
  readonly totalExecutorSlotSeconds: number;
  /** Tries skipped because they never started or end before they start (data-quality signal). */
  readonly rejected: number;
}

export interface OccupancyBucket {
  readonly start: number;
  /** Time-weighted average number of running tries over the bucket (a partial last bucket uses its real length). */
  readonly avg: number;
  /** Highest weighted level held for a positive duration in the bucket. */
  readonly max: number;
}

/** Key used in {@link occupancySeries} results for the whole input. */
export const TOTAL_KEY = '*';

export interface Interval {
  readonly from: number;
  readonly to: number;
  readonly weight: number;
}

export interface OccupancyOptions {
  /** Also produce one series per key, for example per DAG or per pool. */
  readonly groupBy?: (t: TaskTry) => string;
  /** Slots a try occupies; 1 for executor slots (default), `t.poolSlots` for pool series. */
  readonly weight?: (t: TaskTry) => number;
  /** Bucket size in milliseconds (default one minute). */
  readonly bucketMs?: number;
}

/** End of the observable window: buckets after "now" have not happened yet. */
function observedEnd(w: SweepWindow): number {
  return Math.min(w.to, Math.max(w.from, w.now));
}

/** The try's running interval clipped to the window, or `null` if it has none inside it. */
export function clippedInterval(t: TaskTry, w: SweepWindow, weight = 1): Interval | null | 'rejected' {
  if (t.startAt === null || !Number.isFinite(t.startAt)) return 'rejected';
  const end = t.endAt ?? w.now;
  if (!Number.isFinite(end) || end < t.startAt) return 'rejected';
  const from = Math.max(t.startAt, w.from);
  const to = Math.min(end, observedEnd(w));
  return to > from ? { from, to, weight } : null;
}

/**
 * HM-003: executor and pool slot-seconds per DAG and pool, clipped to the window. `key` groups `byDag` by
 * something else, such as the task ID (one DAG's tasks).
 */
export function slotSeconds(
  tries: readonly TaskTry[],
  w: SweepWindow,
  key: (t: TaskTry) => string = (t) => t.dagId,
): SlotSecondsResult {
  const byDag = new Map<string, { executorSlotSeconds: number; poolSlotSeconds: number }>();
  const byPool = new Map<string, number>();
  let totalMs = 0;
  let rejected = 0;
  for (const t of tries) {
    const iv = clippedInterval(t, w);
    if (iv === 'rejected') {
      rejected++;
      continue;
    }
    if (iv === null) continue;
    const seconds = (iv.to - iv.from) / 1000;
    const k = key(t);
    const dag = byDag.get(k) ?? { executorSlotSeconds: 0, poolSlotSeconds: 0 };
    dag.executorSlotSeconds += seconds;
    dag.poolSlotSeconds += seconds * t.poolSlots;
    byDag.set(k, dag);
    byPool.set(t.pool, (byPool.get(t.pool) ?? 0) + seconds * t.poolSlots);
    totalMs += iv.to - iv.from;
  }
  return { byDag, byPool, totalExecutorSlotSeconds: totalMs / 1000, rejected };
}

/**
 * HM-011: per-bucket average and maximum number of running tries (one executor slot each),
 * for the whole input under {@link TOTAL_KEY} and, optionally, per group key.
 */
export function occupancySeries(
  tries: readonly TaskTry[],
  w: SweepWindow,
  options: OccupancyOptions = {},
): Map<string, OccupancyBucket[]> {
  const bucketMs = options.bucketMs ?? 60_000;
  if (!Number.isInteger(bucketMs) || bucketMs <= 0)
    throw new RangeError(`bucketMs must be a positive integer, not ${bucketMs}`);
  const total: Interval[] = [];
  // Group keys are free-form (pool and DAG names), so the total is kept apart from them.
  const groups = new Map<string, Interval[]>();
  for (const t of tries) {
    const iv = clippedInterval(t, w, options.weight?.(t) ?? 1);
    if (iv === null || iv === 'rejected') continue;
    total.push(iv);
    if (options.groupBy) {
      const key = options.groupBy(t);
      const list = groups.get(key) ?? [];
      list.push(iv);
      groups.set(key, list);
    }
  }
  const result = new Map<string, OccupancyBucket[]>();
  for (const [key, intervals] of groups) result.set(key, sweep(intervals, w, bucketMs));
  // Set last so that a group named like the total key cannot overwrite it.
  result.set(TOTAL_KEY, sweep(total, w, bucketMs));
  return result;
}

function sweep(intervals: readonly Interval[], w: SweepWindow, bucketMs: number): OccupancyBucket[] {
  const end = observedEnd(w);
  const bucketCount = Math.max(0, Math.ceil((end - w.from) / bucketMs));
  const area = new Array<number>(bucketCount).fill(0);
  const max = new Array<number>(bucketCount).fill(0);

  // Net change in concurrency at each distinct time; coalescing equal times means a try that
  // ends exactly when another starts is never counted twice.
  const deltas = new Map<number, number>();
  for (const iv of intervals) {
    deltas.set(iv.from, (deltas.get(iv.from) ?? 0) + iv.weight);
    deltas.set(iv.to, (deltas.get(iv.to) ?? 0) - iv.weight);
  }
  const times = [...deltas.keys()].sort((a, b) => a - b);

  let level = 0;
  for (let i = 0; i < times.length - 1; i++) {
    const segFrom = times[i] as number;
    const segTo = times[i + 1] as number;
    level += deltas.get(segFrom) ?? 0;
    if (level === 0) continue;
    // The constant level holds on [segFrom, segTo); spread it over the buckets it overlaps.
    let b = Math.floor((segFrom - w.from) / bucketMs);
    for (; b < bucketCount; b++) {
      const bFrom = w.from + b * bucketMs;
      const bTo = Math.min(bFrom + bucketMs, end);
      if (bFrom >= segTo) break;
      const overlap = Math.min(segTo, bTo) - Math.max(segFrom, bFrom);
      if (overlap <= 0) continue;
      area[b] = (area[b] ?? 0) + level * overlap;
      if (level > (max[b] ?? 0)) max[b] = level;
    }
  }

  return area.map((a, b) => {
    const start = w.from + b * bucketMs;
    // A partial last bucket is averaged over its real length.
    const length = Math.min(start + bucketMs, end) - start;
    return { start, avg: a / length, max: max[b] ?? 0 };
  });
}
