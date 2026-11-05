import {
  createApiClient,
  type Alerts,
  type Bottlenecks,
  type DagDetail,
  type DagLeague,
  type EnvironmentOverview,
  type Findings,
  type Fleet,
  type Meta,
  type Range,
} from '@dcam/contracts';

export type OverviewRange = Range;
export type { Range };

/** The narrow API surface the UI uses; tests pass a fake (spec §19). */
export interface DcamApi {
  getMeta(): Promise<Meta>;
  getOverview(envId: string, range: Range): Promise<EnvironmentOverview>;
  getDagLeague(envId: string, range: Range): Promise<DagLeague>;
  getDagDetail(envId: string, dagId: string, range: Range, runId?: string): Promise<DagDetail>;
  getBottlenecks(envId: string, range: Range): Promise<Bottlenecks>;
  getFindings(envId: string): Promise<Findings>;
  getAlerts(envId?: string): Promise<Alerts>;
  getFleet(): Promise<Fleet>;
}

/** Turns an openapi-fetch result into data or an Error carrying the problem's detail. */
function unwrap<T>(result: { data?: T; error?: unknown }, what: string): T {
  if (result.data !== undefined) return result.data;
  const detail = (result.error as { detail?: string } | undefined)?.detail;
  throw new Error(detail ?? `Could not load ${what}`);
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
    async getBottlenecks(envId, range) {
      return unwrap(
        await client.GET('/api/v1/environments/{env_id}/bottlenecks', {
          params: { path: env(envId), query: { range } },
        }),
        'the bottleneck analysis',
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
  };
}
