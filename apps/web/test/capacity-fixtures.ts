/**
 * Synthetic S-04 fixtures typed by the contract (`Capacity`, `Forecast`): a fictitious acme environment with
 * 6 workers at most, 12 slots each, whose nightly batch is capacity-bound for 52 minutes from 02:03 UTC, and a
 * low-confidence forecast that flags the same window tomorrow. No real environment's data.
 */
import type { Capacity, Forecast, Meta } from '@dcam/contracts';
import type { DcamApi } from '../src/api';

const MIN = 60_000;
export const NOW = Date.UTC(2026, 10, 5, 12, 0);
const iso = (ms: number) => new Date(ms).toISOString();
/** An instant on 3 to 6 November 2026, UTC. */
export const at = (day: 3 | 4 | 5 | 6, h: number, m = 0) => iso(Date.UTC(2026, 10, day, h, m));

const BUCKET_MS = 15 * MIN;
const FROM = NOW - 24 * 60 * MIN;

/** Capacity-bound minutes per 15-minute bucket: the nightly batch, and a short evening peak. */
const BOUND: Readonly<Record<string, number>> = {
  [at(5, 2, 0)]: 12,
  [at(5, 2, 15)]: 15,
  [at(5, 2, 30)]: 15,
  [at(5, 2, 45)]: 10,
  [at(4, 19, 0)]: 13,
};

function bucket(start: number): Capacity['series'][number] {
  const key = iso(start);
  const bound = BOUND[key];
  const busy = bound !== undefined;
  const workers = busy ? 6 : 3;
  const running = busy ? 72 : 20;
  return {
    start: key,
    observed_minutes: 15,
    workers_mean: workers,
    workers_max: workers,
    target_max: workers,
    worker_slots_mean: workers * 12,
    running_mean: running,
    running_peak: running,
    queued_mean: busy ? 40 : 1,
    queued_peak: busy ? 70 : 3,
    running_tries_mean: running - 0.5,
    utilisation_mean: running / (workers * 12),
    minutes_at_max: busy ? 15 : 0,
    capacity_bound_minutes: bound ?? 0,
    cpu_max: 0.6,
    memory_max: 0.7,
  };
}

const series = Array.from({ length: 96 }, (_, i) => bucket(FROM + i * BUCKET_MS));

const heatCells: Capacity['heatmap']['cells'] = Array.from({ length: 24 }, (_, i) => {
  const ms = FROM + i * 60 * MIN;
  const d = new Date(ms);
  const hour = d.getUTCHours();
  const nightly = d.getUTCDate() === 5 && hour === 2;
  const evening = d.getUTCDate() === 4 && hour === 19;
  return {
    date: iso(ms).slice(0, 10),
    hour,
    observed_minutes: 60,
    utilisation_mean: nightly ? 1 : evening ? 0.9 : 0.55,
    minutes_at_max: nightly ? 60 : evening ? 15 : 0,
    capacity_bound_minutes: nightly ? 52 : evening ? 13 : 0,
  };
});

const hours = <T>(f: (h: number) => T): T[] => Array.from({ length: 24 }, (_, h) => f(h));

export const capacityFixture: Capacity = {
  env_id: 'acme-prod',
  range: { from: iso(FROM), to: iso(NOW) },
  data_as_of: at(5, 11, 59),
  sources: ['DEMO'],
  bucket_seconds: 900,
  slots_source: 'monitoring',
  limits: {
    worker_concurrency: 12,
    worker_concurrency_source: 'configured',
    min_workers: 2,
    max_workers: 6,
    worker_slots_at_max: 72,
    parallelism: 96,
    parallelism_source: 'override',
    schedulers: 2,
    parallelism_total: 192,
  },
  summary: {
    window_minutes: 1440,
    observed_minutes: 1440,
    coverage: 1,
    utilisation: { p50: 0.56, p95: 1, max: 1, samples: 1440, low_sample: false },
    minutes_at_max_workers: 75,
    capacity_bound_minutes: 65,
    capacity_bound_share: 65 / 1440,
    running_peak: 72,
    queued_peak: 70,
    scale_up_lag_seconds: { p50: 120, p95: null, max: 180, samples: 4, low_sample: true },
  },
  series,
  capacity_bound: {
    evaluated: true,
    not_evaluated_reason: null,
    min_queued: 10,
    queued_ratio: 0.2,
    period_count: 2,
    periods: [
      { start: at(4, 19, 0), end: at(4, 19, 13), minutes: 13, queued_peak: 53, workers: 6 },
      { start: at(5, 2, 3), end: at(5, 2, 55), minutes: 52, queued_peak: 70, workers: 6 },
    ],
  },
  scale_events: {
    evaluated: true,
    not_evaluated_reason: null,
    up: 2,
    down: 2,
    items: [
      { at: at(4, 18, 56), from: 3, to: 6 },
      { at: at(4, 19, 20), from: 6, to: 3 },
      { at: at(5, 1, 58), from: 3, to: 6 },
      { at: at(5, 3, 5), from: 6, to: 3 },
    ],
  },
  workloads: [
    {
      workload: 'celery-worker',
      samples: 1440,
      cpu: { p50: 0.41, p95: 0.72, max: 0.9, samples: 1440, low_sample: false },
      memory: { p50: 0.62, p95: 0.78, max: 0.81, samples: 1440, low_sample: false },
    },
  ],
  workloads_not_collected: ['scheduler', 'triggerer', 'dag-processor', 'web-server'],
  heatmap: { time_zone: 'UTC', cells: heatCells },
  pools: [
    {
      name: 'default_pool',
      slots: 128,
      running_slots_avg: 20,
      running_slots_peak: 72,
      queued_slots_avg: 2,
      starved_minutes: 0,
    },
    {
      name: 'acme_etl',
      slots: 24,
      running_slots_avg: 10,
      running_slots_peak: 24,
      queued_slots_avg: 6,
      starved_minutes: 35,
    },
    {
      name: 'acme_partner_api',
      slots: 4,
      running_slots_avg: null,
      running_slots_peak: null,
      queued_slots_avg: null,
      starved_minutes: null,
    },
  ],
  dag_load: {
    method: 'FR-DAGX-06/task-tries',
    time_zone: 'UTC',
    top: 20,
    covered_hours: hours(() => 1),
    total_executor_slot_seconds: 1_800_000,
    dag_count: 120,
    dags: [
      {
        dag_id: 'acme_orders_nightly',
        executor_slot_seconds: 540_000,
        share: 0.3,
        hours: hours((h) => (h === 2 ? 48 : h === 3 ? 12 : 0)),
      },
      {
        dag_id: 'acme_payments_hourly',
        executor_slot_seconds: 270_000,
        share: 0.15,
        hours: hours(() => 3),
      },
      {
        dag_id: 'acme_clickstream_ingest',
        executor_slot_seconds: 180_000,
        share: 0.1,
        hours: hours((h) => (h >= 8 && h < 18 ? 5 : 0)),
      },
    ],
  },
};

/** The same environment while worker_concurrency is not known (HM-032): no slots, no bound minutes. */
export const unknownConcurrency: Capacity = {
  ...capacityFixture,
  limits: {
    ...capacityFixture.limits,
    worker_concurrency: null,
    worker_concurrency_source: 'unknown',
    worker_slots_at_max: null,
    parallelism: null,
    parallelism_source: 'unknown',
    parallelism_total: null,
  },
  summary: {
    ...capacityFixture.summary,
    utilisation: { p50: null, p95: null, max: null, samples: 0, low_sample: true },
    capacity_bound_minutes: null,
    capacity_bound_share: null,
  },
  series: series.map((b) => ({
    ...b,
    worker_slots_mean: null,
    utilisation_mean: null,
    capacity_bound_minutes: null,
  })),
  capacity_bound: {
    ...capacityFixture.capacity_bound,
    evaluated: false,
    not_evaluated_reason:
      'worker_concurrency is not known (no override in the Composer configuration), so DCAM cannot tell when worker slots are full (HM-032).',
    period_count: 0,
    periods: [],
  },
  heatmap: {
    time_zone: 'UTC',
    cells: heatCells.map((c) => ({ ...c, utilisation_mean: null, capacity_bound_minutes: null })),
  },
};

const STEP_MS = 5 * MIN;
const H_FROM = NOW;
const inNightly = (ms: number) => ms >= Date.UTC(2026, 10, 6, 2, 0) && ms < Date.UTC(2026, 10, 6, 2, 46);
const inRisk = (ms: number) => ms >= Date.UTC(2026, 10, 6, 1, 50) && ms < Date.UTC(2026, 10, 6, 3, 0);

export const forecastFixture: Forecast = {
  env_id: 'acme-prod',
  horizon: { from: iso(H_FROM), to: iso(H_FROM + 24 * 60 * MIN) },
  data_as_of: at(5, 11, 59),
  sources: ['DEMO'],
  method: 'HM-010/run-profiles',
  estimate: true,
  evaluated: true,
  not_evaluated_reason: null,
  time_zone: 'UTC',
  step_seconds: 300,
  history: {
    from: at(3, 11, 0),
    to: iso(NOW),
    days: 2.04,
    read_days: 28,
    min_days: 14,
    runs_profiled: 4_829,
  },
  confidence: {
    level: 'low',
    summary:
      'Low confidence: 3 of 3 DAGs have less than 14 days of history (DCAM has 2 days), so the forecast rests on few runs. It firms up as history builds.',
    dags: 3,
    low_confidence_dags: 3,
    dags_without_history: 1,
    low_confidence_share: 1,
  },
  capacity: {
    worker_slots_at_max: 72,
    worker_concurrency_source: 'configured',
    max_workers: 6,
    parallelism_total: 192,
  },
  series: Array.from({ length: 288 }, (_, i) => {
    const ms = H_FROM + i * STEP_MS;
    const nightly = inNightly(ms);
    const risk = inRisk(ms);
    return {
      start: iso(ms),
      p10: nightly ? 90 : 20,
      p50: nightly ? 131.4 : risk ? 60 : 30,
      p90: nightly ? 150 : risk ? 95 : 45,
      baseline: 5,
    };
  }),
  saturation: {
    evaluated: true,
    not_evaluated_reason: null,
    band: 'p50',
    min_minutes: 15,
    windows: [
      {
        start: at(6, 2, 0),
        end: at(6, 2, 46),
        minutes: 46,
        peak_slots: 131.4,
        capacity_slots: 72,
        low_confidence: true,
        top_dags: [
          { dag_id: 'acme_orders_nightly', slot_minutes: 540, share: 0.45, low_confidence: true },
          { dag_id: 'acme_billing_nightly', slot_minutes: 388, share: 0.32, low_confidence: true },
        ],
      },
    ],
  },
  risk: {
    evaluated: true,
    not_evaluated_reason: null,
    band: 'p90',
    min_minutes: 15,
    windows: [
      {
        start: at(6, 1, 50),
        end: at(6, 3, 0),
        minutes: 70,
        peak_slots: 150,
        capacity_slots: 72,
        low_confidence: true,
        top_dags: [{ dag_id: 'acme_orders_nightly', slot_minutes: 700, share: 0.5, low_confidence: true }],
      },
    ],
  },
  planned_runs: 50,
  unscheduled_dags: 2,
  dag_count: 3,
  dags: [
    {
      dag_id: 'acme_orders_nightly',
      schedule: '30 1 * * *',
      planned_runs: 1,
      runs_profiled: 2,
      history_days: 2.0,
      low_confidence: true,
      slot_minutes: 1_200,
      peak_slots: 60,
    },
    {
      dag_id: 'acme_billing_nightly',
      schedule: '0 2 * * *',
      planned_runs: 1,
      runs_profiled: 2,
      history_days: 2.0,
      low_confidence: true,
      slot_minutes: 800,
      peak_slots: 40,
    },
    {
      dag_id: 'acme_new_export',
      schedule: '0 6 * * *',
      planned_runs: 1,
      runs_profiled: 0,
      history_days: null,
      low_confidence: true,
      slot_minutes: null,
      peak_slots: null,
    },
  ],
  baseline: { method: 'hour-of-week', slot_minutes: 7_200, weeks: 0.29 },
  pool_step_seconds: 900,
  pools: [
    {
      name: 'acme_etl',
      slots: 24,
      peak_slots: 30,
      peak_at: at(6, 2, 15),
      minutes_over: 30,
      series: Array.from({ length: 96 }, (_, i) => (i === 57 || i === 58 ? 30 : 10)),
    },
    { name: 'default_pool', slots: 128, peak_slots: null, peak_at: null, minutes_over: null, series: [] },
  ],
};

export const meta: Meta = {
  name: 'DCAM',
  version: '0.0.0-test',
  mode: 'demo',
  environments: [{ env_id: 'acme-prod', display_name: 'acme-prod', tier: 'prod' }],
};

const reject = () => Promise.reject(new Error('not in this test'));

/** A fake API for the capacity page; `calls` records the ranges it was asked for. */
export function capacityApi(
  capacity: Capacity = capacityFixture,
  forecast: Forecast | (() => Promise<Forecast>) = forecastFixture,
): DcamApi & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    getMeta: async () => meta,
    getOverview: reject,
    getDagLeague: reject,
    getDagDetail: reject,
    getDagComparison: reject,
    getRunComparison: reject,
    getBottlenecks: reject,
    getSchedule: reject,
    getFindings: reject,
    getAlerts: reject,
    getFleet: reject,
    getCollection: reject,
    getCapacity: async (_envId, range) => {
      calls.push(range);
      return capacity;
    },
    getForecast: typeof forecast === 'function' ? forecast : async () => forecast,
  };
}
