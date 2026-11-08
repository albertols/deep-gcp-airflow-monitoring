/**
 * The items of the "Open in" menu (FR-UI-04) for an environment, the bottleneck page, a DAG or a task: each
 * a link with a hint, or, where a field is missing, what is missing and what to do. A missing field never
 * gives a link. The URLs come from `deep-links.ts`.
 *
 * @implements FR-UI-04
 */
import type { Meta } from '@dcam/contracts';
import {
  airflowBase,
  airflowDagUrl,
  airflowHomeUrl,
  airflowPoolsUrl,
  airflowRunUrl,
  airflowTaskLogUrl,
  composerEnvironmentsUrl,
  composerLogQuery,
  logsExplorerUrl,
  metricsExplorerUrl,
  type ComposerPlace,
  type RunRef,
  type TimeWindow,
} from './deep-links';

export type MenuLink =
  | { readonly kind: 'link'; readonly label: string; readonly href: string; readonly hint: string }
  | { readonly kind: 'missing'; readonly label: string; readonly reason: string };

export interface LinkGroup {
  readonly title: 'Cloud console' | 'Airflow UI';
  readonly links: readonly MenuLink[];
}

/** Where an environment lives, from `/api/v1/meta`. */
export type EnvironmentPlace = Pick<Meta['environments'][number], 'composer' | 'airflow_uri'>;

export interface LinkContext {
  /** `null` while DCAM has not read the environment's place (meta not loaded). */
  readonly place: EnvironmentPlace | null;
  /** The range the page shows: the instants the server counted. */
  readonly window: TimeWindow;
  /** The same range in the page's words and time zone, for the hints. */
  readonly windowText: string;
}

export type LinkTarget =
  | { readonly page: 'environment' }
  | { readonly page: 'bottlenecks' }
  | { readonly page: 'dag'; readonly dagId: string; readonly run: RunRef | null }
  | {
      readonly page: 'task';
      readonly dagId: string;
      readonly taskId: string;
      readonly run: RunRef | null;
      /** When the task's tries in the run ran ({@link triesWindow}); `null` without a try. */
      readonly tries: TimeWindow | null;
    };

const NO_PLACE = 'DCAM could not read where this environment lives. Reload the page.';
const NOT_COMPOSER = 'This environment is a self-managed Airflow, so it has no Cloud console pages.';
const AIRFLOW_NOT_KNOWN_COMPOSER =
  'DCAM learns the Airflow UI address from the Composer API on its first collection cycle. Wait a minute, or check the DCAM health page if it stays missing.';
const AIRFLOW_NOT_KNOWN = 'DCAM has no Airflow UI address for this environment yet.';
const AIRFLOW_UNSAFE =
  'The Airflow UI address DCAM has is not a plain http or https address, so DCAM gives no link.';
const NO_RUN = 'No run of this DAG in the range. Pick a longer range.';
const NO_TRY = 'This task has no try in the selected run. Pick another run in the Gantt chart.';

const link = (label: string, href: string, hint: string): MenuLink => ({ kind: 'link', label, href, hint });
const missing = (label: string, reason: string): MenuLink => ({ kind: 'missing', label, reason });

function consoleLinks(ctx: LinkContext, target: LinkTarget): readonly MenuLink[] {
  if (target.page === 'task' && target.tries === null)
    return [missing('Logs Explorer: task worker logs', NO_TRY)];
  if (ctx.place === null) return [missing('Cloud console pages', NO_PLACE)];
  const c = ctx.place.composer;
  if (!c) return [missing('Cloud console pages', NOT_COMPOSER)];
  const place: ComposerPlace = { projectId: c.project_id, location: c.location, environment: c.environment };
  const logs = (window: TimeWindow, scope: Parameters<typeof composerLogQuery>[2] = {}) =>
    logsExplorerUrl(place, composerLogQuery(place, window, scope));

  if (target.page === 'task')
    return [
      link(
        'Logs Explorer: task worker logs',
        logs(target.tries ?? ctx.window, { logId: 'airflow-worker', dagId: target.dagId }),
        `Worker logs of ${target.dagId} while ${target.taskId} ran in this run, with a minute either side. Composer documents no task label, so other tasks of the DAG that ran then show too.`,
      ),
    ];

  const setRange = `Set the time range to ${ctx.windowText} there: Google documents no link parameter for it.`;
  return [
    link(
      'Composer environments',
      composerEnvironmentsUrl(place),
      `Open ${c.environment} in the list; its Monitoring tab has Composer's dashboard. ${setRange}`,
    ),
    link('Metrics Explorer', metricsExplorerUrl(place), setRange),
    target.page === 'dag'
      ? link(
          'Logs Explorer: DAG worker logs',
          logs(ctx.window, { logId: 'airflow-worker', dagId: target.dagId }),
          `Worker logs of ${target.dagId}, ${ctx.windowText}.`,
        )
      : link(
          'Logs Explorer: environment logs',
          logs(ctx.window),
          `Every log of ${c.environment}, ${ctx.windowText}.`,
        ),
  ];
}

function airflowLinks(ctx: LinkContext, target: LinkTarget): readonly MenuLink[] {
  if (target.page === 'task' && (target.tries === null || target.run === null))
    return [missing('Task log', target.run === null ? NO_RUN : NO_TRY)];
  if (ctx.place === null) return [missing('Airflow UI pages', NO_PLACE)];
  const base = airflowBase(ctx.place.airflow_uri);
  if (!base) {
    const reason = ctx.place.airflow_uri
      ? AIRFLOW_UNSAFE
      : ctx.place.composer
        ? AIRFLOW_NOT_KNOWN_COMPOSER
        : AIRFLOW_NOT_KNOWN;
    return [missing('Airflow UI pages', reason)];
  }
  const home = link('DAGs', airflowHomeUrl(base), 'Every DAG of the environment.');
  switch (target.page) {
    case 'environment':
      return [home];
    case 'bottlenecks':
      return [
        link(
          'Pools',
          airflowPoolsUrl(base),
          'Every pool with its slots and the tasks running and queued in it.',
        ),
        home,
      ];
    case 'dag':
      return [
        link(
          'DAG grid',
          airflowDagUrl(base, target.dagId, ctx.window.to),
          'The latest runs up to the end of the range.',
        ),
        target.run
          ? link('Selected run', airflowRunUrl(base, target.dagId, target.run), `Run ${target.run.runId}.`)
          : missing('Selected run', NO_RUN),
      ];
    case 'task':
      return target.run
        ? [
            link(
              'Task log',
              airflowTaskLogUrl(base, target.dagId, target.run, target.taskId),
              `The log of ${target.taskId} in run ${target.run.runId}.`,
            ),
          ]
        : [missing('Task log', NO_RUN)];
  }
}

/** The menu: Cloud console pages, then Airflow UI pages. */
export function openInLinks(ctx: LinkContext, target: LinkTarget): readonly LinkGroup[] {
  return [
    { title: 'Cloud console', links: consoleLinks(ctx, target) },
    { title: 'Airflow UI', links: airflowLinks(ctx, target) },
  ];
}

const MINUTE_MS = 60_000;

interface TryTimes {
  readonly ready_at: string | null;
  readonly queued_at: string | null;
  readonly start: string | null;
  readonly end: string | null;
}

/**
 * When a task's tries in one run ran, for its worker logs: from the first try's start (or queue or ready
 * time, for a try that never started) to the last try's end, a minute either side. A try still running ends
 * at `until` (the range end). `null` when no try has a time.
 */
export function triesWindow(tries: readonly TryTimes[], until: string): TimeWindow | null {
  let from = Infinity;
  let to = -Infinity;
  const untilMs = Date.parse(until);
  for (const t of tries) {
    const began = t.start ?? t.queued_at ?? t.ready_at;
    if (began === null) continue;
    from = Math.min(from, Date.parse(began));
    to = Math.max(to, t.end === null ? untilMs : Date.parse(t.end));
  }
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return {
    from: new Date(from - MINUTE_MS).toISOString(),
    to: new Date(Math.max(to, from) + MINUTE_MS).toISOString(),
  };
}
