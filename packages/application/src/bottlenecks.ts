/**
 * Use case: why is work waiting (S-16). Classifies live snapshots by HM-006, aggregates waiting over
 * time, and adds pool pressure, worker capacity (HM-011, HM-012) and sensor waste (HM-008), with the
 * evidence behind the answer (`bottlenecks-depth.ts`): top pools per reason, pool activity (FR-ENV-08),
 * noisy neighbours (HM-017) and priority bands (HM-023). Where the store's retention deleted or thinned
 * snapshots of the range, the response says from when (FR-STORE-02, FR-STORE-07).
 *
 * Any range preset: the chart bucket keeps the series at 360 points or fewer (NFR-PERF-06), and snapshots
 * and tries are read a week at a time (NFR-PERF-01, {@link BOTTLENECK_SLICE_MS}). Snapshots are read twice
 * for ranges over a week: their times and spans first, for the window's `af.live` cadence, then in full for
 * the attribution, pool activity, priority bands and executor slots, which all take batches and equal a
 * single read. HM-017 needs every try of the range at once; beyond a week it keeps one small record per try
 * (DAG, queued, start, end), not the tries themselves.
 *
 * @implements FR-BOTL-01, FR-BOTL-02, FR-BOTL-06, FR-BOTL-07, FR-BOTL-09, FR-ENV-08, FR-STORE-02, FR-STORE-07,
 *   HM-006, HM-008, HM-011, HM-012, HM-017, HM-023, FR-UI-01, NFR-PERF-01, NFR-PERF-06
 */
import type { Bottlenecks, Range, SourceId } from '@dcam/contracts';
import {
  REASON_PHASE,
  UNEVALUATED_REASONS,
  WAIT_REASONS,
  adviceGap,
  capacityStats,
  createAttribution,
  createPoolActivity,
  createPriorityFairness,
  createSlotsPerMinute,
  limitKnown,
  ownsTry,
  quantile,
  rawCadenceMs,
  type LiveSnapshot,
  type NeighbourTry,
  type Slice,
  type TimedSnapshot,
  type WaitReasonId,
} from '@dcam/domain';
import type { Clock, EnvironmentModelSource, StoredTaskTry, TaskInstanceStore } from '@dcam/ports';
import { noisyNeighboursIn, poolDetail, priorityFairnessOf, topPools } from './bottlenecks-depth';
import { CHART_BUCKET_MS, RANGE_MS } from './range';
import { SLICE_MS, sliceSnapshots, sliceTries, slicesOf } from './slices';
import { composerConfig, usedSources } from './sources';

/**
 * The `af.live` cadence of the standard profile (spec §7.7, §17.2), assumed only while fewer than two
 * snapshots show the real one. Otherwise each snapshot stands for the real gap to the next, capped at
 * two cadences (domain `snapshot-time.ts`): the live profile collects every 10 s, eco every 120 s.
 */
export const DEFAULT_SNAPSHOT_CADENCE_MS = 30_000;
/**
 * Slices of the bottleneck analysis: a week, so 7 days are read once, as one query, and longer ranges a week
 * at a time. A week of snapshots and tries at 2,000 DAGs is about 20,000 snapshots (30 s cadence) and
 * 140,000 tries, which fits; reading a 7-day range in day slices would read its snapshots twice for nothing.
 */
export const BOTTLENECK_SLICE_MS = 7 * SLICE_MS;
const PLATFORM_REASONS = WAIT_REASONS.filter((r) => r !== 'normal-latency');

export interface BottleneckDeps {
  readonly store: TaskInstanceStore;
  readonly model: EnvironmentModelSource;
  readonly clock: Clock;
}

export interface BottleneckQuery {
  readonly envId: string;
  readonly range: Range;
  readonly sources: readonly SourceId[];
}

const iso = (ms: number) => new Date(ms).toISOString();
const seconds = (ms: number | undefined) => (ms ?? 0) / 1000;

/** An explicit window: `[from, to)` with buckets of `bucketMs`; `to` is "now" for running tries. */
export interface BottleneckWindowQuery {
  readonly envId: string;
  readonly from: number;
  readonly to: number;
  readonly bucketMs: number;
  readonly sources: readonly SourceId[];
}

export async function getBottlenecks(deps: BottleneckDeps, q: BottleneckQuery): Promise<Bottlenecks> {
  const now = deps.clock.now();
  return bottlenecksInWindow(deps, {
    envId: q.envId,
    from: now - RANGE_MS[q.range],
    to: now,
    bucketMs: CHART_BUCKET_MS[q.range],
    sources: q.sources,
  });
}

/** The bottleneck analysis over an explicit window (the range's `to` is the clock's now). */
/** The times (and stored spans) of the snapshots of several slices, without keeping the snapshots. */
async function snapshotTimes(model: EnvironmentModelSource, envId: string, slices: readonly Slice[]) {
  const times: TimedSnapshot[] = [];
  for (const slice of slices)
    for (const s of await sliceSnapshots(model, envId, slice))
      times.push(s.spanMs === undefined ? { at: s.at } : { at: s.at, spanMs: s.spanMs });
  return times;
}

export async function bottlenecksInWindow(
  deps: Pick<BottleneckDeps, 'store' | 'model'>,
  q: BottleneckWindowQuery,
  /** Store slice length; tests vary it to prove the result does not depend on it. */
  { sliceMs = BOTTLENECK_SLICE_MS }: { readonly sliceMs?: number } = {},
): Promise<Bottlenecks> {
  const { from, to: now, bucketMs } = q;
  const config = await deps.model.config(q.envId);
  if (!config) throw new Error(`No configuration collected for environment "${q.envId}".`);
  const [dags, samples, horizon] = await Promise.all([
    deps.model.dags(q.envId),
    deps.model.workerSamples(q.envId, from, now),
    deps.model.snapshotHorizon?.(q.envId),
  ]);
  const slices = slicesOf(from, now, sliceMs);
  // A horizon at or before the range start changes nothing in it; thinned data older than the deleted is gone.
  const inside = (t: number | null, after: number) =>
    t !== null && t > after ? iso(Math.min(t, now)) : null;
  const deletedFrom = Math.max(from, horizon?.deletedBefore ?? from);

  // The raw snapshots' cadence over the whole window comes first: a raw snapshot stands for the gap to the
  // next one, capped at two cadences; a thinned one for its stored span. One slice is read once and kept.
  const only = slices.length === 1 ? slices[0] : undefined;
  const kept: LiveSnapshot[] | null = only ? await sliceSnapshots(deps.model, q.envId, only) : null;
  const timed: readonly TimedSnapshot[] = kept ?? (await snapshotTimes(deps.model, q.envId, slices));
  const window = {
    from,
    to: now,
    bucketMs,
    fallbackCadenceMs: DEFAULT_SNAPSHOT_CADENCE_MS,
    cadenceMs: rawCadenceMs(timed),
  };
  const attribution = createAttribution(
    { config, dagMaxActiveTasks: new Map(dags.map((d) => [d.dagId, d.maxActiveTasks])) },
    window,
  );
  const pools = createPoolActivity(config, window);
  const bands = createPriorityFairness(window);
  const slots = createSlotsPerMinute({ samples, config, from, to: now });
  for (const slice of slices) {
    const snapshots = kept ?? (await sliceSnapshots(deps.model, q.envId, slice));
    attribution.add(snapshots);
    pools.add(snapshots);
    bands.add(snapshots);
    slots.add(snapshots);
  }
  const a = attribution.result();
  const activity = new Map(pools.result().map((p) => [p.name, p]));
  const waitingMs = PLATFORM_REASONS.reduce((s, r) => s + (a.totals.get(r) ?? 0), 0);
  const share = (part: number, whole: number) => (whole > 0 ? part / whole : 0);
  const top = PLATFORM_REASONS.reduce<WaitReasonId | null>(
    (best, r) => ((a.totals.get(r) ?? 0) > (best ? (a.totals.get(best) ?? 0) : 0) ? r : best),
    null,
  );

  const latest = a.latest;
  let binding: WaitReasonId | null = null;
  if (latest) {
    const counts = new Map<WaitReasonId, number>();
    for (const c of latest.classified)
      if (c.reason !== 'normal-latency') counts.set(c.reason, (counts.get(c.reason) ?? 0) + 1);
    binding = [...counts].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
  }

  const capacity = capacityStats(samples, config);
  // The advisor's data gate over this range: the headline never advises what the advisor would not.
  const rangeMs = now - from;
  const inRange = timed.length;
  const quality = {
    coverage: {
      snapshots: Math.min(1, a.coveredMs / rangeMs),
      samples: Math.min(1, (samples.length * 60_000) / rangeMs),
      tries: 1,
    },
    snapshotCount: inRange,
    sampleCount: samples.length,
  };
  // HM-008: worker slot time held by poke-mode sensors; HM-017 needs each try's DAG, queue and run times.
  // Each try counts in the slice it started in.
  const sensors = new Map<string, { dag_id: string; task_id: string; slot_seconds: number }>();
  const addSensor = (t: StoredTaskTry) => {
    if (!t.operator?.endsWith('Sensor') || t.startAt === null) return;
    const held = (Math.min(t.endAt ?? now, now) - Math.max(t.startAt, from)) / 1000;
    if (held <= 0) return;
    const key = `${t.dagId}\u0000${t.taskId}`;
    const s = sensors.get(key) ?? { dag_id: t.dagId, task_id: t.taskId, slot_seconds: 0 };
    s.slot_seconds += held;
    sensors.set(key, s);
  };
  // One slice (up to a week) keeps the tries themselves, which HM-017 reads fastest; longer ranges keep only
  // the four fields HM-017 reads, so a month of tries never stays in memory whole.
  const neighbourTries: NeighbourTry[] = [];
  const compact = slices.length > 1;
  for (const slice of slices) {
    for (const t of await sliceTries(deps.store, q.envId, slice)) {
      if (!ownsTry(t, slice, slice.from <= from)) continue;
      addSensor(t);
      neighbourTries.push(
        compact ? { dagId: t.dagId, queuedAt: t.queuedAt, startAt: t.startAt, endAt: t.endAt } : t,
      );
    }
  }

  return {
    env_id: q.envId,
    range: { from: iso(from), to: iso(now) },
    data_as_of: iso(latest?.snapshot.at ?? now),
    sources: usedSources(q.sources, {
      airflow: timed.length > 0 || neighbourTries.length > 0 || dags.length > 0,
      monitoring: samples.length > 0,
      composer: composerConfig(config),
    }),
    bucket_seconds: bucketMs / 1000,
    snapshot_interval_seconds: a.cadenceMs === null ? null : Math.max(1, Math.round(a.cadenceMs / 1000)),
    waiting_task_seconds: seconds(waitingMs),
    normal_latency_task_seconds: seconds(a.totals.get('normal-latency')),
    answer: {
      reason: top,
      share: top ? share(a.totals.get(top) ?? 0, waitingMs) : 0,
      workers_at_max_share: top ? share(a.atMaxWorkersMs.get(top) ?? 0, a.totals.get(top) ?? 0) : 0,
      advice_withheld: top ? adviceGap(quality, top) : null,
    },
    reasons: PLATFORM_REASONS.map((id) => {
      const total = a.totals.get(id) ?? 0;
      return {
        id,
        phase: REASON_PHASE[id],
        waiting_task_seconds: seconds(total),
        share: share(total, waitingMs),
        evaluated: !UNEVALUATED_REASONS.has(id),
        top_contributors: [...(a.byReasonDag.get(id) ?? new Map<string, number>())]
          .slice(0, 10)
          .map(([dag_id, ms]) => ({ dag_id, waiting_task_seconds: seconds(ms), share: share(ms, total) })),
        top_pools: topPools(a.byReasonPool.get(id), total),
      };
    }),
    series: a.buckets.map((b) => ({
      start: iso(b.start),
      waiting_task_seconds: Object.fromEntries(
        PLATFORM_REASONS.filter((r) => (b.byReason.get(r) ?? 0) > 0).map((r) => [
          r,
          seconds(b.byReason.get(r)),
        ]),
      ),
      workers: b.workers,
      worker_slots_used: b.slotsUsed,
    })),
    current: {
      at: latest ? iso(latest.snapshot.at) : null,
      binding,
      scheduled: latest?.snapshot.scheduled.length ?? 0,
      queued: latest?.snapshot.queued.length ?? 0,
      running: latest?.snapshot.executor.running ?? 0,
      workers: {
        current: latest?.snapshot.workers.current ?? 0,
        target: latest?.snapshot.workers.target ?? 0,
        min: config.minWorkers,
        max: config.maxWorkers,
      },
      // A worker_concurrency DCAM does not know is null, never the placeholder (HM-032).
      worker_slots: limitKnown(config, 'workerConcurrency')
        ? (latest?.snapshot.workers.current ?? 0) * config.workerConcurrency
        : null,
      // HM-011: a count from worker hostnames (no Cloud Monitoring) is an estimate, a lower bound.
      slots_source: latest?.snapshot.workers.source ?? null,
    },
    pools: config.pools.map((p) => {
      const pressure = a.pools.get(p.name);
      return {
        name: p.name,
        slots: p.slots,
        waiting_task_seconds: seconds(pressure?.waitingMs),
        starved_minutes: (pressure?.starvedMs ?? 0) / 60_000,
        utilisation_p95: quantile(pressure?.utilisation ?? [], 0.95).value,
        ...poolDetail(activity.get(p.name)),
      };
    }),
    noisy_neighbours: noisyNeighboursIn({
      config,
      tries: neighbourTries,
      slots: slots.result(),
      slotsSource: slots.source(),
      from,
      to: now,
      now,
    }),
    priority_fairness: priorityFairnessOf(bands.result()),
    capacity: {
      capacity_bound_minutes: capacity.capacityBoundMinutes,
      minutes_at_max_workers: capacity.minutesAtMax,
      scale_up_lag_p95_seconds: quantile(capacity.scaleUpLagsSeconds, 0.95).value,
      utilisation_p95: capacity.utilisation.value,
      worker_samples: samples.length,
    },
    sensors: [...sensors.values()].sort((x, y) => y.slot_seconds - x.slot_seconds).slice(0, 20),
    ...(horizon === undefined
      ? {}
      : {
          snapshot_retention: {
            deleted_before: inside(horizon.deletedBefore, from),
            thinned_before: inside(horizon.thinnedBefore, deletedFrom),
          },
        }),
  };
}
