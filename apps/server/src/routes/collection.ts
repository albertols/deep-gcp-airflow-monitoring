/**
 * GET /api/v1/collection: collector health and DCAM's own footprint per environment. The engine
 * computes the status on demand, so it is not memoised. Demo mode simulates its data and setup mode
 * runs no collector: both answer with no environments.
 *
 * @implements FR-COLL-11, FR-SELF-01, HM-030
 */
import type { FastifyInstance } from 'fastify';
import type { Collection } from '@dcam/contracts';
import type { Workspace } from '../workspace';

export function registerCollectionRoutes(app: FastifyInstance, ws: Workspace) {
  app.get('/api/v1/collection', async (): Promise<Collection> => {
    if (ws.mode === 'live' && ws.collection) return ws.collection();
    return { mode: ws.mode, generated_at: new Date(ws.clock.now()).toISOString(), environments: [] };
  });
}
