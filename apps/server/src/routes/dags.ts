/**
 * GET /api/v1/environments/{env_id}/dags and /dags/{dag_id}: the DAG league table and one DAG in detail.
 *
 * @implements FR-DAGX-01, FR-DAGX-02, FR-DAGX-03, FR-DAGD-01, FR-DAGD-02, FR-DAGD-03, FR-DAGD-04
 */
import type { FastifyInstance } from 'fastify';
import { getDagDetail, getDagLeague } from '@dcam/application';
import type { Memo } from '../cache';
import type { Workspace } from '../demo';
import { findEnvironment, notFound, parseRange, problem, sourcesFor } from '../http';

const MAX_ID_LENGTH = 250;

export function registerDagRoutes(app: FastifyInstance, ws: Workspace, memo: Memo) {
  app.get<{ Params: { env_id: string }; Querystring: { range?: string } }>(
    '/api/v1/environments/:env_id/dags',
    async (req, reply) => {
      const env = findEnvironment(ws, reply, req.params.env_id);
      if (!env) return reply;
      const range = parseRange(reply, req.query.range);
      if (!range) return reply;
      return memo(`dags:${env.env_id}:${range}`, () =>
        getDagLeague(ws, { envId: env.env_id, range, sources: sourcesFor(ws, ['SRC-AF-API']) }),
      );
    },
  );

  app.get<{ Params: { env_id: string; dag_id: string }; Querystring: { range?: string; run_id?: string } }>(
    '/api/v1/environments/:env_id/dags/:dag_id',
    async (req, reply) => {
      const env = findEnvironment(ws, reply, req.params.env_id);
      if (!env) return reply;
      const range = parseRange(reply, req.query.range);
      if (!range) return reply;
      const { dag_id: dagId } = req.params;
      const { run_id: runId } = req.query;
      if (runId !== undefined && (runId.length === 0 || runId.length > MAX_ID_LENGTH))
        return problem(reply, {
          type: 'about:blank',
          title: 'Invalid run ID',
          status: 400,
          detail: `A run ID has 1 to ${MAX_ID_LENGTH} characters.`,
          fix_hint: 'Pick a run from the runs list of this DAG, or leave run_id out for the latest run.',
        });
      const result = await getDagDetail(ws, {
        envId: env.env_id,
        dagId,
        range,
        ...(runId === undefined ? {} : { runId }),
        sources: sourcesFor(ws, ['SRC-AF-API']),
      });
      switch (result.kind) {
        case 'ok':
          return result.detail;
        case 'unknown-run':
          return notFound(reply, 'run', `DAG "${dagId}" has no run "${runId}" in the last ${range}.`);
        case 'unknown-dag':
          return notFound(reply, 'DAG', `No DAG "${dagId}" is known in environment "${env.env_id}".`);
        case 'unknown-environment':
          return notFound(reply, 'environment', `Environment "${env.env_id}" has no configuration yet.`);
      }
    },
  );
}
