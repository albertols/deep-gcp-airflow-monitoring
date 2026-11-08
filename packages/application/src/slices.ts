/**
 * Long ranges are read from the store a day at a time (NFR-PERF-01): a 30-day league at 2,000 DAGs
 * would otherwise hold more than a million tries in memory at once. Each slice is aggregated by the
 * domain's slice accumulators and dropped before the next one is read.
 *
 * @implements NFR-PERF-01, FR-UI-01
 */
import type { Slice, SweepWindow } from '@dcam/domain';
import type { EnvironmentModelSource, StoredTaskTry, TaskInstanceStore } from '@dcam/ports';

/** Longest slice read in one store query: one day, about 20,000 tries at the first target profile. */
export const SLICE_MS = 86_400_000;

/** `[from, to)` cut into consecutive slices of at most {@link SLICE_MS}, oldest first. */
export function slicesOf(from: number, to: number, size = SLICE_MS): Slice[] {
  const slices: Slice[] = [];
  for (let at = from; at < to; at += size) slices.push({ from: at, to: Math.min(to, at + size) });
  return slices;
}

/**
 * The tries of one slice, read 1 ms early so that a zero-length try on its first millisecond is not lost
 * (the slice accumulators count each try once, in the slice it started in).
 */
export const sliceTries = (store: TaskInstanceStore, envId: string, s: Slice): Promise<StoredTaskTry[]> =>
  store.taskTries(envId, s.from - 1, s.to);

/**
 * The live snapshots of one slice (`from <= at < to`). Kept to the slice even where a source returns more
 * (a test fake), so a snapshot is never counted in two slices.
 */
export async function sliceSnapshots(model: EnvironmentModelSource, envId: string, s: Slice) {
  const snapshots = await model.snapshots(envId, s.from, s.to);
  return snapshots.every((x) => x.at >= s.from && x.at < s.to)
    ? snapshots
    : snapshots.filter((x) => x.at >= s.from && x.at < s.to);
}

/** The earliest start (or queue time) among tries and `before`: where the history read so far begins. */
export const earliestOf = (tries: readonly StoredTaskTry[], before: number): number =>
  tries.reduce((m, t) => Math.min(m, t.startAt ?? t.queuedAt ?? Infinity), before);

/**
 * Share of a window with collected task history, from the earliest try read (`Infinity` without any).
 * History starts with DCAM's first `af.facts` cycle (backfill is FR-COLL-04, M2), so a window that starts
 * earlier is partly unknown: pages say so instead of presenting its totals as the whole range (§8.1).
 */
export function historyCoverage(earliest: number, w: Pick<SweepWindow, 'from' | 'to'>): number {
  if (!Number.isFinite(earliest)) return 0;
  return Math.min(1, Math.max(0, (w.to - Math.max(w.from, earliest)) / (w.to - w.from)));
}
