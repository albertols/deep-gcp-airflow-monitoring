/**
 * The UI's API client: typed calls, errors that carry the HTTP status, and the retry rule of the query
 * client (FR-UI-07).
 *
 * @implements FR-UI-07, FR-DAGD-08, FR-DAGD-09
 */
import { QueryClient } from '@tanstack/react-query';
import {
  createApiClient,
  type Alerts,
  type Bottlenecks,
  type Capacity,
  type CapacityRange,
  type Collection,
  type DagComparison,
  type DagDetail,
  type DagIndex,
  type DagLeague,
  type EnvironmentOverview,
  type Findings,
  type Fleet,
  type Forecast,
  type Meta,
  type Range,
  type RunComparison,
  type Schedule,
} from '@dcam/contracts';

export type { Range };

/** The narrow API surface the UI uses; tests pass a fake (spec §19). */
export interface DcamApi {
  getMeta(): Promise<Meta>;
  getOverview(envId: string, range: Range): Promise<EnvironmentOverview>;
  getDagLeague(envId: string, range: Range): Promise<DagLeague>;
  getDagDetail(envId: string, dagId: string, range: Range, runId?: string): Promise<DagDetail>;
  /**
   * The environment's DAG IDs for the command palette (FR-UI-03). Optional: page tests' fakes leave it
   * out, and the palette then lists no DAGs.
   */
  getDagIndex?(envId: string): Promise<DagIndex>;
  /** S-14, FR-DAGD-08: `dags` lists 2 to 4 items `env_id:dag_id`, comma-separated. */
  getDagComparison(dags: string, range: Range): Promise<DagComparison>;
  /** S-13, FR-DAGD-09: run `b` of one DAG against run `a`. */
  getRunComparison(envId: string, dagId: string, a: string, b: string, range: Range): Promise<RunComparison>;
  getBottlenecks(envId: string, range: Range): Promise<Bottlenecks>;
  /** Schedule intelligence (S-17, FR-BOTL-03). */
  getSchedule(envId: string, range: Range): Promise<Schedule>;
  /** Capacity against use (S-04, FR-ENV-02, FR-DAGX-06); its range is 1 hour to 7 days. */
  getCapacity(envId: string, range: CapacityRange): Promise<Capacity>;
  /** The next 24 hours of slot demand from history (HM-010, FR-BOTL-05); it has no range. */
  getForecast(envId: string): Promise<Forecast>;
  getFindings(envId: string): Promise<Findings>;
  getAlerts(envId?: string): Promise<Alerts>;
  getFleet(): Promise<Fleet>;
  /** Collector health and DCAM's own footprint per environment (FR-COLL-11, FR-SELF-01). */
  getCollection(): Promise<Collection>;
}

/** An error answer of the DCAM API: the problem's detail (RFC 9457) and the HTTP status. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Turns an openapi-fetch result into data or an {@link ApiError} carrying the problem's detail. */
function unwrap<T>(result: { data?: T; error?: unknown; response: Response }, what: string): T {
  if (result.data !== undefined) return result.data;
  const detail = (result.error as { detail?: string } | undefined)?.detail;
  throw new ApiError(detail ?? `Could not load ${what}`, result.response.status);
}

/** Attempts after the first, for server errors and network failures. */
const MAX_RETRIES = 3;

/**
 * Query retry rule: a 4xx answer (unknown DAG, invalid range) is final, so the page says so at once
 * instead of after the retries' backoff; server errors and network failures are retried.
 */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status < 500) return false;
  return failureCount < MAX_RETRIES;
}

/** The app's query client: refreshes every 30 s and retries per {@link shouldRetry}. */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { refetchInterval: 30_000, staleTime: 15_000, retry: shouldRetry } },
  });
}

export function createDcamApi(baseUrl = ''): DcamApi {
  const client = createApiClient(baseUrl);
  const env = (envId: string) => ({ env_id: envId });
  return {
    async getMeta() {
      return unwrap(await client.GET('/api/v1/meta'), 'workspace metadata');
    },
    async getOverview(envId, range) {
      return unwrap(
        await client.GET('/api/v1/environments/{env_id}/overview', {
          params: { path: env(envId), query: { range } },
        }),
        'the overview',
      );
    },
    async getDagLeague(envId, range) {
      return unwrap(
        await client.GET('/api/v1/environments/{env_id}/dags', {
          params: { path: env(envId), query: { range } },
        }),
        'the DAG league table',
      );
    },
    async getDagDetail(envId, dagId, range, runId) {
      return unwrap(
        await client.GET('/api/v1/environments/{env_id}/dags/{dag_id}', {
          params: {
            path: { env_id: envId, dag_id: dagId },
            query: runId ? { range, run_id: runId } : { range },
          },
        }),
        'the DAG',
      );
    },
    async getDagIndex(envId) {
      return unwrap(
        await client.GET('/api/v1/environments/{env_id}/dag-index', { params: { path: env(envId) } }),
        'the DAG list',
      );
    },
    async getDagComparison(dags, range) {
      return unwrap(
        await client.GET('/api/v1/compare/dags', { params: { query: { dags, range } } }),
        'the comparison',
      );
    },
    async getRunComparison(envId, dagId, a, b, range) {
      return unwrap(
        await client.GET('/api/v1/environments/{env_id}/dags/{dag_id}/runs/compare', {
          params: { path: { env_id: envId, dag_id: dagId }, query: { a, b, range } },
        }),
        'the run comparison',
      );
    },
    async getBottlenecks(envId, range) {
      return unwrap(
        await client.GET('/api/v1/environments/{env_id}/bottlenecks', {
          params: { path: env(envId), query: { range } },
        }),
        'the bottleneck analysis',
      );
    },
    async getSchedule(envId, range) {
      return unwrap(
        await client.GET('/api/v1/environments/{env_id}/schedule', {
          params: { path: env(envId), query: { range } },
        }),
        'schedule intelligence',
      );
    },
    async getCapacity(envId, range) {
      return unwrap(
        await client.GET('/api/v1/environments/{env_id}/capacity', {
          params: { path: env(envId), query: { range } },
        }),
        'the capacity analysis',
      );
    },
    async getForecast(envId) {
      return unwrap(
        await client.GET('/api/v1/environments/{env_id}/forecast', { params: { path: env(envId) } }),
        'the forecast',
      );
    },
    async getFindings(envId) {
      return unwrap(
        await client.GET('/api/v1/environments/{env_id}/findings', { params: { path: env(envId) } }),
        'findings',
      );
    },
    async getAlerts(envId) {
      return unwrap(
        await client.GET('/api/v1/alerts', { params: { query: envId ? { env_id: envId } : {} } }),
        'alerts',
      );
    },
    async getFleet() {
      return unwrap(await client.GET('/api/v1/fleet'), 'the fleet');
    },
    async getCollection() {
      return unwrap(await client.GET('/api/v1/collection'), 'collection health');
    },
  };
}
