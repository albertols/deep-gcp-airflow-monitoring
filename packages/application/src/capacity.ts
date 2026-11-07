/**
 * Use case: environment capacity (S-04). Reads the range's worker samples, live snapshots and task tries, runs
 * the domain's capacity analysis (HM-011, HM-012), pool activity (FR-ENV-08) and the DAG × hour-of-day load
 * (FR-DAGX-06), and maps them to the contract with the provenance of every limit (HM-032, spec §14.1).
 *
 * The range starts on a bucket boundary (UTC) so that buckets and heatmap hours line up; it can be up to one
 * bucket longer than asked for, and says so in `range.from`.
 *
 * @implements FR-ENV-02, FR-DAGX-06, HM-011, HM-012, HM-032, NFR-DATA-03
 */
import type {
  Capacity,
  CapacityRange,
  LimitSource,
  SourceId,
  Spread as SpreadContract,
} from '@dcam/contracts';
import {
  capacityAnalysis,
  dagLoadByHour,
  limitKnown,
  poolActivity,
  type EnvironmentConfig,
  type LimitKey,
  type Spread,
} from '@dcam/domain';
import type { Clock, EnvironmentModelSource, TaskInstanceStore } from '@dcam/ports';
import { DEFAULT_SNAPSHOT_CADENCE_MS } from './bottlenecks';
import { historyStartOf, readHistoryStart } from './history';
import { RANGE_MS } from './range';
import { composerConfig, usedSources } from './sources';

const MIN = 60_000;
const HOUR = 60 * MIN;
export const CAPACITY_RANGE_MS: Readonly<Record<CapacityRange, number>> = {
  ...RANGE_MS,
  '7d': 7 * 24 * HOUR,
};
export const CAPACITY_BUCKET_MS: Readonly<Record<CapacityRange, number>> = {
  '1h': MIN,
  '6h': 5 * MIN,
  '24h': 15 * MIN,
  '7d': HOUR,
};
/** FR-DAGX-06 "top N DAGs". */
export const DAG_LOAD_TOP = 20;
/** The newest capacity-bound periods returned; `period_count` counts them all. */
const MAX_PERIODS = 500;
const NOT_COLLECTED_WORKLOADS = ['scheduler', 'triggerer', 'dag-processor', 'web-server'] as const;

export interface CapacityDeps {
  readonly store: TaskInstanceStore;
  readonly model: EnvironmentModelSource;
  readonly clock: Clock;
}

export interface CapacityQuery {
  readonly envId: string;
  readonly range: CapacityRange;
  readonly sources: readonly SourceId[];
}

const iso = (ms: number) => new Date(ms).toISOString();
const isoOrNull = (ms: number | null) => (ms === null ? null : iso(ms));

/** Absent provenance means exact: demo data or a self-managed Airflow's file (`EnvironmentConfig.limitSources`). */
export const limitSourceOf = (config: EnvironmentConfig, key: LimitKey): LimitSource =>
  config.limitSources?.[key] ?? 'configured';

export const spreadOf = (s: Spread): SpreadContract => ({
  p50: s.p50,
  p95: s.p95,
  max: s.max,
  samples: s.samples,
  low_sample: s.lowSample,
});

const NO_FIGURES =
  'No worker figures in this range: neither Cloud Monitoring worker samples nor live snapshots were collected.';
const NO_CONCURRENCY =
  'worker_concurrency is not known (no override in the Composer configuration), so DCAM cannot tell when worker slots are full (HM-032).';
const NO_SCALE_SAMPLES =
  'Scale events need Cloud Monitoring worker counts. Without them the counts come from the configured limits or from task instance hostnames, which are lower bounds and drop whenever a worker is idle.';

export async function getCapacity(deps: CapacityDeps, q: CapacityQuery): Promise<Capacity> {
  const now = deps.clock.now();
  const bucketMs = CAPACITY_BUCKET_MS[q.range];
  const from = Math.floor((now - CAPACITY_RANGE_MS[q.range]) / bucketMs) * bucketMs;
  const config = await deps.model.config(q.envId);
  if (!config) throw new Error(`No configuration collected for environment "${q.envId}".`);
  const [snapshots, samples, tries, storedHistory] = await Promise.all([
    deps.model.snapshots(q.envId, from, now),
    deps.model.workerSamples(q.envId, from, now),
    deps.store.taskTries(q.envId, from, now),
    readHistoryStart(deps.store, q.envId),
  ]);
  const historyFrom = historyStartOf(storedHistory, tries);
  const a = capacityAnalysis({ config, samples, snapshots, tries, from, to: now, bucketMs, historyFrom });
  const pools = poolActivity(snapshots, config, {
    from,
    to: now,
    bucketMs,
    fallbackCadenceMs: DEFAULT_SNAPSHOT_CADENCE_MS,
  });
  const load = dagLoadByHour(tries, { from, to: now, now, historyFrom, top: DAG_LOAD_TOP });

  const concurrencyKnown = limitKnown(config, 'workerConcurrency');
  const parallelismKnown = limitKnown(config, 'parallelism');
  const observed = a.observedMinutes;
  const boundReason = observed === 0 ? NO_FIGURES : concurrencyKnown ? null : NO_CONCURRENCY;
  return {
    env_id: q.envId,
    range: { from: iso(from), to: iso(now) },
    data_as_of: isoOrNull(a.latest),
    sources: usedSources(q.sources, {
      airflow: snapshots.length > 0 || tries.length > 0,
      monitoring: samples.length > 0,
      composer: composerConfig(config),
    }),
    bucket_seconds: bucketMs / 1000,
    slots_source: a.slotsSource,
    limits: {
      worker_concurrency: concurrencyKnown ? config.workerConcurrency : null,
      worker_concurrency_source: limitSourceOf(config, 'workerConcurrency'),
      min_workers: config.minWorkers,
      max_workers: config.maxWorkers,
      worker_slots_at_max: concurrencyKnown ? config.maxWorkers * config.workerConcurrency : null,
      parallelism: parallelismKnown ? config.parallelism : null,
      parallelism_source: limitSourceOf(config, 'parallelism'),
      schedulers: config.schedulers,
      parallelism_total: parallelismKnown ? config.parallelism * config.schedulers : null,
    },
    summary: {
      window_minutes: a.windowMinutes,
      observed_minutes: observed,
      coverage: a.windowMinutes > 0 ? observed / a.windowMinutes : 0,
      utilisation: spreadOf(a.utilisation),
      minutes_at_max_workers: a.minutesAtMax,
      capacity_bound_minutes: a.boundMinutes,
      capacity_bound_share: a.boundMinutes === null || observed === 0 ? null : a.boundMinutes / observed,
      running_peak: a.runningPeak,
      queued_peak: a.queuedPeak,
      scale_up_lag_seconds: spreadOf(a.scaleUpLag),
    },
    series: a.buckets.map((b) => ({
      start: iso(b.start),
      observed_minutes: b.observedMinutes,
      workers_mean: b.workersMean,
      workers_max: b.workersMax,
      target_max: b.targetMax,
      worker_slots_mean: b.slotsMean,
      running_mean: b.runningMean,
      running_peak: b.runningPeak,
      queued_mean: b.queuedMean,
      queued_peak: b.queuedPeak,
      running_tries_mean: b.runningTriesMean,
      utilisation_mean: b.utilisationMean,
      minutes_at_max: b.atMaxMinutes,
      capacity_bound_minutes: b.boundMinutes,
      cpu_max: b.cpuMax,
      memory_max: b.memoryMax,
    })),
    capacity_bound: {
      evaluated: boundReason === null,
      not_evaluated_reason: boundReason,
      min_queued: a.threshold.minQueued,
      queued_ratio: a.threshold.queuedRatio,
      period_count: a.periods.length,
      periods: a.periods.slice(-MAX_PERIODS).map((p) => ({
        start: iso(p.start),
        end: iso(p.end),
        minutes: p.minutes,
        queued_peak: p.queuedPeak,
        workers: p.workers,
      })),
    },
    scale_events: {
      evaluated: a.scaleEvents.evaluated,
      not_evaluated_reason: a.scaleEvents.evaluated ? null : NO_SCALE_SAMPLES,
      up: a.scaleEvents.up,
      down: a.scaleEvents.down,
      items: a.scaleEvents.items.map((e) => ({ at: iso(e.at), from: e.from, to: e.to })),
    },
    workloads: [
      {
        workload: 'celery-worker',
        samples: a.worker.samples,
        cpu: spreadOf(a.worker.cpu),
        memory: spreadOf(a.worker.memory),
      },
    ],
    workloads_not_collected: [...NOT_COLLECTED_WORKLOADS],
    heatmap: {
      time_zone: 'UTC',
      cells: a.heatmap.map((c) => ({
        date: iso(c.day).slice(0, 10),
        hour: c.hour,
        observed_minutes: c.observedMinutes,
        utilisation_mean: c.utilisationMean,
        minutes_at_max: c.atMaxMinutes,
        capacity_bound_minutes: c.boundMinutes,
      })),
    },
    pools: pools.map((p) => ({
      name: p.name,
      slots: p.slots,
      running_slots_avg: p.runningSlotsAvg,
      running_slots_peak: p.runningSlotsPeak,
      queued_slots_avg: p.queuedSlotsAvg,
      starved_minutes: p.observedMs > 0 ? p.starvedMs / MIN : null,
    })),
    dag_load: {
      method: 'FR-DAGX-06/task-tries',
      time_zone: 'UTC',
      top: DAG_LOAD_TOP,
      covered_hours: [...load.coveredHours],
      total_executor_slot_seconds: load.totalExecutorSlotSeconds,
      dag_count: load.dagCount,
      dags: load.dags.map((d) => ({
        dag_id: d.dagId,
        executor_slot_seconds: d.executorSlotSeconds,
        share: d.share,
        hours: [...d.hours],
      })),
    },
  };
}
