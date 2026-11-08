/**
 * Comparing DAGs side by side (FR-DAGD-08, S-14): hourly load profiles in UTC and duration distributions on shared
 * bins, so that DAGs from different environments line up. The KPIs are the league's (`dagWindowStats`). Pure;
 * times are epoch ms.
 *
 * - Hourly profile: per UTC hour of day, the DAG's executor slot-seconds (HM-003) ÷ the time DCAM has history for
 *   in that hour of day over the window: the mean number of its tries running, in slots. DCAM collects neither
 *   environment display time zones nor DAG time zones, so every environment is compared in UTC. Hours of day
 *   without history are `null`, never zero (NFR-DATA-03).
 * - Share: the DAG's slot-seconds ÷ its environment's in that hour of day, over the same covered hours.
 * - Duration bins: log-spaced edges from the shortest positive to the longest duration of every DAG compared, so
 *   the histograms overlay; durations of 0 s fall in the first bin.
 *
 * @implements FR-DAGD-08, HM-003
 */
import { environmentLoad, type EnvironmentLoad } from './environment-load';
import type { SweepWindow, TaskTry } from './occupancy';

const HOUR = 3_600_000;

export interface HourOfDayLoad {
  /** UTC hour of day, 0–23. */
  readonly hour: number;
  /** Hours of history in this hour of day over the window (partial hours count in part). */
  readonly coveredHours: number;
  /** Mean running tries of the DAG over those hours, in slots; `null` without history. */
  readonly runningAvg: number | null;
  /** Share of the environment's executor slot-seconds, 0–1; `null` without history, load or environment load. */
  readonly share: number | null;
}

export interface HourlyLoadInput {
  readonly dagTries: readonly TaskTry[];
  /** The environment's load on whole UTC hours (`bucketMs` 1 h, origin on the hour); `null` when not known. */
  readonly environment: EnvironmentLoad | null;
  readonly window: SweepWindow;
  /** Start of the environment's stored task history; `null` without history. */
  readonly historyFrom: number | null;
}

export function hourlyLoadProfile(input: HourlyLoadInput): HourOfDayLoad[] {
  const { window: w } = input;
  const origin = Math.floor(w.from / HOUR) * HOUR;
  const env = input.environment;
  if (env && (env.bucketMs !== HOUR || env.origin !== origin))
    throw new RangeError('the environment load must be on whole UTC hours from the window start');
  const dag = environmentLoad(input.dagTries, w, HOUR, origin).executorSlotSeconds;
  const coveredMs = new Array<number>(24).fill(0);
  const dagSeconds = new Array<number>(24).fill(0);
  const envSeconds = new Array<number>(24).fill(0);
  const from = Math.max(w.from, input.historyFrom ?? Infinity);
  const to = Math.min(w.to, Math.max(w.from, w.now));
  dag.forEach((seconds, k) => {
    const start = origin + k * HOUR;
    const covered = Math.min(to, start + HOUR) - Math.max(from, start);
    if (!(covered > 0)) return;
    const hour = Math.floor(start / HOUR) % 24;
    coveredMs[hour] = (coveredMs[hour] as number) + covered;
    dagSeconds[hour] = (dagSeconds[hour] as number) + seconds;
    envSeconds[hour] = (envSeconds[hour] as number) + (env?.executorSlotSeconds[k] ?? 0);
  });
  return coveredMs.map((ms, hour): HourOfDayLoad => {
    const mine = dagSeconds[hour] as number;
    const total = envSeconds[hour] as number;
    return {
      hour,
      coveredHours: ms / HOUR,
      runningAvg: ms > 0 ? mine / (ms / 1000) : null,
      share: ms > 0 && env && total > 0 ? Math.min(1, mine / total) : null,
    };
  });
}

/**
 * Log-spaced bin edges shared by several samples of durations (seconds), ascending, `bins + 1` of them; two equal
 * edges when every positive duration is the same; none without a positive duration.
 */
export function sharedLogBins(samples: readonly (readonly number[])[], bins = 12): number[] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of samples)
    for (const v of s) {
      if (!Number.isFinite(v) || v <= 0) continue;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  if (!Number.isFinite(lo)) return [];
  if (lo === hi) return [lo, hi];
  const n = Math.max(1, Math.floor(bins));
  // In log space, so that the ratio of extreme durations cannot overflow.
  const a = Math.log(lo);
  const b = Math.log(hi);
  return Array.from({ length: n + 1 }, (_, i) =>
    i === 0 ? lo : i === n ? hi : Math.min(hi, Math.max(lo, Math.exp(a + ((b - a) * i) / n))),
  );
}

/** Counts of `values` per bin of `edges`: `[edge i, edge i + 1)`, the last bin closed; below the first edge in bin 0. */
export function histogram(values: readonly number[], edges: readonly number[]): number[] {
  const bins = edges.length - 1;
  if (bins < 1) return [];
  const counts = new Array<number>(bins).fill(0);
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    let lo = 0;
    let hi = bins - 1;
    // The last bin whose lower edge is ≤ v (bin 0 for values below every edge).
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if ((edges[mid] as number) <= v) lo = mid;
      else hi = mid - 1;
    }
    counts[lo] = (counts[lo] as number) + 1;
  }
  return counts;
}
