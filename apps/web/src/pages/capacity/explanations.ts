/**
 * (i) explanations for the capacity page (S-04) and its forecast tab (FR-UI-05). Facts come from the spec (HM-010,
 * HM-011, HM-012, HM-032) and the Airflow configuration reference cited in `docs`.
 *
 * @implements FR-UI-05
 */
import type { Explanation } from '@dcam/ui-kit';
import { WIKI_SLUGS, wikiHref } from '../wiki/content/slugs';

const SCALING_DOC = {
  title: 'Managed Airflow (Gen 3): optimize environment performance',
  url: 'https://docs.cloud.google.com/composer/docs/composer-3/optimize-environments',
};
const CONFIG_DOC = {
  title: 'Airflow configuration reference: [core] parallelism and [celery] worker_concurrency',
  url: 'https://airflow.apache.org/docs/apache-airflow/stable/configurations-ref.html',
};
const POOLS_DOC = {
  title: 'Airflow documentation: pools',
  url: 'https://airflow.apache.org/docs/apache-airflow/stable/administration-and-deployment/pools.html',
};
const VIRIDIS_DOC = {
  title: 'The viridis colour map: readable with colour-vision deficiency',
  url: 'https://bids.github.io/colormap/',
};
const CAPACITY_WIKI = { href: wikiHref(WIKI_SLUGS.workerCapacity) };
const BOUND_FORMULA = 'workers = max_count and queued task instances ≥ max(10, 20 % of worker slots)';
const GAPS = 'Buckets without worker figures are gaps, never zero.';
const UTC_CAVEAT =
  'Hours are UTC whatever the time zone toggle says, as DCAM does not collect DAG time zones.';
const ESTIMATE = 'A forecast: every number is an estimate (HM-010/run-profiles).';

export const CAPACITY_EXPLANATIONS = {
  'cap-answer': {
    id: 'cap-answer',
    wiki: CAPACITY_WIKI,
    title: 'Capacity-bound answer',
    summary:
      'Whether the environment ran out of worker capacity in the range: workers at max_count while work queued.',
    formula: BOUND_FORMULA,
    sources: ['SRC-MON', 'SRC-COMPOSER', 'SRC-AF-API'],
    docs: [SCALING_DOC],
  },
  'cap-bound-minutes': {
    id: 'cap-bound-minutes',
    wiki: CAPACITY_WIKI,
    title: 'Capacity-bound minutes',
    summary: 'Minutes at max workers with a long queue: the environment was out of worker capacity (HM-011).',
    formula: BOUND_FORMULA,
    howToRead:
      'The share is of the observed minutes: minutes without worker figures do not count either way.',
    sources: ['SRC-MON', 'SRC-COMPOSER'],
    caveats: ['Needs worker_concurrency: without it DCAM cannot tell when worker slots are full (HM-032).'],
    docs: [SCALING_DOC],
  },
  'cap-at-max': {
    id: 'cap-at-max',
    wiki: CAPACITY_WIKI,
    title: 'Minutes at max workers',
    summary: 'Observed minutes with the environment at its maximum number of workers (max_count).',
    whyItMatters: 'At max_count the autoscaler cannot add capacity; queued work waits for a free slot.',
    sources: ['SRC-MON', 'SRC-COMPOSER'],
    docs: [SCALING_DOC],
  },
  'cap-utilisation': {
    id: 'cap-utilisation',
    wiki: CAPACITY_WIKI,
    title: 'Worker slot utilisation (p95)',
    summary:
      'Running task instances ÷ worker slots, per observed minute; the 95th percentile over the range.',
    formula: 'utilisation = running ÷ (workers × worker_concurrency)',
    howToRead: 'With fewer than 20 minutes it shows the maximum and says "low sample" (spec §8.9).',
    sources: ['SRC-MON', 'SRC-AF-API'],
    docs: [CONFIG_DOC],
  },
  'cap-queued-peak': {
    id: 'cap-queued-peak',
    wiki: CAPACITY_WIKI,
    title: 'Peak queued',
    summary: 'The most task instances queued for the executor in one minute of the range.',
    sources: ['SRC-MON', 'SRC-AF-API'],
  },
  'cap-slots': {
    id: 'cap-slots',
    wiki: CAPACITY_WIKI,
    title: 'Worker slots and use',
    summary:
      'Worker slots (workers × worker_concurrency) against the task instances running in them and queued for them, per bucket.',
    howToRead:
      'Hatched bands are capacity-bound buckets. Queued bars above the slots line mean work waited for a worker. Running tries from task history cross-check the executor figures.',
    sources: ['SRC-MON', 'SRC-AF-API', 'SRC-COMPOSER'],
    caveats: [
      GAPS,
      'Workers come from Cloud Monitoring samples, else from the last live snapshot in the minute.',
    ],
    docs: [SCALING_DOC, CONFIG_DOC],
  },
  'cap-periods': {
    id: 'cap-periods',
    wiki: CAPACITY_WIKI,
    title: 'Capacity-bound periods',
    summary: 'Stretches of consecutive capacity-bound minutes, newest first, with the queue they built.',
    formula: BOUND_FORMULA,
    whyItMatters:
      'Each stretch is time the environment could not start more work. Open the bottlenecks page for the same window to see which DAGs waited.',
    sources: ['SRC-MON', 'SRC-COMPOSER'],
    docs: [SCALING_DOC],
  },
  'cap-workers': {
    id: 'cap-workers',
    wiki: { href: wikiHref(WIKI_SLUGS.rb14) },
    title: 'Workers and scale events',
    summary:
      'Workers per bucket against min_count and max_count, the autoscaler target, and each change in the worker count (HM-012).',
    formula:
      'scale-up lag = time from the autoscaler target rising above the workers to the workers reaching it',
    sources: ['SRC-MON', 'SRC-COMPOSER'],
    caveats: [
      'Scale events need Cloud Monitoring worker counts; counts from hostnames are lower bounds.',
      'Worker samples are one minute apart, so lags shorter than two minutes are below resolution.',
    ],
    docs: [SCALING_DOC],
  },
  'cap-limits': {
    id: 'cap-limits',
    wiki: { href: wikiHref(WIKI_SLUGS.concurrencyStack) },
    title: 'Limits and their sources',
    summary:
      'The limits that cap how much runs at once, each with where DCAM read it. Unknown limits show no value.',
    howToRead:
      'Override: an Airflow configuration override in the environment. Composer default and Airflow default: not overridden. Unknown: DCAM could not read it.',
    sources: ['SRC-COMPOSER'],
    caveats: ['A value DCAM inferred is never shown as a configured one (HM-032).'],
    docs: [CONFIG_DOC, SCALING_DOC],
  },
  'cap-workloads': {
    id: 'cap-workloads',
    wiki: CAPACITY_WIKI,
    title: 'Worker CPU and memory',
    summary: 'CPU and memory usage ÷ limit of the Celery workers, per one-minute sample.',
    howToRead:
      'High memory with high utilisation suggests fewer tasks per worker; low CPU with full slots suggests more.',
    sources: ['SRC-MON'],
    caveats: [
      'DCAM collects the worker workload only; the other workload types are listed as not collected.',
    ],
    docs: [SCALING_DOC],
  },
  'cap-pools': {
    id: 'cap-pools',
    wiki: { href: wikiHref(WIKI_SLUGS.pools) },
    title: 'Pool slots',
    summary: 'Each pool’s slots against the slots its task instances ran and queued in, from live snapshots.',
    formula: 'starved minutes = minutes with zero open slots while ready work waited',
    sources: ['SRC-AF-API'],
    caveats: ['Pools without snapshots in the range show no data, not zero.'],
    docs: [POOLS_DOC],
  },
  'cap-saturation': {
    id: 'cap-saturation',
    wiki: CAPACITY_WIKI,
    title: 'Saturation heatmap',
    summary:
      'Each UTC hour of each day, coloured by utilisation, minutes at max workers or capacity-bound minutes.',
    howToRead:
      'Outlined cells had capacity-bound minutes. Empty dashed cells were not observed: no data, not zero. Select a cell for its figures.',
    sources: ['SRC-MON', 'SRC-COMPOSER'],
    caveats: [UTC_CAVEAT],
    docs: [VIRIDIS_DOC],
  },
  'cap-dag-load': {
    id: 'cap-dag-load',
    wiki: { href: wikiHref(WIKI_SLUGS.executorSlotSeconds) },
    title: 'Load by DAG and hour of day',
    summary:
      'The mean worker slots each of the top DAGs held in each UTC hour of the day, over the hours of task history in the range (FR-DAGX-06).',
    formula: 'mean slots = executor slot-seconds in that hour of the day ÷ seconds of history in it',
    howToRead:
      'A bright cell is a DAG that fills many slots at that hour. DAGs that peak together compete for workers.',
    sources: ['SRC-AF-API'],
    caveats: [
      UTC_CAVEAT,
      'Computed from task tries until 5-minute rollups exist; hours without history are empty, not zero.',
    ],
    docs: [VIRIDIS_DOC],
  },
} as const satisfies Record<string, Explanation>;

export const FORECAST_EXPLANATIONS = {
  'fc-confidence': {
    id: 'fc-confidence',
    title: 'Forecast confidence',
    summary:
      'How far the forecast can be trusted: a DAG needs at least 14 days of history for normal confidence (HM-010).',
    howToRead:
      'Low confidence: at least half of the forecast run demand comes from DAGs with less history. Use it as a hint, not a plan.',
    sources: ['SRC-AF-API'],
    caveats: [ESTIMATE],
  },
  'fc-windows-kpi': {
    id: 'fc-windows-kpi',
    title: 'Predicted saturation windows',
    summary:
      'Stretches of at least 15 minutes in which the central forecast (p50) exceeds the worker slots at max_count.',
    sources: ['SRC-AF-API', 'SRC-COMPOSER'],
    caveats: [ESTIMATE],
  },
  'fc-peak': {
    id: 'fc-peak',
    title: 'Peak forecast demand',
    summary: 'The highest central forecast (p50) of running plus queued task instances in one 5-minute step.',
    sources: ['SRC-AF-API'],
    caveats: [ESTIMATE],
  },
  'fc-planned': {
    id: 'fc-planned',
    title: 'Planned runs',
    summary: 'Cron runs of unpaused DAGs in the next 24 hours, in UTC.',
    sources: ['SRC-AF-API'],
    caveats: ['Timedelta, asset and manual schedules are not expanded: their demand is in the baseline.'],
  },
  'fc-history': {
    id: 'fc-history',
    title: 'History used',
    summary:
      'The task history behind the forecast: days read, from when, and the finished scheduled runs profiled.',
    sources: ['SRC-AF-API'],
  },
  'fc-demand': {
    id: 'fc-demand',
    title: 'Forecast slot demand',
    summary:
      'Expected running plus queued task instances per 5-minute step for the next 24 hours: p50 line, p10 to p90 band, the baseline part, against the worker slots at max_count.',
    formula:
      'demand = Σ planned runs × their DAG’s run profile (p10, p50, p90) + hour-of-week baseline for unscheduled work',
    howToRead:
      'Shaded steps are predicted saturation windows (p50 above capacity); hatched steps are risk windows (p90 above capacity).',
    sources: ['SRC-AF-API', 'SRC-COMPOSER'],
    caveats: [
      ESTIMATE,
      'Summing per-DAG percentiles assumes the DAGs move together, so the band is wide.',
      'The maintenance window is not drawn: DCAM does not collect it yet.',
    ],
  },
  'fc-windows': {
    id: 'fc-windows',
    title: 'Saturation and risk windows',
    summary:
      'When the forecast exceeds the worker slots at max_count for at least 15 minutes, and the DAGs that add most demand then.',
    sources: ['SRC-AF-API', 'SRC-COMPOSER'],
    caveats: [ESTIMATE],
    docs: [SCALING_DOC],
  },
  'fc-dags': {
    id: 'fc-dags',
    title: 'DAGs in the forecast',
    summary: 'The DAGs whose planned runs add most demand, with their history and confidence.',
    howToRead: 'A DAG without a profiled run has unknown demand, shown as unknown and not zero.',
    sources: ['SRC-AF-API'],
    caveats: [ESTIMATE],
  },
  'fc-pools': {
    id: 'fc-pools',
    title: 'Pool demand forecast',
    summary: 'Pool-slot demand of the scheduled runs (p50) against each pool’s size.',
    sources: ['SRC-AF-API'],
    caveats: [ESTIMATE, 'The baseline is not split by pool.'],
    docs: [POOLS_DOC],
  },
} as const satisfies Record<string, Explanation>;

export type CapacityExplanationId = keyof typeof CAPACITY_EXPLANATIONS;
export type ForecastExplanationId = keyof typeof FORECAST_EXPLANATIONS;
/** Every panel and KPI of the capacity and load-by-DAG tabs. */
export const CAPACITY_PANELS = Object.keys(CAPACITY_EXPLANATIONS) as CapacityExplanationId[];
/** Every panel and KPI of the forecast tab. */
export const FORECAST_PANELS = Object.keys(FORECAST_EXPLANATIONS) as ForecastExplanationId[];
