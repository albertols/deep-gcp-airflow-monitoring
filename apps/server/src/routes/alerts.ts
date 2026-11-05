/** GET /api/v1/alerts (FR-ALRT-01/02/06). */
import type { FastifyInstance } from 'fastify';
import type { Workspace } from '../demo';
import { notImplemented } from '../http';

export function registerAlertRoutes(app: FastifyInstance, _ws: Workspace) {
  app.get('/api/v1/alerts', async (_req, reply) => notImplemented(reply, 'Alerts'));
}
