/** GET /api/v1/environments/{env_id}/overview (HM-003, HM-011, FR-DAGX-03). */
import type { FastifyInstance } from 'fastify';
import { getEnvironmentOverview } from '@dcam/application';
import type { Workspace } from '../demo';
import { findEnvironment, parseRange, sourcesFor } from '../http';

export function registerOverviewRoutes(app: FastifyInstance, ws: Workspace) {
  app.get<{ Params: { env_id: string }; Querystring: { range?: string } }>(
    '/api/v1/environments/:env_id/overview',
    async (req, reply) => {
      const env = findEnvironment(ws, reply, req.params.env_id);
      if (!env) return reply;
      const range = parseRange(reply, req.query.range);
      if (!range) return reply;
      return getEnvironmentOverview(ws, {
        envId: env.env_id,
        range,
        sources: sourcesFor(ws, ['SRC-AF-API']),
      });
    },
  );
}
