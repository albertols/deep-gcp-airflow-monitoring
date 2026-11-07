import type { DagDetail, DurationDistribution, DurationRegression, TaskReliability } from '@dcam/contracts';
import { DETAIL, q } from './dag-fixtures';

/** A distribution around a median; below 20 samples p95 is the max (§8.9). */
export const dist = (p50: number, p95: number, samples: number): DurationDistribution => ({
  samples,
  min: p50 * 0.6,
  p25: p50 * 0.85,
  p50,
  p75: p50 * 1.2,
  p95,
  max: p95 * 1.2,
  low_sample: samples < 20,
});

const verdict = (
  status: DurationRegression['status'],
  current: DurationDistribution,
  baseline: DurationDistribution,
  ratio: number | null,
  p: number | null,
): DurationRegression => ({
  status,
  current,
  baseline,
  ratio,
  p_value: p,
  q_value: p === null ? null : p * 2,
});

export const outcomes = (r: Partial<TaskReliability> = {}): TaskReliability => ({
  tries: 24,
  failed_tries: 0,
  try_failure_rate: 0,
  task_instances: 24,
  retried: 0,
  retry_rate: 0,
  flaky: 0,
  flaky_inferred: 0,
  flaky_rate: 0,
  recoveries: 0,
  unrecovered: 0,
  mttr_seconds: null,
  ...r,
});

const [load, extract] = DETAIL.tasks as [DagDetail['tasks'][number], DagDetail['tasks'][number]];
const base = (taskId: string): DagDetail['tasks'][number] => ({
  ...load,
  task_id: taskId,
  duration_p50: q(30, 12),
  duration_p95: q(40, 12, true),
  contribution_seconds: 30,
  slot_seconds_share: 0,
});

/** DETAIL with the feature-006 fields: a regressed task, a flaky one, a low-sample one and one without a baseline. */
export const DEPTH: DagDetail = {
  ...DETAIL,
  gantt: {
    ...DETAIL.gantt,
    critical_path: {
      method: 'timing',
      row_indexes: [0, 1],
      duration_seconds: 1_080,
      waiting_seconds: 180,
      running_seconds: 900,
    },
  },
  baseline: {
    from: '2026-10-07T12:00:00.000Z',
    to: '2026-11-04T12:00:00.000Z',
    history_from: '2026-11-03T11:00:00.000Z',
    coverage: 25 / 672,
    margin: 1.3,
  },
  regression: verdict('regression', dist(1_500, 2_400, 24), dist(1_200, 1_400, 25), 1.71, 0.0004),
  reliability: {
    finished_runs: 24,
    failed_runs: 3,
    run_failure_rate: 0.125,
    run_recoveries: 3,
    run_unrecovered: 0,
    run_mttr_seconds: 3_600,
    tasks: outcomes({
      tries: 72,
      failed_tries: 12,
      try_failure_rate: 12 / 72,
      task_instances: 60,
      retried: 7,
      retry_rate: 7 / 60,
      flaky: 6,
      flaky_inferred: 2,
      flaky_rate: 0.1,
      recoveries: 6,
      unrecovered: 1,
      mttr_seconds: 300,
    }),
  },
  tasks: [
    {
      ...load,
      duration_regression: verdict('regression', dist(1_200, 1_800, 24), dist(600, 900, 25), 2, 0.0001),
      reliability: outcomes(),
      critical_path_runs: 2,
      critical_path_share: 1,
    },
    {
      ...extract,
      duration_regression: verdict('within_baseline', dist(480, 600, 24), dist(470, 590, 25), 1.02, 0.4),
      reliability: outcomes({
        tries: 36,
        failed_tries: 9,
        try_failure_rate: 0.25,
        retried: 7,
        retry_rate: 7 / 24,
        flaky: 6,
        flaky_inferred: 2,
        flaky_rate: 0.25,
        recoveries: 6,
        unrecovered: 1,
        mttr_seconds: 300,
      }),
      critical_path_runs: 1,
      critical_path_share: 0.5,
    },
    {
      ...base('notify'),
      duration_regression: verdict('low_sample', dist(30, 40, 6), dist(30, 35, 25), null, null),
      reliability: outcomes({
        tries: 12,
        failed_tries: 3,
        try_failure_rate: null,
        task_instances: 12,
        retry_rate: null,
        flaky_rate: null,
      }),
      critical_path_runs: 0,
      critical_path_share: 0,
    },
    {
      ...base('cleanup'),
      duration_regression: verdict('no_baseline', dist(20, 30, 24), dist(20, 20, 3), null, null),
      reliability: outcomes(),
      critical_path_runs: 0,
      critical_path_share: 0,
    },
  ],
};
