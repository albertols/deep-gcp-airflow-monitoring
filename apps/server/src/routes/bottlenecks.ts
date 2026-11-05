/** GET /api/v1/environments/{env_id}/bottlenecks (FR-BOTL-01/02/07/09, HM-006). */
import type { FastifyInstance } from 'fastify';
import type { Workspace } from '../demo';
import { notImplemented } from '../http';

export function registerBottleneckRoutes(app: FastifyInstance, _ws: Workspace) {
  app.get('/api/v1/environments/:env_id/bottlenecks', async (_req, reply) =>
    notImplemented(reply, 'The bottleneck analysis'),
  );
}
