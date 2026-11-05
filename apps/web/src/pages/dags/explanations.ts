/**
 * (i) explanations for the DAG league table and DAG detail pages (spec §12.9). Every KPI, panel and
 * column header on these pages has an entry; the UI tests fail if one is missing.
 *
 * @implements FR-UI-05
 */
import type { Explanation } from '@dcam/ui-kit';

const POOLS_DOC = {
  title: 'Airflow documentation: pools',
  url: 'https://airflow.apache.org/docs/apache-airflow/stable/administration-and-deployment/pools.html',
};
const CONFIG_DOC = {
  title: 'Airflow configuration reference',
  url: 'https://airflow.apache.org/docs/apache-airflow/stable/configurations-ref.html',
};
const DAG_RUN_DOC = {
  title: 'Airflow documentation: DAG runs',
  url: 'https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/dag-run.html',
};
const TASKS_DOC = {
  title: 'Airflow documentation: tasks and task instances',
  url: 'https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/tasks.html',
};
const OPTIMIZE_DOC = {
  title: 'Managed Airflow (Gen 3): optimize environment performance',
  url: 'https://docs.cloud.google.com/composer/docs/composer-3/optimize-environments',
};

const API = ['SRC-AF-API'];
const TASK_CADENCE = '≤ 2 × the task instance cadence (60 s by default)';
const LOW_SAMPLE =
  'With fewer than 20 samples a p95 is not reliable: DCAM shows the maximum instead, marked "≤" (spec §8.9).';
const WINDOW_RULE =
  'A try counts in the range it started in; so do its run and task instance. Runs that began before the range are measured whole.';

export const DAG_EXPLANATIONS = {
  // League table: KPIs
  'dagx-pareto': {
    id: 'dagx-pareto',
    title: 'DAGs using 80 % of slot-hours',
    summary:
      'The smallest number of DAGs whose combined executor slot-hours reach 80 % of the environment total.',
    whyItMatters: 'A small number means a few DAGs drive most of the load: tune them first.',
    formula: 'rank DAGs by slot-seconds; count until the running sum ≥ 80 % of the total',
    howToRead: 'Compare it with the number of DAGs. 23 of 1,240 is a strong concentration.',
    sources: API,
    freshness: TASK_CADENCE,
  },
  'dagx-gini': {
    id: 'dagx-gini',
    title: 'Gini coefficient',
    summary: 'How unevenly slot-seconds are spread across the DAGs that ran in the range.',
    formula: 'G = 2 Σ i·xᵢ ÷ (n Σ xᵢ) − (n + 1) ÷ n, with xᵢ sorted ascending over active DAGs',
    howToRead: '0 means every active DAG uses the same; values near 1 mean one DAG uses almost everything.',
    sources: API,
    caveats: ['Only DAGs with slot-seconds in the range count; idle DAGs are left out.'],
  },
  'dagx-active-dags': {
    id: 'dagx-active-dags',
    title: 'Active DAGs',
    summary:
      'DAGs that held at least one executor slot in the range, out of every DAG known in the environment.',
    howToRead: 'Paused DAGs and DAGs without a run in the range are listed in the table with zero values.',
    sources: API,
  },
  'dagx-total-slot-hours': {
    id: 'dagx-total-slot-hours',
    title: 'Total slot-hours',
    summary: 'Time task instance tries held a worker slot in the range, summed over every DAG, in hours.',
    formula: 'Σ (end − start) over tries, clipped to the range; running tries end at "now"',
    sources: API,
    freshness: TASK_CADENCE,
    caveats: ['Deferred time is excluded: the triggerer, not a worker slot, holds a deferred task.'],
    docs: [POOLS_DOC],
  },
  // League table: panels
  'dagx-league': {
    id: 'dagx-league',
    title: 'DAG league table',
    summary:
      'Every DAG ranked by its share of executor slot-seconds in the range, with runs, reliability and queueing.',
    whyItMatters: 'It shows which DAGs consume worker capacity, so you change the few that matter.',
    howToRead:
      'Sorted by share by default; click a column header to sort, and a DAG to open it. Presets narrow the list.',
    sources: API,
    freshness: TASK_CADENCE,
    caveats: [WINDOW_RULE],
  },
  'dagx-presets': {
    id: 'dagx-presets',
    title: 'Presets',
    summary: 'Saved filters for common questions.',
    howToRead:
      'Capacity hogs: the DAGs that together reach 80 % of slot-seconds. Flaky: a flaky rate of 5 % or more over at least 20 task instances. Late starters: a p95 queue wait of 5 min or more from at least 20 tries.',
    sources: API,
    caveats: ['The thresholds are DCAM defaults; the specification leaves them open.'],
  },
  'dagx-treemap': {
    id: 'dagx-treemap',
    title: 'Capacity by team and DAG',
    summary: 'A treemap: each team is a block sized by its slot-seconds, split into its DAGs.',
    howToRead:
      'Bigger tiles use more worker capacity. Colour shows the p95 queue wait. Click a team to filter to it, or a DAG to open it.',
    sources: API,
    caveats: [
      'Only the largest DAGs get their own tile; smaller DAGs of a team are folded into one grey tile.',
      'Colour bands are DCAM defaults: under 1 min, 1 to 5 min, 5 min or more.',
    ],
  },
  // League table: columns
  'dagx-col-dag': {
    id: 'dagx-col-dag',
    title: 'DAG',
    summary: 'The DAG ID. Open it for runs, a Gantt chart of one run, and per-task statistics.',
    sources: API,
  },
  'dagx-col-team': {
    id: 'dagx-col-team',
    title: 'Team',
    summary: 'The team that owns the DAG, from the team-mapping rules.',
    sources: API,
  },
  'dagx-col-runs': {
    id: 'dagx-col-runs',
    title: 'Runs',
    summary: 'DAG runs with at least one task try starting in the range.',
    sources: API,
    caveats: [WINDOW_RULE],
    docs: [DAG_RUN_DOC],
  },
  'dagx-col-success': {
    id: 'dagx-col-success',
    title: 'Success',
    summary: 'Successful runs ÷ finished runs. A run failed when the latest try of one of its tasks failed.',
    formula: '(finished − failed) ÷ finished',
    sources: API,
    caveats: [
      'Running runs are left out. "—" means no run finished in the range.',
      'Until DCAM reads DAG run states directly (M1), a run whose retry has not started yet shows as failed.',
    ],
  },
  'dagx-col-duration': {
    id: 'dagx-col-duration',
    title: 'p95 duration',
    summary: '95th percentile of run duration: last task end − first task start, over finished runs.',
    sources: API,
    caveats: [LOW_SAMPLE],
  },
  'dagx-col-slot-hours': {
    id: 'dagx-col-slot-hours',
    title: 'Slot-hours',
    summary: "Executor slot-hours: time the DAG's tries held a worker slot in the range (HM-003).",
    formula: "Σ (end − start) ÷ 3,600 over the DAG's tries, clipped to the range",
    sources: API,
    freshness: TASK_CADENCE,
    caveats: ['One slot per running try, whatever its pool_slots.'],
  },
  'dagx-col-share': {
    id: 'dagx-col-share',
    title: 'Share',
    summary:
      "The DAG's share of the environment's executor slot-seconds, and the change against the previous period.",
    formula: 'slot-seconds of the DAG ÷ slot-seconds of every DAG',
    howToRead:
      'The change is in percentage points against the previous period of equal length; "new" means the DAG did not run then.',
    sources: API,
  },
  'dagx-col-queue': {
    id: 'dagx-col-queue',
    title: 'p95 queue wait',
    summary: 'How long tries waited in the executor queue before they started (HM-001), 95th percentile.',
    formula: 'start_date − queued_dttm per try',
    sources: API,
    caveats: [
      'Waiting before the queue (pools, DAG limits, parallelism) is not included; the Bottlenecks page explains it.',
      LOW_SAMPLE,
    ],
    docs: [OPTIMIZE_DOC],
  },
  'dagx-col-peak': {
    id: 'dagx-col-peak',
    title: 'Peak concurrency',
    summary: 'The most tries of this DAG running at the same time in the range.',
    howToRead: "Compare it with the DAG's max_active_tasks and with the environment's worker slots.",
    sources: API,
  },
  'dagx-col-findings': {
    id: 'dagx-col-findings',
    title: 'Findings',
    summary: 'Open advisor findings about this DAG.',
    sources: API,
    caveats: ['The advisor arrives in a later slice; until then this column is 0.'],
  },
  // DAG detail: header and KPIs
  'dagd-limits': {
    id: 'dagd-limits',
    title: 'Settings and limits',
    summary: 'Where the DAG lives, when it runs, and every limit that can hold back its tasks (FR-DAGD-01).',
    howToRead:
      "max_active_tasks and max_active_runs are the DAG's own limits. Pools are shared with other DAGs. Parallelism and worker slots are ceilings for the whole environment.",
    sources: ['SRC-AF-API', 'SRC-COMPOSER'],
    caveats: [
      'On Airflow 2, max_active_tasks counts running and queued task instances across all active runs of the DAG.',
      'Parallelism applies per scheduler, so the environment ceiling is parallelism × schedulers.',
    ],
    docs: [CONFIG_DOC, POOLS_DOC],
  },
  'dagd-share': {
    id: 'dagd-share',
    title: 'Share of slot-hours',
    summary: "This DAG's share of the environment's executor slot-seconds in the range.",
    sources: API,
  },
  'dagd-runs': {
    id: 'dagd-runs',
    title: 'Runs',
    summary: 'DAG runs with at least one task try starting in the range.',
    sources: API,
    caveats: [WINDOW_RULE],
  },
  'dagd-success': {
    id: 'dagd-success',
    title: 'Success rate',
    summary: 'Successful runs ÷ finished runs in the range.',
    sources: API,
  },
  'dagd-duration': {
    id: 'dagd-duration',
    title: 'p95 run duration',
    summary: '95th percentile of last task end − first task start over finished runs.',
    sources: API,
    caveats: [LOW_SAMPLE],
  },
  'dagd-queue': {
    id: 'dagd-queue',
    title: 'p95 queue wait',
    summary: "95th percentile of start − queued over the DAG's tries in the range (HM-001).",
    sources: API,
    caveats: [LOW_SAMPLE],
  },
  'dagd-self-throttled': {
    id: 'dagd-self-throttled',
    title: 'Self-throttled',
    summary:
      "Share of the DAG's active minutes in which its own max_active_tasks held back ready work (HM-005).",
    formula:
      'minutes with running + queued ≥ max_active_tasks and work waiting ÷ minutes with work in flight or waiting',
    howToRead:
      'Above 10 % the DAG is often its own bottleneck: raising max_active_tasks may shorten its runs.',
    sources: API,
    freshness: 'Live snapshots every 30 s while DCAM runs',
    caveats: [
      "Measured only from DCAM's own live snapshots; history before DCAM started is not covered.",
      '"—" means DCAM saw no work of this DAG in the range.',
    ],
  },
  // DAG detail: panels
  'dagd-runs-timeline': {
    id: 'dagd-runs-timeline',
    title: 'Runs timeline',
    summary:
      'Each run as a bar at its start time; the height is its duration, the colour and mark its state.',
    howToRead: 'Click a bar to show that run in the Gantt chart. Running runs have no final duration yet.',
    sources: API,
    caveats: [
      'Start delay is the first task start − the logical date read from the run ID. For interval schedules the logical date is the start of the data interval, so the delay includes the interval.',
    ],
    docs: [DAG_RUN_DOC],
  },
  'dagd-gantt': {
    id: 'dagd-gantt',
    title: 'Run Gantt',
    summary: 'Every try of one run: waiting for a slot before the queue, waiting in the queue, then running.',
    howToRead:
      'Hatched: ready but not yet queued (pools, DAG limits, parallelism). Dotted: queued, waiting for a worker. Solid: running.',
    sources: API,
    caveats: [
      "Ready times come from DCAM's live snapshots; Airflow 2 does not record them, so older tries show no pre-queue wait.",
    ],
    docs: [TASKS_DOC],
  },
  'dagd-tasks': {
    id: 'dagd-tasks',
    title: 'Tasks',
    summary: "Per task: durations, queue wait, retries, failure rate and its share of the DAG's slot-hours.",
    howToRead: 'Sorted by mean running time per run: the tasks that make runs long come first.',
    sources: API,
    caveats: [LOW_SAMPLE, 'Mapped task instances are combined per task.'],
  },
  // DAG detail: task columns
  'dagd-col-task': { id: 'dagd-col-task', title: 'Task', summary: 'The task ID.', sources: API },
  'dagd-col-tries': {
    id: 'dagd-col-tries',
    title: 'Tries',
    summary: 'Tries of this task starting in the range, retries included.',
    sources: API,
  },
  'dagd-col-p50': {
    id: 'dagd-col-p50',
    title: 'p50 duration',
    summary: 'Median running time of finished tries.',
    sources: API,
  },
  'dagd-col-p95': {
    id: 'dagd-col-p95',
    title: 'p95 duration',
    summary: '95th percentile running time of finished tries.',
    sources: API,
    caveats: [LOW_SAMPLE],
  },
  'dagd-col-queue': {
    id: 'dagd-col-queue',
    title: 'p95 queue wait',
    summary: '95th percentile of start − queued per try.',
    sources: API,
    caveats: [LOW_SAMPLE],
  },
  'dagd-col-retries': {
    id: 'dagd-col-retries',
    title: 'Retries',
    summary: 'Tries with a try number above 1.',
    sources: API,
  },
  'dagd-col-failure': {
    id: 'dagd-col-failure',
    title: 'Failure rate',
    summary: 'Failed tries ÷ tries (HM-015).',
    sources: API,
    caveats: ['Shown from 20 tries; "—" below that.'],
  },
  'dagd-col-share': {
    id: 'dagd-col-share',
    title: 'Share of DAG',
    summary: "This task's share of the DAG's executor slot-seconds in the range.",
    sources: API,
  },
  'dagd-col-contribution': {
    id: 'dagd-col-contribution',
    title: 'Per run',
    summary:
      'Mean running time of this task per run of the DAG: its contribution to run duration (FR-DAGD-04).',
    formula: "Σ running time of the task's tries in the range's runs ÷ runs",
    sources: API,
  },
} as const satisfies Record<string, Explanation>;

export type DagExplanationId = keyof typeof DAG_EXPLANATIONS;

/** Every KPI, panel and column on the league page. */
export const LEAGUE_PANELS: readonly DagExplanationId[] = [
  'dagx-pareto',
  'dagx-gini',
  'dagx-active-dags',
  'dagx-total-slot-hours',
  'dagx-league',
  'dagx-presets',
  'dagx-treemap',
  'dagx-col-dag',
  'dagx-col-team',
  'dagx-col-runs',
  'dagx-col-success',
  'dagx-col-duration',
  'dagx-col-slot-hours',
  'dagx-col-share',
  'dagx-col-queue',
  'dagx-col-peak',
  'dagx-col-findings',
];

/** Every KPI, panel and column on the DAG detail page. */
export const DETAIL_PANELS: readonly DagExplanationId[] = [
  'dagd-limits',
  'dagd-share',
  'dagd-runs',
  'dagd-success',
  'dagd-duration',
  'dagd-queue',
  'dagd-self-throttled',
  'dagd-runs-timeline',
  'dagd-gantt',
  'dagd-tasks',
  'dagd-col-task',
  'dagd-col-tries',
  'dagd-col-p50',
  'dagd-col-p95',
  'dagd-col-queue',
  'dagd-col-retries',
  'dagd-col-failure',
  'dagd-col-share',
  'dagd-col-contribution',
];
