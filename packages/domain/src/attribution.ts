/**
 * Waiting attribution over time (FR-BOTL-01) and worker capacity (HM-011, HM-012). Each waiting task
 * instance in a live snapshot stands for one snapshot interval of waiting, attributed to its HM-006
 * reason.
 *
 * @implements FR-BOTL-01, HM-006, HM-011, HM-012
 */
import type { EnvironmentConfig, LiveSnapshot, WaitReasonId, WorkerSample } from './model';
import { quantile, type Quantile } from './stats';
import { classifySnapshot, type ClassifiedWait, type ClassifierContext } from './waiting';

export interface AttributionOptions {
  readonly from: number;
  readonly to: number;
  readonly bucketMs: number;
  /** Time each snapshot stands for (the `af.live` cadence). */
  readonly intervalMs: number;
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
  readonly pools: ReadonlyMap<string, PoolPressure>;
  /** Per reason: waiting ms while workers were at `max_count`. */
  readonly atMaxWorkersMs: ReadonlyMap<WaitReasonId, number>;
  readonly latest: { readonly snapshot: LiveSnapshot; readonly classified: readonly ClassifiedWait[] } | null;
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
  const atMax = new Map<WaitReasonId, number>();
  const pools = new Map<string, { waitingMs: number; starvedMs: number; utilisation: number[] }>(
    config.pools.map((p) => [p.name, { waitingMs: 0, starvedMs: 0, utilisation: [] }]),
  );
  const bucketCount = Math.max(0, Math.ceil((opts.to - opts.from) / opts.bucketMs));
  const buckets = Array.from({ length: bucketCount }, (_, i) => ({
    start: opts.from + i * opts.bucketMs,
    byReason: new Map<WaitReasonId, number>(),
    workers: 0,
    slotsUsed: 0,
    n: 0,
  }));
  let latest: Attribution['latest'] = null;

  for (const s of snapshots) {
    if (s.at < opts.from || s.at >= opts.to) continue;
    const classified = classifySnapshot(s, ctx);
    const bucket = buckets[Math.floor((s.at - opts.from) / opts.bucketMs)];
    const workersAtMax = s.workers.current >= config.maxWorkers;
    for (const c of classified) {
      add(totals, c.reason, opts.intervalMs);
      if (bucket) add(bucket.byReason, c.reason, opts.intervalMs);
      const dags = byReasonDag.get(c.reason) ?? new Map<string, number>();
      add(dags, c.ti.dagId, opts.intervalMs);
      byReasonDag.set(c.reason, dags);
      if (workersAtMax) add(atMax, c.reason, opts.intervalMs);
      if (c.reason === 'pool-exhausted') {
        const p = pools.get(c.ti.pool);
        if (p) p.waitingMs += opts.intervalMs;
      }
    }
    for (const p of s.pools) {
      const pressure = pools.get(p.name);
      if (!pressure) continue;
      pressure.utilisation.push(p.slots > 0 ? (p.running + p.queued) / p.slots : 0);
      if (p.open === 0 && s.scheduled.some((ti) => ti.pool === p.name)) pressure.starvedMs += opts.intervalMs;
    }
    if (bucket) {
      const slots = s.workers.current * config.workerConcurrency;
      bucket.workers += s.workers.current;
      bucket.slotsUsed += slots > 0 ? Math.min(1, s.executor.running / slots) : 0;
      bucket.n++;
    }
    latest = { snapshot: s, classified };
  }

  const sortDesc = (m: Map<string, number>) =>
    new Map([...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
  return {
    totals,
    buckets: buckets.map((b) => ({
      start: b.start,
      byReason: b.byReason,
      workers: b.n ? b.workers / b.n : null,
      slotsUsed: b.n ? b.slotsUsed / b.n : null,
    })),
    byReasonDag: new Map([...byReasonDag].map(([r, m]) => [r, sortDesc(m)])),
    pools,
    atMaxWorkersMs: atMax,
    latest,
  };
}

export interface CapacityStats {
  /** Running ÷ (workers × worker_concurrency) per sample (HM-011). */
  readonly utilisation: Quantile;
  readonly minutesAtMax: number;
  /** HM-011: workers at `max_count` and queued ≥ max(10, 20 % of capacity). */
  readonly capacityBoundMinutes: number;
  /** HM-012: seconds from the autoscaler target rising above the workers to the workers reaching it. */
  readonly scaleUpLagsSeconds: readonly number[];
}

/** Capacity from one-minute worker samples, oldest first. */
export function capacityStats(samples: readonly WorkerSample[], config: EnvironmentConfig): CapacityStats {
  const minutes = (s: WorkerSample, next: WorkerSample | undefined) =>
    ((next?.at ?? s.at + 60_000) - s.at) / 60_000;
  const utilisation: number[] = [];
  let minutesAtMax = 0;
  let capacityBoundMinutes = 0;
  const lags: number[] = [];
  let episode: { start: number; target: number } | null = null;

  samples.forEach((s, i) => {
    const slots = s.workers * config.workerConcurrency;
    utilisation.push(slots > 0 ? Math.min(1, s.running / slots) : 0);
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
    minutesAtMax,
    capacityBoundMinutes,
    scaleUpLagsSeconds: lags,
  };
}
