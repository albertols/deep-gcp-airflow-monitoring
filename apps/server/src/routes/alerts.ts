/**
 * GET /api/v1/alerts (FR-ALRT-01/02/06): local alert rules, their states and 24 h history, for every
 * environment or the one in `env_id`. Read-only: DCAM alerts locally and creates nothing in Cloud
 * Monitoring (spec §18.2).
 */
import type { FastifyInstance } from 'fastify';
import type { Alerts } from '@dcam/contracts';
import { getAlerts } from '@dcam/application';
import type { Memo } from '../cache';
import type { Workspace } from '../workspace';
import { findEnvironment, sourcesFor } from '../http';

/** The (memoised) alert evaluation for a set of environments, shared with the fleet view. */
export function alertsFor(ws: Workspace, memo: Memo) {
  return (envIds: readonly string[]): Promise<Alerts> =>
    memo(`alerts:${envIds.join(',')}`, () =>
      getAlerts(ws, { envIds, sources: sourcesFor(ws, ['SRC-AF-API', 'SRC-MON', 'SRC-COMPOSER']) }),
    );
}

/** Alerts firing in one environment, counted from the all-environments evaluation the page shows. */
export function alertsFiringFor(ws: Workspace, memo: Memo) {
  const evaluate = alertsFor(ws, memo);
  return async (envId: string): Promise<number> => {
    const all = await evaluate(ws.environments.map((e) => e.env_id));
    return all.rules.filter((r) => r.env_id === envId && r.state === 'firing').length;
  };
}

export function registerAlertRoutes(app: FastifyInstance, ws: Workspace, memo: Memo) {
  const evaluate = alertsFor(ws, memo);
  app.get<{ Querystring: { env_id?: string } }>('/api/v1/alerts', async (req, reply) => {
    const requested = req.query.env_id;
    let envIds = ws.environments.map((e) => e.env_id);
    if (requested !== undefined) {
      const env = findEnvironment(ws, reply, requested);
      if (!env) return reply;
      envIds = [env.env_id];
    }
    return evaluate(envIds);
  });
}
