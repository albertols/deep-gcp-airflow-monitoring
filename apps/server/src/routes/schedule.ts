/** GET /api/v1/environments/{env_id}/schedule (FR-BOTL-03, HM-009): schedule intelligence for S-17. */
import type { FastifyInstance } from 'fastify';
import { getScheduleIntelligence } from '@dcam/application';
import type { Memo } from '../cache';
import type { Workspace } from '../workspace';
import { findEnvironment, parseRange, sourcesFor } from '../http';

export function registerScheduleRoutes(app: FastifyInstance, ws: Workspace, memo: Memo) {
  app.get<{ Params: { env_id: string }; Querystring: { range?: string } }>(
    '/api/v1/environments/:env_id/schedule',
    async (req, reply) => {
      const env = findEnvironment(ws, reply, req.params.env_id);
      if (!env) return reply;
      const range = parseRange(reply, req.query.range);
      if (!range) return reply;
      return memo(`schedule:${env.env_id}:${range}`, () =>
        getScheduleIntelligence(ws, { envId: env.env_id, range, sources: sourcesFor(ws, ['SRC-AF-API']) }),
      );
    },
  );
}
