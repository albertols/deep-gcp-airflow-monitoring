/** GET /api/v1/environments/{env_id}/findings (FR-ADV-01..04). */
import type { FastifyInstance } from 'fastify';
import type { Workspace } from '../demo';
import { notImplemented } from '../http';

export function registerFindingRoutes(app: FastifyInstance, _ws: Workspace) {
  app.get('/api/v1/environments/:env_id/findings', async (_req, reply) =>
    notImplemented(reply, 'The advisor'),
  );
}
