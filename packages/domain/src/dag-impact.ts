/**
 * Impact of one DAG on its environment over time (FR-DAGD-06): its share of the environment's executor load
 * (HM-003), and of the executor slots (workers × `worker_concurrency`, HM-011) where they are known. The other half
 * of the impact, the noisy-neighbour score, is `noisyNeighbourOf` (HM-017). Pure; times are epoch ms.
 *
 * - Share: the DAG's executor slot-seconds in the bucket ÷ the environment's. `null` before the environment's task
 *   history starts, and in buckets in which nothing ran (a share of nothing is no share).
 * - Capacity share: over the bucket's minutes with known slots only, the DAG's slot-seconds ÷ slots × 60 s.
 *   `null` when no minute of the bucket has known slots (HM-032): never a guessed capacity.
 *
 * @implements FR-DAGD-06, HM-003, HM-011
 */
import { coveredBuckets, environmentLoad, type EnvironmentLoad } from './environment-load';
import type { SweepWindow, TaskTry } from './occupancy';

const MIN = 60_000;

export interface LoadShareInput {
  /** The DAG's tries. */
  readonly dagTries: readonly TaskTry[];
  /** The environment's load over the same window and buckets, from the window start (`environmentLoad`). */
  readonly environment: EnvironmentLoad;
  readonly window: SweepWindow;
  readonly bucketMs: number;
  /** Start of the environment's stored task history; `null` without history. */
  readonly historyFrom: number | null;
  /** Executor slots per minute from the window start (`slotsPerMinute`); `null` where unknown. */
  readonly slots: readonly (number | null)[];
}

export interface LoadShareBucket {
  readonly start: number;
  /** The DAG's executor slot-seconds; `null` before the history start. */
  readonly dagSlotSeconds: number | null;
  readonly environmentSlotSeconds: number | null;
  /** 0–1; `null` before the history start or when nothing ran in the environment. */
  readonly share: number | null;
  /** 0–1 of the known executor slots; `null` without a minute of known slots, or before the history start. */
  readonly capacityShare: number | null;
}

const ratio = (part: number, whole: number) => Math.min(1, Math.max(0, part / whole));

export function loadShare(input: LoadShareInput): LoadShareBucket[] {
  const { window: w, bucketMs } = input;
  if (input.environment.origin !== w.from || input.environment.bucketMs !== bucketMs)
    throw new RangeError('the environment load must have the same buckets as the window');
  const covered = coveredBuckets(w, bucketMs, input.historyFrom);
  const dag = environmentLoad(input.dagTries, w, bucketMs).executorSlotSeconds;
  const perMinute = environmentLoad(input.dagTries, w, MIN).executorSlotSeconds;
  return covered.map((isCovered, k): LoadShareBucket => {
    const start = w.from + k * bucketMs;
    if (!isCovered)
      return { start, dagSlotSeconds: null, environmentSlotSeconds: null, share: null, capacityShare: null };
    const mine = dag[k] ?? 0;
    const total = input.environment.executorSlotSeconds[k] ?? 0;
    let used = 0;
    let capacity = 0;
    const first = Math.floor((start - w.from) / MIN);
    const last = Math.min(perMinute.length, Math.ceil((start + bucketMs - w.from) / MIN));
    for (let m = first; m < last; m++) {
      const slots = input.slots[m];
      if (slots === null || slots === undefined) continue;
      capacity += slots * 60;
      used += perMinute[m] ?? 0;
    }
    return {
      start,
      dagSlotSeconds: mine,
      environmentSlotSeconds: total,
      share: total > 0 ? ratio(mine, total) : null,
      capacityShare: capacity > 0 ? ratio(used, capacity) : null,
    };
  });
}
