/**
 * (i) explanations for the bottlenecks page (FR-UI-05, spec §12.9).
 */
import type { Explanation } from '@dcam/ui-kit';

const POOLS_DOC = {
  title: 'Airflow documentation: pools',
  url: 'https://airflow.apache.org/docs/apache-airflow/stable/administration-and-deployment/pools.html',
};
const CONFIG_DOC = {
  title: 'Airflow configuration reference: [core] parallelism and max_active_tasks_per_dag',
  url: 'https://airflow.apache.org/docs/apache-airflow/stable/configurations-ref.html',
};
const SCALING_DOC = {
  title: 'Managed Airflow (Gen 3): optimize environment performance',
  url: 'https://docs.cloud.google.com/composer/docs/composer-3/optimize-environments',
};
const SNAPSHOT_CAVEAT =
  'Airflow 2.11 does not record when a task became ready, so pre-queue reasons come only from DCAM’s live snapshots (every 30 s). History older than DCAM’s collection is not observed.';

export const BOTTLENECK_EXPLANATIONS = {
  'botl-answer': {
    id: 'botl-answer',
    title: 'Main cause of waiting',
    summary: 'The limit that caused the largest share of waiting task-time in the range.',
    whyItMatters: 'Change the setting behind this limit first; other changes will not shorten the wait.',
    formula:
      'share = waiting task-time attributed to the reason ÷ all waiting task-time attributed to platform limits',
    sources: ['SRC-AF-API', 'SRC-MON', 'SRC-COMPOSER'],
    freshness: '≤ 2 × the live snapshot cadence (30 s)',
    caveats: [SNAPSHOT_CAVEAT],
  },
  'botl-waiting-total': {
    id: 'botl-waiting-total',
    title: 'Waiting task-hours',
    summary:
      'Time ready task instances spent not running because a platform limit bound, summed over all of them.',
    formula: 'Σ over snapshots of (waiting task instances × 30 s), excluding normal latency',
    howToRead: 'Ten tasks waiting six minutes each is one task-hour.',
    sources: ['SRC-AF-API'],
    caveats: [
      SNAPSHOT_CAVEAT,
      'Dependency wait (upstream, sensors, depends_on_past) is not a platform limit and is not counted.',
    ],
  },
  'botl-current': {
    id: 'botl-current',
    title: 'Binding now',
    summary: 'The reason most waiting task instances are held by in the latest snapshot.',
    sources: ['SRC-AF-API', 'SRC-MON'],
    freshness: '30 s',
  },
  'botl-at-max': {
    id: 'botl-at-max',
    title: 'Minutes at max workers',
    summary: 'Minutes the environment ran at its maximum number of workers (max_count).',
    whyItMatters: 'At max_count the autoscaler cannot add capacity; queued work waits for a free slot.',
    sources: ['SRC-MON', 'SRC-COMPOSER'],
    docs: [SCALING_DOC],
  },
  'botl-capacity-bound': {
    id: 'botl-capacity-bound',
    title: 'Capacity-bound minutes',
    summary: 'Minutes at max workers with a long queue: the environment was out of worker capacity (HM-011).',
    formula: 'workers = max_count and queued task instances ≥ max(10, 20 % of worker slots)',
    sources: ['SRC-MON', 'SRC-COMPOSER'],
    docs: [SCALING_DOC],
  },
  'botl-scale-lag': {
    id: 'botl-scale-lag',
    title: 'Scale-up lag (p95)',
    summary: 'How long new workers took to arrive after the autoscaler asked for them (HM-012).',
    formula: 'time from the autoscaler target rising above the current workers to the workers reaching it',
    caveats: ['Worker samples are one minute apart, so lags shorter than two minutes are below resolution.'],
    sources: ['SRC-MON'],
    docs: [SCALING_DOC],
  },
  'botl-waiting-chart': {
    id: 'botl-waiting-chart',
    title: 'Waiting by reason over time',
    summary: 'Waiting task-minutes per time bucket, stacked by the limit that held the work.',
    howToRead:
      'Tall bars at the same minute every hour usually mean schedules collide; compare with worker use below.',
    sources: ['SRC-AF-API', 'SRC-MON'],
    caveats: [SNAPSHOT_CAVEAT],
  },
  'botl-utilisation-chart': {
    id: 'botl-utilisation-chart',
    title: 'Worker slots in use',
    summary: 'Running task instances ÷ worker slots (workers × worker_concurrency), averaged per bucket.',
    howToRead: 'Near 100 % with waiting above means worker capacity is the bottleneck.',
    sources: ['SRC-AF-API', 'SRC-MON'],
    docs: [SCALING_DOC],
  },
  'botl-reasons': {
    id: 'botl-reasons',
    title: 'Waiting by reason',
    summary:
      'Every HM-006 reason in the order Airflow’s scheduler checks it, with the DAGs that waited most.',
    formula: 'First matching reason wins; later matches are kept as secondary evidence',
    sources: ['SRC-AF-API', 'SRC-MON', 'SRC-COMPOSER'],
    caveats: [
      'Reasons marked "Not collected yet" need inputs DCAM does not gather in this version; they are never guessed.',
    ],
    docs: [CONFIG_DOC, POOLS_DOC],
  },
  'botl-pools': {
    id: 'botl-pools',
    title: 'Pools',
    summary: 'Waiting caused by each pool, minutes it was starved, and how full it ran.',
    formula: 'starved minutes = time with zero open slots while work waited for the pool',
    sources: ['SRC-AF-API'],
    docs: [POOLS_DOC],
  },
  'botl-sensors': {
    id: 'botl-sensors',
    title: 'Sensors holding worker slots',
    summary: 'Worker slot time used by sensors in poke mode, which occupy a slot while they wait (HM-008).',
    whyItMatters: 'Reschedule mode or deferrable operators free the slot between checks (REC-DAG-05).',
    sources: ['SRC-AF-API'],
    caveats: [
      'Sensors are detected by operator name; custom sensors that do not end in "Sensor" are missed.',
    ],
  },
} as const satisfies Record<string, Explanation>;

export type BottleneckExplanationId = keyof typeof BOTTLENECK_EXPLANATIONS;
export const BOTTLENECK_PANELS = Object.keys(BOTTLENECK_EXPLANATIONS) as BottleneckExplanationId[];
