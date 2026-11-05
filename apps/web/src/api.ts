import { createApiClient, type EnvironmentOverview, type Meta } from '@dcam/contracts';

export type OverviewRange = '1h' | '6h' | '24h';

/** The narrow API surface the UI uses; tests pass a fake (spec §19). */
export interface DcamApi {
  getMeta(): Promise<Meta>;
  getOverview(envId: string, range: OverviewRange): Promise<EnvironmentOverview>;
}

export function createDcamApi(baseUrl = ''): DcamApi {
  const client = createApiClient(baseUrl);
  return {
    async getMeta() {
      const { data, error } = await client.GET('/api/v1/meta');
      if (!data) throw new Error(error ? JSON.stringify(error) : 'Could not load workspace metadata');
      return data;
    },
    async getOverview(envId, range) {
      const { data, error } = await client.GET('/api/v1/environments/{env_id}/overview', {
        params: { path: { env_id: envId }, query: { range } },
      });
      if (!data) throw new Error((error as { detail?: string } | undefined)?.detail ?? 'Could not load the overview');
      return data;
    },
  };
}
