/**
 * GET /api/v1/alerts (FR-ALRT-01/02/06): local alert rules, their states and 24 h history, for every
 * environment or the one in `env_id`. Read-only: DCAM alerts locally and creates nothing in Cloud
 * Monitoring (spec §18.2).
 */
import type { FastifyInstance } from 'fastify';
import { getAlerts } from '@dcam/application';
import type { Workspace } from '../demo';
import { findEnvironment, sourcesFor } from '../http';

export function registerAlertRoutes(app: FastifyInstance, ws: Workspace) {
  app.get<{ Querystring: { env_id?: string } }>('/api/v1/alerts', async (req, reply) => {
    const requested = req.query.env_id;
    let envIds = ws.environments.map((e) => e.env_id);
    if (requested !== undefined) {
      const env = findEnvironment(ws, reply, requested);
      if (!env) return reply;
      envIds = [env.env_id];
    }
    return getAlerts(ws, { envIds, sources: sourcesFor(ws, ['SRC-AF-API', 'SRC-MON', 'SRC-COMPOSER']) });
  });
}
