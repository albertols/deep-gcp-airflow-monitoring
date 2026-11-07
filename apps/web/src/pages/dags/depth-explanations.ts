/**
 * (i) explanations for the DAG detail panels of feature 006 (spec §12.9): durations against the baseline
 * (HM-016, FR-TASK-01), failures, retries and flakiness (HM-015) and the critical path (HM-007). Every panel,
 * KPI and column has an entry; the UI tests fail if one is missing.
 *
 * @implements FR-UI-05
 */
import type { Explanation } from '@dcam/ui-kit';

const TASKS_DOC = {
  title: 'Airflow documentation: tasks and task instances',
  url: 'https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/tasks.html',
};

const API = ['SRC-AF-API'];
const LOW_SAMPLE =
  'With fewer than 20 tries a p95 is not reliable: DCAM shows the maximum instead, marked "≤" (spec §8.9).';
const RATE_SAMPLE = 'A rate needs 20 of what it divides by; below that DCAM shows the count instead.';
const SUCCESSFUL_ONLY =
  'Only successful tries count: a failed try ends early and is not a duration of the work.';

export const DEPTH_EXPLANATIONS = {
  // Duration against baseline (HM-016, FR-TASK-01)
  'dagd-duration-baseline': {
    id: 'dagd-duration-baseline',
    title: 'Duration against baseline',
    summary:
      'Whether the DAG and each of its tasks now take longer than their own baseline: the 28 days before the range (HM-016).',
    whyItMatters:
      'A task that gets slower holds worker slots longer and makes runs late, often long before anything fails.',
    formula:
      'regression when p95 now ≥ 1.3 × baseline p95, with ≥ 10 successful tries now, a one-sided Mann–Whitney U test with p < 0.01, and a Benjamini–Hochberg q ≤ 0.05 across the tasks of the DAG',
    howToRead:
      "Each row draws the durations now (a box from p25 to p75, a line at the median, a whisker to p95) over the baseline band (p25 to p75 shaded, a dashed line at its p95). Regressions come first: check what changed in the task's code, its data or what it calls around the time it got slower.",
    sources: API,
    caveats: [
      SUCCESSFUL_ONLY,
      'The baseline p95 needs 20 successful tries; with fewer, DCAM says the baseline is not available yet.',
      'DCAM builds the baseline from the history it has collected. A partial baseline says how many of its 28 days it covers.',
      'With 10 to 19 tries now, the change uses the interpolated p95 while the p95 column shows the maximum (§8.9).',
      'Not done yet: dating the change and linking it to deployments, and leaving out maintenance windows.',
      'Tasks whose work grows with the data can get slower for good reason.',
    ],
    docs: [TASKS_DOC],
  },
  'dagd-dur-col-task': { id: 'dagd-dur-col-task', title: 'Task', summary: 'The task ID.', sources: API },
  'dagd-dur-col-distribution': {
    id: 'dagd-dur-col-distribution',
    title: 'Distribution',
    summary: 'Durations of successful tries in the range, drawn over the baseline band.',
    howToRead:
      'Box: p25 to p75 now, with a line at the median and a whisker to p95. Shaded band: the baseline p25 to p75; dashed line: the baseline p95. Each row has its own scale.',
    sources: API,
  },
  'dagd-dur-col-p50': {
    id: 'dagd-dur-col-p50',
    title: 'p50 now',
    summary: 'Median duration of successful tries in the range.',
    sources: API,
  },
  'dagd-dur-col-p95': {
    id: 'dagd-dur-col-p95',
    title: 'p95 now',
    summary: '95th percentile duration of successful tries in the range.',
    sources: API,
    caveats: [LOW_SAMPLE],
  },
  'dagd-dur-col-baseline': {
    id: 'dagd-dur-col-baseline',
    title: 'Baseline p95',
    summary: '95th percentile duration of successful tries in the 28 days before the range.',
    sources: API,
    caveats: [LOW_SAMPLE],
  },
  'dagd-dur-col-change': {
    id: 'dagd-dur-col-change',
    title: 'Change',
    summary: 'How many times longer the p95 is now than in the baseline.',
    formula: 'p95 now ÷ baseline p95; shown when both have enough tries',
    sources: API,
  },
  'dagd-dur-col-verdict': {
    id: 'dagd-dur-col-verdict',
    title: 'Verdict',
    summary:
      'Regression, within baseline, too few runs (fewer than 10 successful tries now), or no baseline yet (fewer than 20 in the baseline).',
    sources: API,
  },
  // Failures, retries and flakiness (HM-015)
  'dagd-reliability': {
    id: 'dagd-reliability',
    title: 'Failures, retries and flakiness',
    summary:
      "How often the DAG's runs and tries fail, how often its tasks retry or succeed only after a retry, and how long recovery takes (HM-015).",
    whyItMatters:
      'Retries hold worker slots twice and hide unreliable dependencies; a flaky task fails runs on a bad day.',
    formula:
      'try failure rate = failed tries ÷ tries; run failure rate = failed runs ÷ finished runs; retry rate = task instances with try number > 1 ÷ task instances; flaky rate = task instances that succeeded after a failed try ÷ task instances',
    howToRead:
      'The flakiest tasks come first. Fix the cause, make the task idempotent, and use retry backoff.',
    sources: API,
    caveats: [
      RATE_SAMPLE,
      'History DCAM reads after the fact keeps only the latest try of a task instance. A successful try 2 with no earlier try stored counts as flaky, inferred from the try number; clearing a task to re-run it also raises the try number.',
      'Error signatures need Cloud Logging, which DCAM does not read yet.',
      'A try, its task instance and its run count in the range the try started in.',
    ],
    docs: [TASKS_DOC],
  },
  'dagd-rel-run-failure': {
    id: 'dagd-rel-run-failure',
    title: 'Run failure rate',
    summary: 'Failed runs ÷ finished runs in the range.',
    sources: API,
    caveats: [RATE_SAMPLE, 'Running runs are left out.'],
  },
  'dagd-rel-try-failure': {
    id: 'dagd-rel-try-failure',
    title: 'Try failure rate',
    summary: 'Failed tries ÷ tries in the range, retries included.',
    sources: API,
    caveats: [RATE_SAMPLE],
  },
  'dagd-rel-retry': {
    id: 'dagd-rel-retry',
    title: 'Retry rate',
    summary: 'Task instances with a try number above 1 ÷ task instances.',
    sources: API,
    caveats: [RATE_SAMPLE],
  },
  'dagd-rel-flaky': {
    id: 'dagd-rel-flaky',
    title: 'Flaky rate',
    summary: 'Task instances whose last try succeeded after a failed try ÷ task instances.',
    sources: API,
    caveats: [
      RATE_SAMPLE,
      'Includes task instances inferred from the try number where the failed try is not stored.',
    ],
  },
  'dagd-rel-mttr': {
    id: 'dagd-rel-mttr',
    title: 'Time to recovery',
    summary:
      "Mean time from a failed run's end to the next successful run's end (MTTR). Per task, from a failed try to the next successful try.",
    sources: API,
    caveats: ['A failure with no success after it yet is not counted; the hint says how many there are.'],
  },
  'dagd-rel-col-task': { id: 'dagd-rel-col-task', title: 'Task', summary: 'The task ID.', sources: API },
  'dagd-rel-col-instances': {
    id: 'dagd-rel-col-instances',
    title: 'Task instances',
    summary: 'Task instances of this task with a try starting in the range (one per run and map index).',
    sources: API,
  },
  'dagd-rel-col-failed': {
    id: 'dagd-rel-col-failed',
    title: 'Failed tries',
    summary: 'Failed tries of all tries in the range; the tooltip has the rate.',
    sources: API,
  },
  'dagd-rel-col-retry': {
    id: 'dagd-rel-col-retry',
    title: 'Retried',
    summary: 'Task instances with a try number above 1 ÷ task instances.',
    sources: API,
    caveats: [RATE_SAMPLE],
  },
  'dagd-rel-col-flaky': {
    id: 'dagd-rel-col-flaky',
    title: 'Flaky',
    summary: 'Task instances that succeeded after a failed try ÷ task instances.',
    sources: API,
    caveats: [RATE_SAMPLE],
  },
  'dagd-rel-col-mttr': {
    id: 'dagd-rel-col-mttr',
    title: 'Recovery',
    summary: 'Mean time from a failed try of this task to its next successful try.',
    sources: API,
  },
  // Critical path (HM-007)
  'dagd-critical-path': {
    id: 'dagd-critical-path',
    title: 'Critical path',
    summary:
      "The chain of tries that set the run's duration (HM-007), and how often each task is on it in the range's finished runs.",
    whyItMatters:
      'Only a shorter critical path makes the run finish sooner; speeding up other tasks does not.',
    formula:
      'from the try that ended last, step back to the earlier try of the same task instance (a retry), else to the try that ended last before this one became ready',
    howToRead:
      'On the Gantt the path has a dashed outline. Waiting is the time between steps: scheduling, pools and the queue.',
    sources: API,
    caveats: [
      'An estimate from timing: DCAM does not collect the DAG’s task dependencies yet, so a parallel branch that ended just before a task became ready can be taken for its upstream.',
      'Slack per task needs the dependencies and is not shown.',
      'Mapped task instances collapse to the one that ended last; skipped tasks never start.',
    ],
    docs: [TASKS_DOC],
  },
} as const satisfies Record<string, Explanation>;

export type DepthExplanationId = keyof typeof DEPTH_EXPLANATIONS;

/** Every panel, KPI and column of the feature-006 panels on the DAG detail page. */
export const DEPTH_PANELS = Object.keys(DEPTH_EXPLANATIONS) as readonly DepthExplanationId[];
