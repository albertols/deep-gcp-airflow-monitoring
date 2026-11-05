/**
 * Default-deny allowlist of read-only endpoints (spec §18.2). Every outbound request to a monitored
 * system must match one entry. Changes to this file need security review (spec §18.2 rule 6).
 *
 * @implements NFR-SEC-04
 */

export type Service = 'airflow' | 'monitoring' | 'logging' | 'composer' | 'storage';
export type AllowedMethod = 'GET' | 'POST';

export interface AllowEntry {
  readonly id: string;
  readonly service: Service;
  readonly method: AllowedMethod;
  /** Matched against the URL's encoded pathname, anchored. */
  readonly path: RegExp;
  /** Required for every POST entry: validates that the body is a pure read request. */
  readonly body?: (body: unknown) => boolean;
}

const SEG = '[^/]+';

/** Airflow REST API reads, identical for v1 (Airflow 2) and v2 (Airflow 3) where the paths match. */
function airflowEntries(version: 'v1' | 'v2'): AllowEntry[] {
  const p = `/api/${version}`;
  const ti = `${p}/dags/${SEG}/dagRuns/${SEG}/taskInstances`;
  const entries: Array<[string, string]> = [
    ['health', version === 'v1' ? `${p}/health` : `${p}/monitor/health`],
    ['version', `${p}/version`],
    ['pools', `${p}/pools(/${SEG})?`],
    ['import-errors', `${p}/importErrors(/\\d+)?`],
    ['dag-warnings', `${p}/dagWarnings`],
    ['event-logs', `${p}/eventLogs`],
    // Doctor privilege probe only (spec §18.3): Viewer gets 403, Op or higher gets 200.
    ['providers-probe', `${p}/providers`],
    ['dags', `${p}/dags`],
    ['dag', `${p}/dags/${SEG}(/details)?`],
    ['dag-tasks', `${p}/dags/${SEG}/tasks(/${SEG})?`],
    ['dag-runs', `${p}/dags/${SEG}/dagRuns(/${SEG})?`],
    ['task-instances', ti],
    ['task-instance', `${ti}/${SEG}(/\\d+)?(/listMapped|/tries(/\\d+)?|/logs/\\d+)?`],
    ['dag-source', `${p}/dagSources/${SEG}`],
  ];
  return entries.map(([id, path]) => ({
    id: `airflow.${version}.${id}`,
    service: 'airflow',
    method: 'GET',
    path: new RegExp(`^${path}$`),
  }));
}

const LOGGING_LIST_KEYS = new Set(['resourceNames', 'filter', 'orderBy', 'pageSize', 'pageToken']);

/** Cloud Logging `entries:list` is a read that uses POST; only list parameters are accepted. */
export function isLoggingListBody(body: unknown): boolean {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  const record = body as Record<string, unknown>;
  if (!Object.keys(record).every((k) => LOGGING_LIST_KEYS.has(k))) return false;
  const names = record['resourceNames'];
  return Array.isArray(names) && names.length > 0 && names.every((n) => typeof n === 'string');
}

const PROJECT = `/projects/${SEG}`;
const LOCATION = `${PROJECT}/locations/${SEG}`;

export const ALLOWLIST: readonly AllowEntry[] = [
  ...airflowEntries('v1'),
  ...airflowEntries('v2'),
  {
    id: 'monitoring.read',
    service: 'monitoring',
    method: 'GET',
    path: new RegExp(`^/v3${PROJECT}/(timeSeries|metricDescriptors|monitoredResourceDescriptors)(/.+)?$`),
  },
  {
    id: 'monitoring.promql',
    service: 'monitoring',
    method: 'GET',
    path: new RegExp(`^/v1${PROJECT}/location/global/prometheus/api/v1/(query|query_range|series|labels|label/${SEG}/values)$`),
  },
  { id: 'logging.entries-list', service: 'logging', method: 'POST', path: /^\/v2\/entries:list$/, body: isLoggingListBody },
  { id: 'logging.logs-list', service: 'logging', method: 'GET', path: new RegExp(`^/v2${PROJECT}/logs$`) },
  {
    id: 'composer.read',
    service: 'composer',
    method: 'GET',
    path: new RegExp(
      `^/v1${LOCATION}/(environments(/${SEG}(/workloads|:fetchDatabaseProperties)?)?|operations(/${SEG})?|imageVersions)$`,
    ),
  },
  { id: 'storage.objects-read', service: 'storage', method: 'GET', path: new RegExp(`^/storage/v1/b/${SEG}/o(/${SEG})?$`) },
];
