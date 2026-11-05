/**
 * GET /api/v1/environments/{env_id}/findings (FR-ADV-01..04, FR-ADV-08). Read-only: remediation
 * snippets are returned as text for people to review and apply; DCAM never runs them (FR-ADV-03).
 */
import type { FastifyInstance } from 'fastify';
import { getFindings } from '@dcam/application';
import type { Workspace } from '../demo';
import { findEnvironment, sourcesFor } from '../http';

export function registerFindingRoutes(app: FastifyInstance, ws: Workspace) {
  app.get<{ Params: { env_id: string } }>('/api/v1/environments/:env_id/findings', async (req, reply) => {
    const env = findEnvironment(ws, reply, req.params.env_id);
    if (!env) return reply;
    return getFindings(ws, {
      envId: env.env_id,
      sources: sourcesFor(ws, ['SRC-AF-API', 'SRC-MON', 'SRC-COMPOSER']),
    });
  });
}
