/**
 * Waiting attribution over time (FR-BOTL-01) and worker capacity (HM-011, HM-012). Each waiting task
 * instance in a live snapshot stands for the time that snapshot stands for (the real gap to the next
 * snapshot, capped at two cadences, or its stored span when the disk budget thinned it: `snapshot-time.ts`),
 * attributed to its HM-006 reason.
 *
 * Top contributors per reason are kept per DAG and per pool (HM-006 output, spec L1088).
 *
 * @implements FR-BOTL-01, HM-006, HM-011, HM-012, FR-STORE-07
 */
import {
  limitKnown,
  type EnvironmentConfig,
  type LiveSnapshot,
  type WaitReasonId,
  type WorkerSample,
} from './model';
import { rawCadenceMs, snapshotSpans } from './snapshot-time';
import { quantile, type Quantile } from './stats';
import { classifySnapshot, type ClassifiedWait, type ClassifierContext } from './waiting';

export interface AttributionOptions {
  readonly from: number;
  readonly to: number;
  readonly bucketMs: number;
  /** The `af.live` cadence to assume while fewer than two snapshots in the window show the real one. */
  readonly fallbackCadenceMs: number;
}

export interface AttributionBucket {
  readonly start: number;
  readonly byReason: ReadonlyMap<WaitReasonId, number>;
  /** Mean workers over the bucket's snapshots; `null` without snapshots (a gap, never zero). */
  readonly workers: number | null;
  /** Mean running ÷ worker slots; `null` without snapshots. */
  readonly slotsUsed: number | null;
}

export interface PoolPressure {
  /** Waiting attributed to this pool being exhausted. */
  readonly waitingMs: number;
  /** Time with zero open slots while work waited for the pool. */
  readonly starvedMs: number;
  /** (running + queued) ÷ slots per snapshot. */
  readonly utilisation: readonly number[];
}

export interface Attribution {
  /** Waiting task-time per reason, in ms. */
  readonly totals: ReadonlyMap<WaitReasonId, number>;
  readonly buckets: readonly AttributionBucket[];
  /** Per reason: DAG → waiting ms, largest first. */
  readonly byReasonDag: ReadonlyMap<WaitReasonId, ReadonlyMap<string, number>>;
  /** Per reason: pool of the waiting task instance → waiting ms, largest first (top contributors). */
  readonly byReasonPool: ReadonlyMap<WaitReasonId, ReadonlyMap<string, number>>;
  readonly pools: ReadonlyMap<string, PoolPressure>;
  /** Per reason: waiting ms while workers were at `max_count`. */
  readonly atMaxWorkersMs: ReadonlyMap<WaitReasonId, number>;
  readonly latest: { readonly snapshot: LiveSnapshot; readonly classified: readonly ClassifiedWait[] } | null;
  /** The observed `af.live` cadence in the window; `null` with fewer than two raw (not thinned) snapshots. */
  readonly cadenceMs: number | null;
  /** Time the snapshots stand for together: the observed part of the window (coverage, §13.2). */
  readonly coveredMs: number;
}

const add = <K>(m: Map<K, number>, k: K, d: number) => m.set(k, (m.get(k) ?? 0) + d);

export function attributeWaiting(
  snapshots: readonly LiveSnapshot[],
  ctx: ClassifierContext,
  opts: AttributionOptions,
): Attribution {
  const { config } = ctx;
  const totals = new Map<WaitReasonId, number>();
  const byReasonDag = new Map<WaitReasonId, Map<string, number>>();
  const byReasonPool = new Map<WaitReasonId, Map<string, number>>();
  const atMax = new Map<WaitReasonId, number>();
  const pools = new Map<string, { waitingMs: number; starvedMs: number; utilisation: number[] }>(
    config.pools.map((p) => [p.name, { waitingMs: 0, starvedMs: 0, utilisation: [] }]),
  );
  // Without worker_concurrency the share of busy slots is unknown: a gap, never a placeholder ratio.
  const slotsKnown = limitKnown(config, 'workerConcurrency');
  const bucketCount = Math.max(0, Math.ceil((opts.to - opts.from) / opts.bucketMs));
  const buckets = Array.from({ length: bucketCount }, (_, i) => ({
    start: opts.from + i * opts.bucketMs,
    byReason: new Map<WaitReasonId, number>(),
    workers: 0,
    slotsUsed: 0,
    n: 0,
  }));
  let latest: Attribution['latest'] = null;
  const inWindow = snapshots.filter((s) => s.at >= opts.from && s.at < opts.to);
  // Thinned snapshots (FR-STORE-07) carry their own span and say nothing about the af.live cadence.
  const cadenceMs = rawCadenceMs(inWindow);
  const spans = snapshotSpans(inWindow, cadenceMs ?? opts.fallbackCadenceMs, opts.to);
  let coveredMs = 0;

  inWindow.forEach((s, i) => {
    const span = spans[i] ?? 0;
    coveredMs += span;
    const classified = classifySnapshot(s, ctx);
    const bucket = buckets[Math.floor((s.at - opts.from) / opts.bucketMs)];
    const workersAtMax = s.workers.current >= config.maxWorkers;
    for (const c of classified) {
      add(totals, c.reason, span);
      if (bucket) add(bucket.byReason, c.reason, span);
      let dags = byReasonDag.get(c.reason);
      if (!dags) byReasonDag.set(c.reason, (dags = new Map<string, number>()));
      add(dags, c.ti.dagId, span);
      let byPool = byReasonPool.get(c.reason);
      if (!byPool) byReasonPool.set(c.reason, (byPool = new Map<string, number>()));
      add(byPool, c.ti.pool, span);
      if (workersAtMax) add(atMax, c.reason, span);
      if (c.reason === 'pool-exhausted') {
        const p = pools.get(c.ti.pool);
        if (p) p.waitingMs += span;
      }
    }
    const ready = new Set<string>();
    for (const ti of s.scheduled) ready.add(ti.pool);
    for (const p of s.pools) {
      const pressure = pools.get(p.name);
      if (!pressure) continue;
      pressure.utilisation.push(p.slots > 0 ? (p.running + p.queued) / p.slots : 0);
      if (p.open === 0 && ready.has(p.name)) pressure.starvedMs += span;
    }
    if (bucket) {
      const slots = s.workers.current * config.workerConcurrency;
      bucket.workers += s.workers.current;
      bucket.slotsUsed += slots > 0 ? Math.min(1, s.executor.running / slots) : 0;
      bucket.n++;
    }
    latest = { snapshot: s, classified };
  });

  const sortDesc = (m: Map<string, number>) =>
    new Map([...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
  return {
    totals,
    buckets: buckets.map((b) => ({
      start: b.start,
      byReason: b.byReason,
      workers: b.n ? b.workers / b.n : null,
      slotsUsed: b.n && slotsKnown ? b.slotsUsed / b.n : null,
    })),
    byReasonDag: new Map([...byReasonDag].map(([r, m]) => [r, sortDesc(m)])),
    byReasonPool: new Map([...byReasonPool].map(([r, m]) => [r, sortDesc(m)])),
    pools,
    atMaxWorkersMs: atMax,
    latest,
    cadenceMs,
    coveredMs,
  };
}

export interface CapacityStats {
  /** Running ÷ (workers × worker_concurrency) per sample (HM-011). */
  readonly utilisation: Quantile;
  /** Minutes with workers at `max_count`; `null` without worker samples (no Cloud Monitoring data). */
  readonly minutesAtMax: number | null;
  /**
   * HM-011: workers at `max_count` and queued ≥ max(10, 20 % of capacity). `null` without worker
   * samples, or while `worker_concurrency` is unknown (HM-032): the capacity, and so the threshold, is
   * unknown too.
   */
  readonly capacityBoundMinutes: number | null;
  /** HM-012: seconds from the autoscaler target rising above the workers to the workers reaching it. */
  readonly scaleUpLagsSeconds: readonly number[];
}

/** Worker samples arrive once a minute (spec §7.7). */
const WORKER_SAMPLE_INTERVAL_MS = 60_000;

/**
 * Capacity from one-minute worker samples, oldest first. A sample stands for at most one sample
 * interval: across a collection gap nothing is known, so the gap is never filled with the last value.
 */
export function capacityStats(samples: readonly WorkerSample[], config: EnvironmentConfig): CapacityStats {
  const minutes = (s: WorkerSample, next: WorkerSample | undefined) =>
    Math.min((next?.at ?? s.at + WORKER_SAMPLE_INTERVAL_MS) - s.at, WORKER_SAMPLE_INTERVAL_MS) / 60_000;
  const utilisation: number[] = [];
  let minutesAtMax = 0;
  let capacityBoundMinutes = 0;
  const lags: number[] = [];
  let episode: { start: number; target: number } | null = null;

  const slotsKnown = limitKnown(config, 'workerConcurrency');
  samples.forEach((s, i) => {
    const slots = s.workers * config.workerConcurrency;
    if (slotsKnown) utilisation.push(slots > 0 ? Math.min(1, s.running / slots) : 0);
    const span = minutes(s, samples[i + 1]);
    if (s.workers >= config.maxWorkers) {
      minutesAtMax += span;
      if (s.queued >= Math.max(10, 0.2 * slots)) capacityBoundMinutes += span;
    }
    if (episode && s.workers >= episode.target) {
      lags.push((s.at - episode.start) / 1000);
      episode = null;
    }
    if (episode && s.target > episode.target) episode = { start: episode.start, target: s.target };
    if (!episode && s.target > s.workers) episode = { start: s.at, target: s.target };
  });

  return {
    utilisation: quantile(utilisation, 0.95),
    // No samples is no data, never "0 minutes" (spec §8.1).
    minutesAtMax: samples.length ? minutesAtMax : null,
    capacityBoundMinutes: samples.length && slotsKnown ? capacityBoundMinutes : null,
    scaleUpLagsSeconds: lags,
  };
}
