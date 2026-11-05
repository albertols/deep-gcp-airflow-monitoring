/** GET /api/v1/fleet (FR-FLEET-01/02, HM-028). */
import type { FastifyInstance } from 'fastify';
import type { FindingRef } from '@dcam/contracts';
import { getFleet } from '@dcam/application';
import type { Workspace } from '../demo';
import { sourcesFor } from '../http';

/** Cross-slice inputs for the fleet cards, wired by the composition root. */
export interface FleetProviders {
  readonly topFindings?: (envId: string) => Promise<FindingRef[]>;
  readonly alertsFiring?: (envId: string) => Promise<number>;
}

export function registerFleetRoutes(app: FastifyInstance, ws: Workspace, providers: FleetProviders = {}) {
  app.get('/api/v1/fleet', async () =>
    getFleet(ws, {
      environments: ws.environments,
      sources: sourcesFor(ws, ['SRC-AF-API', 'SRC-MON', 'SRC-COMPOSER']),
      ...providers,
    }),
  );
}
