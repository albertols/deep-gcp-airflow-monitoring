/** GET /api/v1/environments/{env_id}/bottlenecks (FR-BOTL-01/02/07/09, HM-006). */
import type { FastifyInstance } from 'fastify';
import { getBottlenecks } from '@dcam/application';
import type { Workspace } from '../demo';
import { findEnvironment, parseRange, sourcesFor } from '../http';

export function registerBottleneckRoutes(app: FastifyInstance, ws: Workspace) {
  app.get<{ Params: { env_id: string }; Querystring: { range?: string } }>(
    '/api/v1/environments/:env_id/bottlenecks',
    async (req, reply) => {
      const env = findEnvironment(ws, reply, req.params.env_id);
      if (!env) return reply;
      const range = parseRange(reply, req.query.range);
      if (!range) return reply;
      return getBottlenecks(ws, {
        envId: env.env_id,
        range,
        sources: sourcesFor(ws, ['SRC-AF-API', 'SRC-MON', 'SRC-COMPOSER']),
      });
    },
  );
}
