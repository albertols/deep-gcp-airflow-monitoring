/** GET /api/v1/environments/{env_id}/bottlenecks (FR-BOTL-01/02/07/09, HM-006). */
import type { FastifyInstance } from 'fastify';
import type { Bottlenecks, Range } from '@dcam/contracts';
import { getBottlenecks } from '@dcam/application';
import type { Memo } from '../cache';
import type { Workspace } from '../workspace';
import { findEnvironment, parseRange, sourcesFor } from '../http';

/** The (memoised) bottleneck analysis, shared with the fleet view. */
export function bottlenecksFor(ws: Workspace, memo: Memo) {
  return (envId: string, range: Range): Promise<Bottlenecks> =>
    memo(`bottlenecks:${envId}:${range}`, () =>
      getBottlenecks(ws, {
        envId,
        range,
        sources: sourcesFor(ws, ['SRC-AF-API', 'SRC-MON', 'SRC-COMPOSER']),
      }),
    );
}

export function registerBottleneckRoutes(app: FastifyInstance, ws: Workspace, memo: Memo) {
  const analyse = bottlenecksFor(ws, memo);
  app.get<{ Params: { env_id: string }; Querystring: { range?: string } }>(
    '/api/v1/environments/:env_id/bottlenecks',
    async (req, reply) => {
      const env = findEnvironment(ws, reply, req.params.env_id);
      if (!env) return reply;
      const range = parseRange(reply, req.query.range);
      if (!range) return reply;
      return analyse(env.env_id, range);
    },
  );
}
