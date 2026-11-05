/** GET /api/v1/fleet (FR-FLEET-01/02, HM-028). */
import type { FastifyInstance } from 'fastify';
import type { FindingRef } from '@dcam/contracts';
import { getFleet } from '@dcam/application';
import type { Memo } from '../cache';
import type { Workspace } from '../workspace';
import { sourcesFor } from '../http';
import { bottlenecksFor } from './bottlenecks';

/** Cross-slice inputs for the fleet cards, wired by the composition root. */
export interface FleetProviders {
  readonly topFindings?: (envId: string) => Promise<FindingRef[]>;
  readonly alertsFiring?: (envId: string) => Promise<number>;
}

export function registerFleetRoutes(
  app: FastifyInstance,
  ws: Workspace,
  memo: Memo,
  providers: FleetProviders = {},
) {
  const analyse = bottlenecksFor(ws, memo);
  app.get('/api/v1/fleet', async () =>
    memo('fleet', () =>
      getFleet(ws, {
        environments: ws.environments,
        sources: sourcesFor(ws, ['SRC-AF-API', 'SRC-MON', 'SRC-COMPOSER']),
        bottlenecks: (envId) => analyse(envId, '24h'),
        ...providers,
      }),
    ),
  );
}
