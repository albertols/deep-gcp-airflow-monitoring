/**
 * HM-006 reasons for the UI: label, fixed chart colour and plain-language text (spec L1036–1084).
 * Colours come from the validated categorical palette (dark steps, checked against the chart surface
 * #111B2B: worst adjacent CVD ΔE 8.4, normal-vision ΔE 19.3, all ≥ 3:1). Colour follows the reason,
 * never its rank; the stack order is the palette order so adjacent segments are validated pairs.
 */
import type { WaitReasonId } from '@dcam/contracts';

export interface ReasonInfo {
  readonly label: string;
  /** Chart series: reasons that share a series are drawn as one (pool configuration errors). */
  readonly series: ChartSeriesKey | null;
  readonly description: string;
  readonly action: string;
}

export type ChartSeriesKey =
  | 'executor-slots-exhausted'
  | 'pool-exhausted'
  | 'autoscaling-lag'
  | 'parallelism'
  | 'dag-max-active-tasks'
  | 'worker-pickup'
  | 'scheduler-throughput'
  | 'pool-config'
  | 'unknown';

/** Stacking and legend order (bottom first) with each series' colour. */
export const CHART_SERIES: ReadonlyArray<{ key: ChartSeriesKey; label: string; color: string }> = [
  { key: 'executor-slots-exhausted', label: 'Executor slots exhausted', color: '#3987e5' },
  { key: 'pool-exhausted', label: 'Pool exhausted', color: '#d95926' },
  { key: 'autoscaling-lag', label: 'Autoscaling lag', color: '#199e70' },
  { key: 'parallelism', label: 'Global parallelism', color: '#c98500' },
  { key: 'dag-max-active-tasks', label: 'DAG max_active_tasks', color: '#d55181' },
  { key: 'worker-pickup', label: 'Worker pickup', color: '#008300' },
  { key: 'scheduler-throughput', label: 'Scheduler throughput', color: '#9085e9' },
  { key: 'pool-config', label: 'Pool misconfigured', color: '#e66767' },
  // Neutral, not a categorical hue: "unknown" carries no identity.
  { key: 'unknown', label: 'Unknown', color: '#7f8ea3' },
];

export const REASONS: Readonly<Record<WaitReasonId, ReasonInfo>> = {
  'dag-max-active-runs': {
    label: 'DAG max_active_runs',
    series: null,
    description: 'A DAG run stayed queued because the DAG already had max_active_runs runs running.',
    action: 'Not collected yet: needs run-level snapshots (arrives with the M1 collectors).',
  },
  'pool-missing': {
    label: 'Pool does not exist',
    series: 'pool-config',
    description: "The task's pool does not exist, so the scheduler can never queue it.",
    action: 'Create the pool, or fix the pool name in the DAG.',
  },
  'task-larger-than-pool': {
    label: 'Task larger than its pool',
    series: 'pool-config',
    description: 'The task needs more slots (pool_slots) than its pool has in total, so it can never run.',
    action: "Lower the task's pool_slots, or raise the pool's size.",
  },
  parallelism: {
    label: 'Global parallelism',
    series: 'parallelism',
    description: 'Running plus queued task instances reached [core] parallelism × schedulers.',
    action: 'Raise core.parallelism if the workers have room (advisor rule REC-CONC-01).',
  },
  'pool-exhausted': {
    label: 'Pool exhausted',
    series: 'pool-exhausted',
    description: "The task's pool had fewer open slots than the task needs (pool_slots).",
    action: 'Raise the pool slots, split the pool, or review pool_slots (REC-CONC-02).',
  },
  'dag-max-active-tasks': {
    label: 'DAG max_active_tasks',
    series: 'dag-max-active-tasks',
    description: "The DAG's running plus queued task instances reached its max_active_tasks.",
    action: "Raise the DAG's max_active_tasks if the environment has headroom (REC-DAG-01).",
  },
  'task-limit': {
    label: 'Task-level limit',
    series: null,
    description: 'A task-level limit (max_active_tis_per_dag or max_active_tis_per_dagrun) bound.',
    action: 'Not collected yet: needs task attributes from the DAG inventory.',
  },
  'scheduler-throughput': {
    label: 'Scheduler throughput',
    series: 'scheduler-throughput',
    description: 'No limit bound, yet the task was not queued within 30 s of becoming ready.',
    action: 'Check the scheduler loop duration and heartbeat; the scheduler may be saturated.',
  },
  'autoscaling-lag': {
    label: 'Autoscaling lag',
    series: 'autoscaling-lag',
    description:
      'Every worker slot was busy, the autoscaler wanted more workers, and the new workers were still starting.',
    action: 'Raise the minimum workers before known peaks, or stagger schedules (REC-CAP-01).',
  },
  'executor-slots-exhausted': {
    label: 'Executor slots exhausted',
    series: 'executor-slots-exhausted',
    description:
      'Every worker slot was busy and the workers were already at max_count, so queued tasks waited for a slot.',
    action: 'Stagger schedules first; otherwise raise max workers or worker_concurrency (REC-CAP-01).',
  },
  'worker-pickup': {
    label: 'Worker pickup',
    series: 'worker-pickup',
    description: 'Worker slots were free, but the task stayed queued for 60 s or more.',
    action: "Check worker health, and that a worker consumes the task's queue.",
  },
  'triggerer-capacity': {
    label: 'Triggerer capacity',
    series: null,
    description: 'A deferred task waited while the triggerer ran at 95 % or more of its capacity.',
    action: 'Not collected yet: needs triggerer metrics from Cloud Monitoring.',
  },
  unknown: {
    label: 'Unknown',
    series: 'unknown',
    description: 'Waiting that matched no reason DCAM could evaluate. DCAM reports it instead of guessing.',
    action: 'Check for collection gaps; the evidence needed to decide was missing.',
  },
  'normal-latency': {
    label: 'Normal latency',
    series: null,
    description:
      'Waits under 30 s before queueing, or under 60 s after queueing with free slots: normal scheduling latency, not a platform limit.',
    action: 'Nothing to do.',
  },
};

export const seriesOf = (reason: WaitReasonId): ChartSeriesKey | null => REASONS[reason].series;
