/**
 * Contract-conforming fixtures for feature 008 (FR-DAGD-05/06/08/09): fictitious `acme-*` environments and
 * DAGs, shaped like the demo server's answers.
 */
import type {
  DagComparison,
  DagConcurrency,
  DagDetail,
  DagImpact,
  DagNoisyNeighbour,
  CompareDag,
  RunComparison,
  TaskInRun,
} from '@dcam/contracts';
import { DETAIL, q } from './dag-fixtures';

export const RUN_1 = 'scheduled__2026-11-05T10:00:00+00:00';
export const RUN_2 = 'scheduled__2026-11-05T11:00:00+00:00';
const BUCKETS = ['2026-11-05T10:00:00.000Z', '2026-11-05T10:15:00.000Z', '2026-11-05T10:30:00.000Z'];

export const CONCURRENCY: DagConcurrency = {
  bucket_seconds: 900,
  max_active_tasks: 4,
  max_active_tasks_is_default: false,
  limit_scope: 'dag',
  snapshots: 60,
  snapshot_interval_seconds: 30,
  peak_running: 4,
  peak_in_flight: 4,
  series: [
    {
      start: BUCKETS[0] ?? '',
      running_avg: 3.5,
      running_max: 4,
      in_flight_max: 4,
      ready_max: 8,
      at_limit_seconds: 660,
    },
    // No snapshot in this bucket: in flight, ready and time at the limit are gaps, not zero.
    {
      start: BUCKETS[1] ?? '',
      running_avg: 2.25,
      running_max: 3,
      in_flight_max: null,
      ready_max: null,
      at_limit_seconds: null,
    },
    {
      start: BUCKETS[2] ?? '',
      running_avg: 0.5,
      running_max: 1,
      in_flight_max: 1,
      ready_max: 0,
      at_limit_seconds: 0,
    },
  ],
  pools: [{ name: 'etl', slots: 24, pool_slots: 2, dag_slots_max: [8, 6, 2], occupied_max: [24, null, 10] }],
  self_throttling: {
    method: 'HM-005/snapshots',
    active_seconds: 1_800,
    at_limit_seconds: 780,
    at_limit_share: 0.43,
    own_waiting_task_seconds: 3_600,
    peak_demand: 12,
    headroom_share: 0.8,
    last_at_limit: '2026-11-05T10:14:30.000Z',
    threshold: 0.1,
    raises_rec_dag_01: true,
    finding_id: 'acme-prod:REC-DAG-01:dag:orders_daily',
  },
};

export const NOT_THROTTLED: DagConcurrency = {
  ...CONCURRENCY,
  max_active_tasks: 16,
  max_active_tasks_is_default: true,
  self_throttling: {
    ...CONCURRENCY.self_throttling,
    at_limit_seconds: 36,
    at_limit_share: 0.02,
    own_waiting_task_seconds: 40,
    headroom_share: null,
    raises_rec_dag_01: false,
    finding_id: null,
  },
};

const MINIMUMS = {
  active_share: 0.1,
  min_active_minutes: 60,
  min_affected_tries: 200,
  min_affected_minutes: 30,
  min_control_tries: 200,
  resamples: 1_000,
};

export const ASSOCIATED: DagNoisyNeighbour = {
  method: 'HM-017/range',
  status: 'associated',
  reason:
    "Other DAGs' tries waited 45 s longer (median) while this DAG held 10 % or more of the executor slots (95 % interval 25 s to 70 s, high confidence).",
  minutes_with_slots: 1_440,
  active_minutes: 176,
  affected_tries: 976,
  affected_minutes: 140,
  control_tries: 2_713,
  ...MINIMUMS,
  slots_source: 'monitoring',
  score: {
    dag_id: 'orders_daily',
    active_minutes: 176,
    affected_tries: 976,
    affected_minutes: 140,
    control_tries: 2_713,
    matched_share: 1,
    median_wait_active_seconds: 50,
    median_wait_inactive_seconds: 5,
    effect_seconds: 45,
    ci_low_seconds: 25,
    ci_high_seconds: 70,
    confidence: 'high',
    associated_wait_task_minutes: 732,
    overlap_windows: [{ from: '2026-11-05T10:00:00.000Z', to: '2026-11-05T10:24:00.000Z' }],
  },
};

export const NOT_EVALUATED: DagNoisyNeighbour = {
  method: 'HM-017/range',
  status: 'not_evaluated',
  reason:
    'DCAM does not know the executor slots in this range (no worker counts), so it cannot tell when this DAG held 10 % of them. Check that Cloud Monitoring is collected on the DCAM health page.',
  minutes_with_slots: 0,
  active_minutes: 0,
  affected_tries: 0,
  affected_minutes: 0,
  control_tries: 0,
  ...MINIMUMS,
  slots_source: null,
  score: null,
};

export const BELOW_MINIMUM: DagNoisyNeighbour = {
  ...NOT_EVALUATED,
  status: 'below_minimum',
  reason:
    'This DAG held 10 % of the executor slots for 42 minutes, short of the 60 needed. Pick a longer range.',
  minutes_with_slots: 1_440,
  active_minutes: 42,
  affected_tries: 310,
  affected_minutes: 25,
  control_tries: 900,
  slots_source: 'hostnames',
};

export const IMPACT: DagImpact = {
  bucket_seconds: 900,
  slots_source: 'monitoring',
  series: [
    {
      start: BUCKETS[0] ?? '',
      dag_slot_seconds: 3_150,
      environment_slot_seconds: 31_500,
      share: 0.1,
      capacity_share: 0.05,
    },
    // Before the history start: a gap, not zero.
    {
      start: BUCKETS[1] ?? '',
      dag_slot_seconds: null,
      environment_slot_seconds: null,
      share: null,
      capacity_share: null,
    },
    {
      start: BUCKETS[2] ?? '',
      dag_slot_seconds: 450,
      environment_slot_seconds: 18_000,
      share: 0.025,
      capacity_share: 0.0069,
    },
  ],
  noisy_neighbour: ASSOCIATED,
};

export const WITH_008: DagDetail = {
  ...DETAIL,
  findings: [
    {
      id: 'acme-prod:REC-DAG-01:dag:orders_daily',
      rule_id: 'REC-DAG-01',
      title: 'DAG throttled by max_active_tasks',
      severity: 'warning',
    },
    {
      id: 'acme-prod:REC-CAP-01:environment:acme-prod',
      rule_id: 'REC-CAP-01',
      title: 'Workers at maximum while tasks are queued',
      severity: 'critical',
    },
  ],
  concurrency: CONCURRENCY,
  impact: IMPACT,
};

/** DAG detail from a server before feature 008: without the optional fields. */
export function olderServer(d: DagDetail, ...fields: ReadonlyArray<'concurrency' | 'impact'>): DagDetail {
  const copy = { ...d };
  for (const f of fields) delete copy[f];
  return copy;
}

const inRun = (p: Partial<TaskInRun>): TaskInRun => ({
  state: 'success',
  map_indexes: 1,
  map_index: -1,
  tries: 1,
  start: '2026-11-05T10:00:00.000Z',
  end: '2026-11-05T10:10:00.000Z',
  duration_seconds: 600,
  queue_wait_seconds: 10,
  on_critical_path: true,
  critical_path_seconds: 610,
  ...p,
});

/** Run 2 against run 1: `load` got much slower on the path, `extract` a little faster, `notify` is off it. */
export const RUN_COMPARISON: RunComparison = {
  env_id: 'acme-prod',
  dag_id: 'orders_daily',
  range: DETAIL.range,
  data_as_of: DETAIL.data_as_of ?? '2026-11-05T12:00:00.000Z',
  sources: ['DEMO'],
  method: 'HM-007/timing',
  ranking: 'critical_path',
  a: {
    run_id: RUN_1,
    state: 'success',
    start: '2026-11-05T10:00:05.000Z',
    end: '2026-11-05T10:20:05.000Z',
    duration_seconds: 1_200,
    tries: 3,
    critical_path_seconds: 1_200,
  },
  b: {
    run_id: RUN_2,
    state: 'success',
    start: '2026-11-05T11:02:00.000Z',
    end: '2026-11-05T11:32:00.000Z',
    duration_seconds: 1_800,
    tries: 3,
    critical_path_seconds: 1_800,
  },
  duration_delta_seconds: 600,
  explained_seconds: 600,
  tasks: [
    {
      task_id: 'load',
      a: inRun({ duration_seconds: 500, queue_wait_seconds: 10, critical_path_seconds: 510 }),
      b: inRun({
        duration_seconds: 1_100,
        queue_wait_seconds: 70,
        critical_path_seconds: 1_170,
        map_indexes: 8,
        map_index: 3,
        tries: 2,
      }),
      duration_delta_seconds: 600,
      queue_wait_delta_seconds: 60,
      contribution_seconds: 660,
      contribution_wait_seconds: 60,
      contribution_running_seconds: 600,
    },
    {
      task_id: 'notify',
      a: inRun({ on_critical_path: false, critical_path_seconds: 0, duration_seconds: 30 }),
      b: inRun({ on_critical_path: false, critical_path_seconds: 0, duration_seconds: 90 }),
      duration_delta_seconds: 60,
      queue_wait_delta_seconds: 0,
      contribution_seconds: 0,
      contribution_wait_seconds: 0,
      contribution_running_seconds: 0,
    },
    {
      task_id: 'cleanup',
      a: inRun({ on_critical_path: false, critical_path_seconds: 0, duration_seconds: 20 }),
      b: null,
      duration_delta_seconds: null,
      queue_wait_delta_seconds: null,
      contribution_seconds: null,
      contribution_wait_seconds: null,
      contribution_running_seconds: null,
    },
    {
      task_id: 'extract',
      a: inRun({ duration_seconds: 680, queue_wait_seconds: 10, critical_path_seconds: 690 }),
      b: inRun({ duration_seconds: 620, queue_wait_seconds: 10, critical_path_seconds: 630 }),
      duration_delta_seconds: -60,
      queue_wait_delta_seconds: 0,
      contribution_seconds: -60,
      contribution_wait_seconds: 0,
      contribution_running_seconds: -60,
    },
  ],
};

/** 24 UTC hours; an hour without history (`null`) has no covered hours. */
const hours = (running: (h: number) => number | null) =>
  Array.from({ length: 24 }, (_, hour) => {
    const r = running(hour);
    return { hour, covered_hours: r === null ? 0 : 1, running_avg: r, share: r === null ? null : r / 40 };
  });

function compareDag(env_id: string, dag_id: string, p: Partial<CompareDag> = {}): CompareDag {
  return {
    env_id,
    dag_id,
    team: 'finance-data',
    schedule: '0 * * * *',
    paused: false,
    max_active_tasks: 16,
    kpis: {
      runs: 24,
      finished_runs: 24,
      success_rate: 0.96,
      tries: 293,
      retries: 5,
      flaky_rate: 0.014,
      flaky_inferred: 0,
      run_duration_p50: q(2_629, 24),
      run_duration_p95: q(3_742, 24),
      queue_wait_p95: q(29, 293),
      peak_concurrency: 10,
    },
    duration: {
      samples: 24,
      min: 1_500,
      p25: 2_300,
      p50: 2_700,
      p75: 3_200,
      p95: 3_700,
      max: 3_900,
      low_sample: false,
    },
    duration_histogram: [0, 2, 10, 12],
    hourly_profile: hours((h) => (h < 6 ? 2 : 1)),
    resources: {
      executor_slot_seconds: 199_800,
      share: 0.054,
      pools: [{ pool: 'default_pool', pool_slot_seconds: 199_800, share: 0.055 }],
    },
    ...p,
  };
}

export const COMPARISON: DagComparison = {
  range: { from: '2026-11-04T12:00:00.000Z', to: '2026-11-05T12:00:00.000Z' },
  data_as_of: '2026-11-05T12:00:00.000Z',
  sources: ['DEMO'],
  time_zone: 'UTC',
  duration_bins_seconds: [600, 1_200, 2_400, 3_000, 4_000],
  environments: [
    {
      env_id: 'acme-prod',
      tier: 'prod',
      airflow_version: '2.11.1',
      history_from: '2026-11-01T00:00:00.000Z',
      coverage: 1,
      executor_slot_seconds: 3_716_912,
      worker_slots: 72,
      worker_concurrency: 12,
      min_workers: 2,
      max_workers: 6,
      parallelism: 192,
      max_active_tasks_per_dag: 16,
      pools: [
        { name: 'default_pool', slots: 128 },
        { name: 'etl', slots: 24 },
      ],
      utilisation: 0.6,
    },
    {
      env_id: 'acme-test',
      tier: 'test',
      airflow_version: '2.11.1',
      history_from: '2026-11-05T00:00:00.000Z',
      coverage: 0.5,
      executor_slot_seconds: 1_079_705,
      worker_slots: null,
      worker_concurrency: null,
      min_workers: 1,
      max_workers: 6,
      parallelism: null,
      max_active_tasks_per_dag: null,
      pools: [{ name: 'default_pool', slots: 128 }],
      utilisation: null,
    },
  ],
  dags: [
    compareDag('acme-prod', 'logistics_export'),
    compareDag('acme-test', 'logistics_export', {
      max_active_tasks: 8,
      kpis: {
        runs: 12,
        finished_runs: 12,
        success_rate: 1,
        tries: 73,
        retries: 1,
        flaky_rate: null,
        flaky_inferred: 0,
        run_duration_p50: q(1_018, 12, true),
        run_duration_p95: q(1_370, 12, true),
        queue_wait_p95: q(10, 73),
        peak_concurrency: 1,
      },
      duration: {
        samples: 12,
        min: 610,
        p25: 800,
        p50: 1_018,
        p75: 1_155,
        p95: 1_370,
        max: 1_866,
        low_sample: true,
      },
      duration_histogram: [6, 6, 0, 0],
      // Half the range has history: the hours DCAM has no history for are gaps.
      hourly_profile: hours((h) => (h < 12 ? null : 0.1)),
      resources: {
        executor_slot_seconds: 10_036,
        share: 0.0093,
        pools: [{ pool: 'etl', pool_slot_seconds: 10_036, share: 0.099 }],
      },
    }),
  ],
};
