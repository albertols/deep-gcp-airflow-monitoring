/**
 * GET /api/v1/environments/{env_id}/capacity (FR-ENV-02, FR-DAGX-06, S-04) and
 * GET /api/v1/environments/{env_id}/forecast (FR-BOTL-05, HM-010).
 *
 * @implements FR-ENV-02, FR-DAGX-06, FR-BOTL-05, HM-010
 */
import type { FastifyInstance } from 'fastify';
import { getCapacity, getForecast } from '@dcam/application';
import type { Memo } from '../cache';
import type { Workspace } from '../workspace';
import { CAPACITY_RANGES, findEnvironment, parseRange, sourcesFor } from '../http';

export function registerCapacityRoutes(app: FastifyInstance, ws: Workspace, memo: Memo) {
  app.get<{ Params: { env_id: string }; Querystring: { range?: string } }>(
    '/api/v1/environments/:env_id/capacity',
    async (req, reply) => {
      const env = findEnvironment(ws, reply, req.params.env_id);
      if (!env) return reply;
      const range = parseRange(reply, req.query.range, CAPACITY_RANGES);
      if (!range) return reply;
      return memo(`capacity:${env.env_id}:${range}`, () =>
        getCapacity(ws, {
          envId: env.env_id,
          range,
          sources: sourcesFor(ws, ['SRC-AF-API', 'SRC-MON', 'SRC-COMPOSER']),
        }),
      );
    },
  );

  app.get<{ Params: { env_id: string } }>('/api/v1/environments/:env_id/forecast', async (req, reply) => {
    const env = findEnvironment(ws, reply, req.params.env_id);
    if (!env) return reply;
    return memo(`forecast:${env.env_id}`, () =>
      getForecast(ws, { envId: env.env_id, sources: sourcesFor(ws, ['SRC-AF-API', 'SRC-COMPOSER']) }),
    );
  });
}
