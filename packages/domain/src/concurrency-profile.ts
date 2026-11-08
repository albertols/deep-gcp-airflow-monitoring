/**
 * Concurrency profile of one DAG (FR-DAGD-05, S-12 tab "concurrency"): how many of its task instances ran at once
 * over time, against its `max_active_tasks` and the pools it uses, and how often its own limit held its ready work
 * back (HM-005, the computation REC-DAG-01 evaluates). Pure; times are epoch ms.
 *
 * - Running (HM-011): the occupancy sweep over the DAG's tries, mean and peak per bucket. Exact from task facts.
 *   Buckets that end before the environment's task history starts are `null`: DCAM did not collect then.
 * - In flight (running + queued, what `max_active_tasks` counts on Airflow 2) and own ready task instances: the
 *   peak over the bucket's live snapshots; time at the limit with own ready work, from the snapshots' spans
 *   (`self-throttling.ts`). Each snapshot counts in the bucket it was taken in. Buckets without a snapshot are
 *   `null`, never zero (NFR-DATA-03).
 * - Pools: the DAG's pool slots held by its running tries (`pool_slots` each, HM-003) against the pool size and
 *   the slots all DAGs occupied (running + queued) in the snapshots.
 * - Long windows: {@link createConcurrencyProfile} takes the snapshots in batches (NFR-PERF-01).
 *
 * @implements FR-DAGD-05, HM-005, HM-011, NFR-PERF-01
 */
import { coveredBuckets } from './environment-load';
import type { EnvironmentConfig, LiveSnapshot } from './model';
import { TOTAL_KEY, occupancySeries, type SweepWindow, type TaskTry } from './occupancy';
import {
  emptyDagLimitTally,
  freeWorkerSlots,
  observeDagLimit,
  type DagLimitTally,
  type DagLimitTotals,
} from './self-throttling';
import { rawCadenceMs, snapshotSpans, type TimedSnapshot } from './snapshot-time';

export interface ConcurrencyProfileInput {
  /** Tries of the DAG (other DAGs' tries are ignored). */
  readonly tries: readonly TaskTry[];
  /** Live snapshots of the environment, oldest first. */
  readonly snapshots: readonly LiveSnapshot[];
  readonly dagId: string;
  /** The DAG's `max_active_tasks` (its own, else `max_active_tasks_per_dag`). */
  readonly limit: number;
  readonly config: Pick<EnvironmentConfig, 'workerConcurrency' | 'limitSources' | 'pools'>;
  readonly window: SweepWindow;
  readonly bucketMs: number;
  /** The `af.live` cadence to assume while fewer than two raw snapshots show the real one. */
  readonly fallbackCadenceMs: number;
  /** Start of the environment's stored task history; `null` without history. */
  readonly historyFrom: number | null;
}

export interface ConcurrencyBucket {
  readonly start: number;
  /** Time-weighted mean of the DAG's running tries; `null` before the history start. */
  readonly runningAvg: number | null;
  /** Most of its tries running at once; `null` before the history start. */
  readonly runningMax: number | null;
  /** Peak running + queued task instances in the bucket's snapshots; `null` without a snapshot. */
  readonly inFlightMax: number | null;
  /** Peak own ready (scheduled) task instances in the bucket's snapshots; `null` without a snapshot. */
  readonly readyMax: number | null;
  /** Time at `max_active_tasks` with own ready work (HM-005), ms; `null` without a snapshot. */
  readonly atLimitMs: number | null;
}

export interface PoolProfile {
  readonly pool: string;
  /** Pool size from the configuration; `null` for a pool the environment does not define. */
  readonly slots: number | null;
  /** Largest `pool_slots` of the DAG's task instances in this pool. */
  readonly poolSlots: number;
  /** Per bucket: peak pool slots held by the DAG's running tries; `null` before the history start. */
  readonly dagSlotsMax: readonly (number | null)[];
  /** Per bucket: peak slots occupied (running + queued) by every DAG, from snapshots; `null` without one. */
  readonly occupiedMax: readonly (number | null)[];
}

export interface ConcurrencyProfile {
  readonly buckets: readonly ConcurrencyBucket[];
  readonly pools: readonly PoolProfile[];
  /** Most tries of the DAG running at once in the covered buckets; `null` without history in the window. */
  readonly peakRunning: number | null;
  /** Most running + queued task instances in one snapshot; `null` without snapshots. */
  readonly peakInFlight: number | null;
  /** Snapshots in the window. */
  readonly snapshots: number;
  /** Observed `af.live` cadence; `null` with fewer than two raw snapshots. */
  readonly cadenceMs: number | null;
  /** HM-005 over the window: equal to `dagSelfThrottling` for the same inputs. */
  readonly selfThrottling: DagLimitTotals;
}

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** What a {@link createConcurrencyProfile} needs besides the snapshots and the DAG's tries. */
export type ConcurrencyProfileOptions = Omit<ConcurrencyProfileInput, 'tries' | 'snapshots'>;

/** One snapshot in which the DAG was active, kept until the window's cadence gives its span. */
interface Observation {
  /** Position among the window's snapshots. */
  readonly index: number;
  readonly inFlight: number;
  readonly ready: number;
  readonly freeSlots: boolean;
}

/**
 * {@link concurrencyProfile} with the snapshots added in batches, oldest first (NFR-PERF-01): a 30-day window is
 * read a day at a time. Per-bucket peaks are kept as the snapshots come; HM-005 needs each snapshot's span, which
 * depends on the cadence of the whole window, so only the snapshot times and the DAG's active snapshots (four
 * numbers each) are kept until {@link result}. The result equals one pass over all the snapshots at once.
 */
export function createConcurrencyProfile(input: ConcurrencyProfileOptions) {
  const { dagId, window: w, bucketMs } = input;
  const count = Math.max(0, Math.ceil((w.to - w.from) / bucketMs));
  const times: TimedSnapshot[] = [];
  const observations: Observation[] = [];
  const inFlightMax = new Array<number | null>(count).fill(null);
  const readyMax = new Array<number | null>(count).fill(null);
  const occupied = new Map<string, (number | null)[]>();
  const poolSlots = new Map<string, number>();
  const notePool = (pool: string, slots: number) =>
    poolSlots.set(pool, Math.max(poolSlots.get(pool) ?? 1, slots));

  return {
    add(snapshots: readonly LiveSnapshot[]): void {
      for (const s of snapshots) {
        if (s.at < w.from || s.at >= w.to) continue;
        const k = Math.floor((s.at - w.from) / bucketMs);
        const index = times.length;
        times.push(s.spanMs === undefined ? { at: s.at } : { at: s.at, spanMs: s.spanMs });
        let ready = 0;
        for (const ti of s.scheduled)
          if (ti.dagId === dagId) {
            ready++;
            notePool(ti.pool, ti.poolSlots);
          }
        for (const ti of s.queued) if (ti.dagId === dagId) notePool(ti.pool, ti.poolSlots);
        const inFlight = s.dagActive[dagId];
        inFlightMax[k] = Math.max(inFlightMax[k] ?? 0, inFlight ?? 0);
        readyMax[k] = Math.max(readyMax[k] ?? 0, ready);
        for (const p of s.pools) {
          let series = occupied.get(p.name);
          if (!series) occupied.set(p.name, (series = new Array<number | null>(count).fill(null)));
          series[k] = Math.max(series[k] ?? 0, p.running + p.queued);
        }
        if (inFlight === undefined && ready === 0) continue;
        observations.push({
          index,
          inFlight: inFlight ?? 0,
          ready,
          freeSlots: freeWorkerSlots(s, input.config),
        });
      }
    },

    /** The profile, with the DAG's tries of the window (other DAGs' tries are ignored). */
    result(tries: readonly TaskTry[]): ConcurrencyProfile {
      const starts = Array.from({ length: count }, (_, k) => w.from + k * bucketMs);
      // A bucket that ends before the history start was not collected; one that has not begun has not happened.
      const covered = coveredBuckets(w, bucketMs, input.historyFrom);
      const own = tries.filter((t) => t.dagId === dagId);
      for (const t of own) notePool(t.pool, t.poolSlots);
      // Pool slots per pool; with one slot per try their total is the running count, so one sweep serves both.
      const byPool = occupancySeries(own, w, {
        bucketMs,
        groupBy: (t) => t.pool,
        weight: (t) => t.poolSlots,
      });
      const running = own.every((t) => t.poolSlots === 1)
        ? (byPool.get(TOTAL_KEY) ?? [])
        : (occupancySeries(own, w, { bucketMs }).get(TOTAL_KEY) ?? []);

      const cadenceMs = rawCadenceMs(times);
      const spans = snapshotSpans(times, cadenceMs ?? input.fallbackCadenceMs, w.to);
      const total = emptyDagLimitTally(input.config);
      const tallies = new Array<DagLimitTally | null>(count).fill(null);
      // Every snapshot opens its bucket's tally, so a bucket with snapshots but no activity has 0 at the limit.
      for (const t of times) {
        const k = Math.floor((t.at - w.from) / bucketMs);
        if (!tallies[k]) tallies[k] = emptyDagLimitTally(input.config);
      }
      for (const o of observations) {
        const at = (times[o.index] as TimedSnapshot).at;
        const observation = {
          at,
          spanMs: spans[o.index] ?? 0,
          inFlight: o.inFlight,
          ready: o.ready,
          limit: input.limit,
          freeSlots: o.freeSlots,
        };
        observeDagLimit(total, observation);
        observeDagLimit(tallies[Math.floor((at - w.from) / bucketMs)] as DagLimitTally, observation);
      }

      const buckets = starts.map((start, k): ConcurrencyBucket => {
        const sweep = covered[k] ? running[k] : undefined;
        const tally = tallies[k];
        return {
          start,
          runningAvg: sweep ? sweep.avg : null,
          runningMax: sweep ? sweep.max : null,
          inFlightMax: inFlightMax[k] ?? null,
          readyMax: readyMax[k] ?? null,
          atLimitMs: tally ? tally.atLimitMs : null,
        };
      });
      const sizes = new Map(input.config.pools.map((p) => [p.name, p.slots]));
      const pools = [...poolSlots.keys()].sort(byName).map((pool): PoolProfile => ({
        pool,
        slots: sizes.get(pool) ?? null,
        poolSlots: poolSlots.get(pool) ?? 1,
        dagSlotsMax: starts.map((_, k) => (covered[k] ? (byPool.get(pool)?.[k]?.max ?? 0) : null)),
        occupiedMax: occupied.get(pool) ?? new Array<number | null>(count).fill(null),
      }));
      const peaks = buckets.map((b) => b.runningMax).filter((x): x is number => x !== null);
      const inFlightPeaks = inFlightMax.filter((x): x is number => x !== null);
      return {
        buckets,
        pools,
        peakRunning: peaks.length ? Math.max(...peaks) : null,
        peakInFlight: inFlightPeaks.length ? Math.max(...inFlightPeaks) : null,
        snapshots: times.length,
        cadenceMs,
        selfThrottling: total,
      };
    },
  };
}

/** FR-DAGD-05 over snapshots and tries given at once. */
export function concurrencyProfile(input: ConcurrencyProfileInput): ConcurrencyProfile {
  const acc = createConcurrencyProfile(input);
  acc.add(input.snapshots);
  return acc.result(input.tries);
}
