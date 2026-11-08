/**
 * "Open in" deep links (FR-UI-04): URLs of the Google Cloud console and the Airflow UI for an environment, a
 * DAG, a run or a task. They are built with `URL` and `URLSearchParams`, so every ID is encoded. DCAM never
 * requests them: the user opens them in a new tab, signed in with their own account (read-only by
 * construction). No URL carries a token or a credential.
 *
 * Forms used, each from Google's documentation or the Airflow 2.11.1 source (checked 2026-11-08); forms that
 * are not documented are not generated (specs/011-ui-deep-links/spec.md, ⚠️ VERIFY):
 *
 * - Cloud console pages take the project as `?project=PROJECT_ID`, as in Google's Logs Explorer example
 *   (https://docs.cloud.google.com/gemini-enterprise-agent-platform/scale/runtime/logging). ⚠️ VERIFY: on the
 *   Composer environments and Metrics Explorer pages this console-wide parameter is not documented itself.
 * - The Composer environment: Google documents only the environments list
 *   (`https://console.cloud.google.com/composer/environments`, "Go to Environments" on the Composer 3 pages),
 *   then "click the name of your environment" and its Monitoring tab. ⚠️ VERIFY: a URL of one environment's
 *   page is not documented, so DCAM links the list.
 * - Metrics Explorer: `https://console.cloud.google.com/monitoring/metrics-explorer`
 *   (https://docs.cloud.google.com/monitoring/charts/metrics-explorer). ⚠️ VERIFY: no URL parameter for the
 *   time range is documented, so the menu tells the user which range to set.
 * - Logs Explorer: `https://console.cloud.google.com/logs/query;query=QUERY?project=PROJECT_ID`, "where the
 *   query has been appropriately url-encoded" (the Agent Platform page above). The range is a `timestamp`
 *   expression in the query: "If the query-editor field contains an expression with a timestamp, then the
 *   time-range selector is disabled, and the query uses the timestamp expression as its time-range
 *   restriction" (https://docs.cloud.google.com/logging/docs/view/building-queries). ⚠️ VERIFY: the
 *   `timeRange`, `cursorTimestamp` and `storageScope` parameters are not documented and not used.
 * - Airflow UI: the web server at Composer's `config.airflowUri`, "The URI of the Apache Airflow Web UI hosted
 *   within this environment" (https://docs.cloud.google.com/composer/docs/reference/rest/v1/projects.locations.environments),
 *   or the configured `baseUrl` of a self-managed Airflow. Routes from `airflow/www/views.py` at tag 2.11.1:
 *   `@expose("/home")`, `@expose("/dags/<string:dag_id>/grid")`, and `PoolModelView` (`route_base = "/pool"`)
 *   with Flask-AppBuilder's `ModelView.list` at `@expose("/list/")`. Grid parameters from the React grid at
 *   2.11.1: `dag_run_id` and `task_id` (`static/js/dag/useSelection.ts`), `tab=logs`
 *   (`static/js/dag/details/index.tsx`, `TAB_PARAM`), `base_date` (`static/js/dag/useFilters.tsx`); the grid
 *   shows the runs with `execution_date <= base_date` (`grid_data` in views.py).
 *
 * @implements FR-UI-04
 */

export const CLOUD_CONSOLE = 'https://console.cloud.google.com';

/** Where a Composer environment lives (the configuration file, or demo values). */
export interface ComposerPlace {
  readonly projectId: string;
  readonly location: string;
  /** Composer environment name. */
  readonly environment: string;
}

/** A closed time range, ISO 8601 instants: `[from, to)`. */
export interface TimeWindow {
  readonly from: string;
  readonly to: string;
}

/** A DAG run as the grid selects it. */
export interface RunRef {
  readonly runId: string;
  /** The run's logical date (Airflow 2 `execution_date`), ISO 8601. */
  readonly logicalDate: string;
  /**
   * DCAM does not know the logical date (a custom run ID) and the run's first task start stands in for it,
   * so the run may sit more runs back in the grid than it shows by default.
   */
  readonly logicalDateEstimated?: boolean;
}

/** Log names in Composer's Cloud Logging: `log_id("airflow-worker")` (Composer 3 troubleshooting DAGs page). */
export type ComposerLogId = 'airflow-worker';

/** `encodeURIComponent`, also for `!'()*`: only unreserved characters and escapes remain (RFC 3986). */
function strictEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** A Logging query language string literal: double quotes, with `"` and `\` escaped. */
const literal = (value: string) => `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`;

const iso = (at: string) => new Date(Date.parse(at)).toISOString();

/** Whole seconds, UTC, without milliseconds: `2026-11-05T00:00:01Z`. */
const isoSeconds = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** `at` rounded up to the next whole second (unchanged when it is one). */
const ceilSecond = (at: string) => isoSeconds(Math.ceil(Date.parse(at) / 1000) * 1000);

function consoleUrl(path: string, projectId: string): string {
  const url = new URL(path, CLOUD_CONSOLE);
  url.searchParams.set('project', projectId);
  return url.href;
}

/** The project's Composer environments (the environment's own page is not documented). */
export const composerEnvironmentsUrl = (place: Pick<ComposerPlace, 'projectId'>): string =>
  consoleUrl('/composer/environments', place.projectId);

/** Metrics Explorer of the project. */
export const metricsExplorerUrl = (place: Pick<ComposerPlace, 'projectId'>): string =>
  consoleUrl('/monitoring/metrics-explorer', place.projectId);

/**
 * The environment's logs over the window (spec Appendix C.2 base filter: resource type
 * `cloud_composer_environment` with its `project_id`, `location` and `environment_name` labels,
 * https://docs.cloud.google.com/monitoring/api/resources), optionally one log and one DAG. Task log entries
 * carry the DAG ID as `labels.workflow` (Composer 3 quickstart, `labels.workflow=composer_quickstart`,
 * https://docs.cloud.google.com/composer/docs/composer-3/run-apache-airflow-dag-gcloud). Clauses on separate
 * lines, as in Google's example (`severity%3DINFO%0Aresource.labels…`); timestamps in RFC 3339
 * (https://docs.cloud.google.com/logging/docs/view/logging-query-language).
 */
export function composerLogQuery(
  place: ComposerPlace,
  window: TimeWindow,
  scope: { readonly logId?: ComposerLogId; readonly dagId?: string } = {},
): string {
  const clauses = [
    'resource.type="cloud_composer_environment"',
    `resource.labels.project_id=${literal(place.projectId)}`,
    `resource.labels.location=${literal(place.location)}`,
    `resource.labels.environment_name=${literal(place.environment)}`,
  ];
  // "Don't URL-encode the argument of the log_id function" (query language reference): the whole query is
  // encoded once, below.
  if (scope.logId) clauses.push(`log_id(${literal(scope.logId)})`);
  if (scope.dagId !== undefined) clauses.push(`labels.workflow=${literal(scope.dagId)}`);
  clauses.push(`timestamp>=${literal(iso(window.from))}`, `timestamp<${literal(iso(window.to))}`);
  return clauses.join('\n');
}

/** Logs Explorer of the project with the query prefilled. */
export function logsExplorerUrl(place: Pick<ComposerPlace, 'projectId'>, query: string): string {
  const url = new URL(CLOUD_CONSOLE);
  url.pathname = `/logs/query;query=${strictEncode(query)}`;
  url.searchParams.set('project', place.projectId);
  return url.href;
}

/**
 * The Airflow web server's address as a base for links, or `null` when there is none or it is not a plain
 * http(s) address: one with a user name or password never becomes a link. Query and fragment are dropped.
 */
export function airflowBase(uri: string | null | undefined): URL | null {
  if (!uri) return null;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username !== '' || url.password !== '') return null;
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}

function airflowUrl(base: URL, path: string, params: Readonly<Record<string, string | undefined>> = {}) {
  const url = new URL(base.href);
  url.pathname = `${base.pathname.replace(/\/+$/, '')}${path}`;
  for (const [key, value] of Object.entries(params))
    if (value !== undefined) url.searchParams.set(key, value);
  return url.href;
}

const gridPath = (dagId: string) => `/dags/${strictEncode(dagId)}/grid`;

/**
 * The run is the newest the grid shows: its base date is one second after the logical date, whole seconds,
 * because DCAM keeps milliseconds and Airflow microseconds (`10:15:30.123` may be `10:15:30.123456`).
 */
const runBaseDate = (run: RunRef) => isoSeconds(Math.floor(Date.parse(run.logicalDate) / 1000) * 1000 + 1000);

/** The DAGs list (`/home`). */
export const airflowHomeUrl = (base: URL): string => airflowUrl(base, '/home');

/** The pools list (`/pool/list/`). */
export const airflowPoolsUrl = (base: URL): string => airflowUrl(base, '/pool/list/');

/** The DAG's grid; with `until`, the latest runs up to it (rounded up to the second). */
export const airflowDagUrl = (base: URL, dagId: string, until?: string): string =>
  airflowUrl(base, gridPath(dagId), { base_date: until === undefined ? undefined : ceilSecond(until) });

/** The grid with the run selected. */
export const airflowRunUrl = (base: URL, dagId: string, run: RunRef): string =>
  airflowUrl(base, gridPath(dagId), { dag_run_id: run.runId, base_date: runBaseDate(run) });

/** The grid's logs tab of one task in one run. */
export const airflowTaskLogUrl = (base: URL, dagId: string, run: RunRef, taskId: string): string =>
  airflowUrl(base, gridPath(dagId), {
    dag_run_id: run.runId,
    task_id: taskId,
    tab: 'logs',
    base_date: runBaseDate(run),
  });
