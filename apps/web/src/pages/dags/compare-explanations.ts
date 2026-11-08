/**
 * (i) explanations for feature 008 (spec §12.9): the concurrency profile and self-throttling (FR-DAGD-05,
 * HM-005, REC-DAG-01), the impact on the environment and the noisy-neighbour score (FR-DAGD-06, HM-003,
 * HM-017), the DAG's findings, the run comparison (FR-DAGD-09, HM-007) and the compare DAGs page
 * (FR-DAGD-08). Every panel and column has an entry; the UI tests fail if one is missing.
 *
 * @implements FR-UI-05
 */
import type { Explanation } from '@dcam/ui-kit';
import { WIKI_SLUGS, wikiHref } from '../wiki/content/slugs';

const CONFIG_DOC = {
  title: 'Airflow configuration reference',
  url: 'https://airflow.apache.org/docs/apache-airflow/stable/configurations-ref.html',
};
const DAGS_DOC = {
  title: 'Airflow documentation: DAGs',
  url: 'https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/dags.html',
};
const POOLS_DOC = {
  title: 'Airflow documentation: pools',
  url: 'https://airflow.apache.org/docs/apache-airflow/stable/administration-and-deployment/pools.html',
};
const OPTIMIZE_DOC = {
  title: 'Managed Airflow (Gen 3): optimize environment performance',
  url: 'https://docs.cloud.google.com/composer/docs/composer-3/optimize-environments',
};

const API = ['SRC-AF-API'];
const SNAPSHOTS = 'Live snapshots while DCAM runs (every 10 s, 30 s or 120 s, by collection profile)';
const SNAPSHOT_ONLY =
  "Running + queued and ready come from DCAM's own live snapshots: Airflow keeps no history of them, so time before DCAM started, or while it was stopped, is a gap.";
const UTC_HOURS =
  'DCAM collects neither the environments’ display time zones nor the DAGs’ time zones, so every environment is compared in UTC.';

export const COMPARE_EXPLANATIONS = {
  // DAG detail: concurrency (FR-DAGD-05)
  'dagd-concurrency': {
    id: 'dagd-concurrency',
    wiki: { href: wikiHref(WIKI_SLUGS.whyWorkWaits) },
    title: 'Concurrency profile',
    summary:
      "How many of the DAG's task instances ran at once, per time bucket, against its max_active_tasks and its pools (FR-DAGD-05).",
    whyItMatters:
      'A DAG that sits at its own max_active_tasks while its tasks are ready runs slower than the environment allows: the limit, not the workers, holds it back.',
    formula:
      'running: tries of the DAG running at once (mean and peak per bucket, HM-011); running + queued and ready: the peaks in the live snapshots of the bucket',
    howToRead:
      'On Airflow 2, max_active_tasks counts the running and queued task instances of all active runs of the DAG together (HM-005). When "running + queued" touches the dashed limit line while "ready" stays above zero, the limit holds ready work back. Pool charts compare the slots this DAG held with what every DAG occupied.',
    sources: API,
    freshness: SNAPSHOTS,
    caveats: [
      SNAPSHOT_ONLY,
      'Running comes from task tries, so it covers the whole history DCAM has read.',
      'When the DAG does not set max_active_tasks, [core] max_active_tasks_per_dag applies; DCAM says which.',
    ],
    docs: [DAGS_DOC, CONFIG_DOC, POOLS_DOC],
  },
  'dagd-self-throttling': {
    id: 'dagd-self-throttling',
    title: 'Self-throttling',
    summary:
      'Share of the DAG’s active time at its max_active_tasks limit with its own ready task instances waiting (HM-005). At 10 % or more the advisor raises REC-DAG-01.',
    formula:
      'time with running + queued ≥ max_active_tasks and own ready task instances ÷ time with work of the DAG in flight or waiting; each live snapshot stands for the time to the next one, at most two cadences',
    howToRead:
      'Free worker slots at the limit mean the DAG’s own limit held it back, not the environment. The advisor evaluates the last 24 hours; this panel the selected range, so the two can differ.',
    sources: API,
    freshness: SNAPSHOTS,
    caveats: [
      SNAPSHOT_ONLY,
      'Method HM-005/snapshots: the same computation the advisor runs for REC-DAG-01.',
    ],
    docs: [DAGS_DOC, CONFIG_DOC],
  },
  'dagd-concurrency-pools': {
    id: 'dagd-concurrency-pools',
    title: 'Pools of this DAG',
    summary:
      "For each pool the DAG's tasks used: the slots its running tries held (peak per bucket) against the slots every DAG occupied and the pool's size.",
    howToRead:
      'A pool that every DAG fills while this DAG holds little of it limits this DAG from outside; a pool this DAG fills on its own is its own limit.',
    sources: API,
    freshness: SNAPSHOTS,
    caveats: [
      "Occupied slots (running + queued, every DAG) come from live snapshots; this DAG's slots come from its tries, weighted by pool_slots.",
    ],
    docs: [POOLS_DOC],
  },
  // DAG detail: impact (FR-DAGD-06)
  'dagd-impact': {
    id: 'dagd-impact',
    wiki: { href: wikiHref(WIKI_SLUGS.executorSlotSeconds) },
    title: 'Impact on the environment',
    summary:
      "The DAG's share of the environment's load per time bucket: of the executor slot-seconds used (HM-003), and of the executor slots there were (HM-011).",
    whyItMatters:
      'A DAG with a large share at the busy hours decides how long everyone else waits; a large share at quiet hours costs little.',
    formula:
      'share = DAG executor slot-seconds ÷ environment executor slot-seconds; share of slots = DAG executor slot-seconds ÷ (workers × worker_concurrency × time)',
    howToRead:
      'Compare the line with the busy hours on the capacity overview. A gap means DCAM has no history for that bucket, or nothing ran there.',
    sources: ['SRC-AF-API', 'SRC-MON'],
    freshness: '≤ 2 × the task instance cadence (60 s by default)',
    caveats: [
      'Deferred time is excluded: the triggerer, not a worker slot, holds a deferred task.',
      'Without Cloud Monitoring, DCAM counts workers from the hostnames of running tasks: a lower bound, so the share of slots is an estimate and may read high.',
    ],
    docs: [OPTIMIZE_DOC],
  },
  'dagd-noisy-neighbour': {
    id: 'dagd-noisy-neighbour',
    wiki: { href: wikiHref(WIKI_SLUGS.whyWorkWaits) },
    title: 'Noisy-neighbour score',
    summary:
      "Whether other DAGs' tries waited longer in the queue while this DAG held at least 10 % of the executor slots (HM-017), with a 95 % interval and a confidence level. Association, not cause.",
    formula:
      'effect = median queue wait of other DAGs’ tries queued while this DAG was active − weighted median in matched minutes when it ran nothing (same hour of the week); 95 % interval from a minute-block bootstrap',
    howToRead:
      '"High" means the interval stays above zero and almost all tries could be matched; "Low" means no clear association. Without a score the panel says why and which minimum was missed: DCAM never shows a zero it did not measure.',
    sources: ['SRC-AF-API', 'SRC-MON'],
    caveats: [
      'A DAG needs at least 60 active minutes, 200 affected tries in 30 distinct minutes, and 200 comparison tries.',
      'DAGs that share a schedule with the busy minutes can look associated: check the overlap windows before you move or cap one.',
      'DCAM compares within the selected range (the specification uses 28 days); the same numbers appear on the bottlenecks page.',
    ],
  },
  // DAG detail: findings
  'dagd-findings': {
    id: 'dagd-findings',
    title: 'Findings',
    summary:
      "The advisor's open findings for this DAG, its pools and its environment, from the rules evaluated over the last 24 hours.",
    howToRead: 'Open a finding in the advisor for its evidence, the snippet to review and how to verify it.',
    sources: API,
    freshness: 'Rules are evaluated over the last 24 hours, whatever range the page shows.',
  },
  // DAG detail: run comparison (FR-DAGD-09)
  'dagd-run-compare': {
    id: 'dagd-run-compare',
    title: 'Compare runs',
    summary:
      'The run in the Gantt chart (B) against another run of the DAG (A): per task, the change in duration and queue wait, ranked by its contribution to the change in run duration (FR-DAGD-09).',
    whyItMatters:
      'Only a task whose time on the critical path changed made the run longer or shorter; a task that got slower off the path did not.',
    formula:
      'contribution = time on the critical path in B − in A (HM-007, from timing); contributions sum to the run duration difference unless a skipped task ended a run',
    howToRead:
      'Positive contributions made B slower, negative ones faster. The bar splits each contribution into queue wait and running time.',
    sources: API,
    caveats: [
      'The critical path is an estimate from timing: DCAM does not collect the task dependencies yet.',
      'Mapped tasks collapse to their longest map index; retries add their wait and running time.',
      'With a run in progress there is no critical path yet: tasks are ranked by their duration difference instead, and the panel says so.',
    ],
  },
  'dagd-rc-col-task': { id: 'dagd-rc-col-task', title: 'Task', summary: 'The task ID.', sources: API },
  'dagd-rc-col-duration': {
    id: 'dagd-rc-col-duration',
    title: 'Duration A → B',
    summary:
      'Running time of the task in each run, over its tries; for a mapped task, its longest map index.',
    sources: API,
  },
  'dagd-rc-col-queue': {
    id: 'dagd-rc-col-queue',
    title: 'Queue wait A → B',
    summary: 'Time the task waited in the queue for a worker in each run (HM-001), over its tries.',
    sources: API,
  },
  'dagd-rc-col-contribution': {
    id: 'dagd-rc-col-contribution',
    title: 'Contribution',
    summary:
      'How much the task’s time on the critical path changed from A to B: its share of the change in run duration.',
    sources: API,
    caveats: ['An estimate from timing (HM-007/timing).'],
  },
  'dagd-rc-col-path': {
    id: 'dagd-rc-col-path',
    title: 'Critical path A / B',
    summary: 'Whether the task was on the critical path of each run.',
    sources: API,
  },
  // Compare DAGs page (FR-DAGD-08)
  'cmp-selection': {
    id: 'cmp-selection',
    title: 'DAGs compared',
    summary: '2 to 4 DAGs from the same or different environments, over the range of the context bar.',
    howToRead:
      'The letters and line styles A to D stay with each DAG in every chart and table. The list is in the link, so you can share the comparison.',
    sources: API,
  },
  'cmp-kpis': {
    id: 'cmp-kpis',
    title: 'Aligned KPIs',
    summary: "The league table's statistics of each DAG over the range, one column per DAG.",
    sources: API,
    caveats: [
      'With fewer than 20 samples a p95 is not reliable: DCAM shows the maximum instead, marked "≤" (spec §8.9).',
    ],
  },
  'cmp-durations': {
    id: 'cmp-durations',
    title: 'Duration distributions',
    summary:
      "Each DAG's successful run durations over the same log-spaced bins, as the share of its runs in each bin.",
    howToRead:
      'Shares, not counts, so a DAG with many runs does not hide one with few. The table has the counts.',
    sources: API,
    caveats: ['Only successful runs count: a failed run ends early.'],
  },
  'cmp-hourly': {
    id: 'cmp-hourly',
    title: 'Hourly load profile',
    summary:
      'Mean task instances of each DAG running at once, per hour of the day in UTC, over the hours DCAM has history for.',
    howToRead:
      'Peaks at the same hour compete for the same worker slots when the DAGs share an environment. The table also has each hour’s share of the environment’s load.',
    sources: API,
    caveats: [UTC_HOURS],
  },
  'cmp-resources': {
    id: 'cmp-resources',
    title: 'Resource shares',
    summary:
      "Each DAG's executor slot-hours and pool slot-hours in the range, and their share of its own environment's totals (HM-003).",
    sources: API,
    caveats: ['Shares are of each DAG’s own environment, so they compare across environments of any size.'],
    docs: [POOLS_DOC],
  },
  'cmp-capacity': {
    id: 'cmp-capacity',
    title: 'Capacity context',
    summary:
      'For each environment of the DAGs compared: its workers, slots, parallelism, default max_active_tasks_per_dag, pools and how much of its maximum worker slots it used.',
    whyItMatters:
      'The same DAG behaves differently in a small test environment and a large production one; compare the DAGs with their capacity in mind.',
    formula: 'utilisation = executor slot-seconds ÷ (maximum workers × worker_concurrency × covered time)',
    sources: ['SRC-AF-API', 'SRC-COMPOSER', 'SRC-MON'],
    caveats: [
      'Workers autoscale, so utilisation of the maximum is a lower bound of the use of the slots that were up.',
      '"Not known yet" means DCAM found no value in the configuration and does not assume a default (HM-032).',
    ],
    docs: [OPTIMIZE_DOC],
  },
} as const satisfies Record<string, Explanation>;

export type CompareExplanationId = keyof typeof COMPARE_EXPLANATIONS;

/** Every panel and column feature 008 adds to the DAG detail page. */
export const DAG_DETAIL_008_PANELS: readonly CompareExplanationId[] = [
  'dagd-concurrency',
  'dagd-self-throttling',
  'dagd-concurrency-pools',
  'dagd-impact',
  'dagd-noisy-neighbour',
  'dagd-findings',
  'dagd-run-compare',
  'dagd-rc-col-task',
  'dagd-rc-col-duration',
  'dagd-rc-col-queue',
  'dagd-rc-col-contribution',
  'dagd-rc-col-path',
];

/** Every panel on the compare DAGs page. */
export const COMPARE_PAGE_PANELS: readonly CompareExplanationId[] = [
  'cmp-selection',
  'cmp-kpis',
  'cmp-durations',
  'cmp-hourly',
  'cmp-resources',
  'cmp-capacity',
];
