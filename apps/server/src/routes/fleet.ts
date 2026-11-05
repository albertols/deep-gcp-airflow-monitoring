/** GET /api/v1/fleet (FR-FLEET-01/02, HM-028). */
import type { FastifyInstance } from 'fastify';
import type { Workspace } from '../demo';
import { notImplemented } from '../http';

export function registerFleetRoutes(app: FastifyInstance, _ws: Workspace) {
  app.get('/api/v1/fleet', async (_req, reply) => notImplemented(reply, 'The fleet view'));
}
