/** GET /api/v1/environments/{env_id}/dags and /dags/{dag_id} (FR-DAGX-01..03, FR-DAGD-01..04). */
import type { FastifyInstance } from 'fastify';
import type { Workspace } from '../demo';
import { notImplemented } from '../http';

export function registerDagRoutes(app: FastifyInstance, _ws: Workspace) {
  app.get('/api/v1/environments/:env_id/dags', async (_req, reply) =>
    notImplemented(reply, 'The DAG league table'),
  );
  app.get('/api/v1/environments/:env_id/dags/:dag_id', async (_req, reply) =>
    notImplemented(reply, 'DAG detail'),
  );
}
