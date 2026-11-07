/**
 * (i) explanations for the schedule intelligence page (S-17, FR-UI-05).
 *
 * @implements FR-UI-05
 */
import type { Explanation } from '@dcam/ui-kit';
import { WIKI_SLUGS, wikiHref } from '../wiki/content/slugs';

const DAG_RUN_DOC = {
  title: 'Airflow documentation: DAG runs and cron presets',
  url: 'https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/dag-run.html',
};
const UTC_CAVEAT =
  'Times are UTC. DCAM does not collect DAG time zones yet, so a DAG scheduled in another time zone shows at its UTC time.';

export const SCHEDULE_EXPLANATIONS = {
  'sched-collision-index': {
    id: 'sched-collision-index',
    wiki: { href: wikiHref(WIKI_SLUGS.scheduleCollisions) },
    title: 'Collision index',
    summary: 'The share of all daily scheduled starts that fall in the busiest minute of the hour (HM-009).',
    whyItMatters:
      'Many runs starting in the same minute ask for worker slots and pools at once; work then queues even when the day as a whole has capacity.',
    formula:
      'collision index = planned starts per day in the busiest minute-of-hour ÷ all planned starts per day',
    howToRead: 'REC-SCHED-01 fires at 20 % or more when waiting coincides with that minute.',
    sources: ['SRC-AF-API'],
    caveats: [UTC_CAVEAT, 'DAGs without a fixed start minute (timedeltas, assets, manual) are not counted.'],
    docs: [DAG_RUN_DOC],
  },
  'sched-busiest-minute': {
    id: 'sched-busiest-minute',
    wiki: { href: wikiHref(WIKI_SLUGS.scheduleCollisions) },
    title: 'Busiest minute',
    summary: 'The minute of the hour with the most planned starts per day.',
    sources: ['SRC-AF-API'],
    caveats: [UTC_CAVEAT],
  },
  'sched-daily-starts': {
    id: 'sched-daily-starts',
    wiki: { href: wikiHref(WIKI_SLUGS.scheduleCollisions) },
    title: 'Daily scheduled starts',
    summary: 'Planned DAG run starts per day, from the cron schedules of unpaused DAGs.',
    formula:
      'Σ over unpaused DAGs of starts per day; day-of-week, day-of-month and month limits count as a share of days',
    sources: ['SRC-AF-API'],
  },
  'sched-runs': {
    id: 'sched-runs',
    wiki: { href: wikiHref(WIKI_SLUGS.scheduleCollisions) },
    title: 'Runs started',
    summary: 'DAG runs whose first task started in the range.',
    sources: ['SRC-AF-API'],
    caveats: ['DCAM stores task instances, not DAG runs: a run starts when its first task started.'],
  },
  'sched-heatmap': {
    id: 'sched-heatmap',
    wiki: { href: wikiHref(WIKI_SLUGS.scheduleCollisions) },
    title: 'Start heatmap',
    summary:
      'Planned starts per day, or runs that started, by hour of the day (rows) and minute of the hour (columns).',
    howToRead:
      'A bright column at minute 0 means many schedules start on the hour. Compare planned with actual: actual starts later than planned show scheduling delay.',
    sources: ['SRC-AF-API'],
    caveats: [UTC_CAVEAT],
    docs: [DAG_RUN_DOC],
  },
  'sched-top-minutes': {
    id: 'sched-top-minutes',
    wiki: { href: wikiHref(WIKI_SLUGS.scheduleCollisions) },
    title: 'Most colliding minutes',
    summary:
      'The minutes of the hour with the most planned starts, with the schedules and DAGs that start then.',
    whyItMatters:
      'These DAGs are the candidates for a stagger: moving a few minutes later flattens the peak.',
    sources: ['SRC-AF-API'],
    caveats: [UTC_CAVEAT],
  },
  'sched-shared': {
    id: 'sched-shared',
    wiki: { href: wikiHref(WIKI_SLUGS.scheduleCollisions) },
    title: 'Shared schedules',
    summary:
      'Cron schedules that several unpaused DAGs use, most DAGs first. Presets count with their cron form.',
    sources: ['SRC-AF-API'],
  },
  'sched-findings': {
    id: 'sched-findings',
    wiki: { href: wikiHref(WIKI_SLUGS.advisorRules) },
    title: 'Schedule findings',
    summary:
      'Advisor findings about schedule collisions (REC-SCHED-01), with the stagger snippet in the advisor.',
    sources: ['SRC-AF-API'],
    freshness: 'The advisor evaluates the last 24 hours.',
  },
} as const satisfies Record<string, Explanation>;

export type ScheduleExplanationId = keyof typeof SCHEDULE_EXPLANATIONS;
export const SCHEDULE_PANELS = Object.keys(SCHEDULE_EXPLANATIONS) as ScheduleExplanationId[];
