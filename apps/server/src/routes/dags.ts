/**
 * GET /api/v1/environments/{env_id}/dags, /dags/{dag_id} and /dags/{dag_id}/runs/compare: the DAG league table,
 * one DAG in detail (with its concurrency and impact) and two of its runs compared; GET …/dag-index: the
 * inventory's DAG IDs for the command palette, without task history.
 *
 * @implements FR-DAGX-01, FR-DAGX-02, FR-DAGX-03, FR-DAGD-01, FR-DAGD-02, FR-DAGD-03, FR-DAGD-04, FR-DAGD-05,
 *   FR-DAGD-06, FR-DAGD-09, FR-UI-03
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { FindingRef } from '@dcam/contracts';
import { getDagDetail, getDagIndex, getDagLeague, getRunComparison } from '@dcam/application';
import type { Memo } from '../cache';
import type { Workspace } from '../workspace';
import { findEnvironment, notFound, parseRange, problem, sourcesFor } from '../http';

const MAX_ID_LENGTH = 250;

/** Cross-slice inputs for the league table, wired by the composition root. */
export interface DagProviders {
  /** Open advisor findings per DAG in one environment (FR-DAGX-02). */
  readonly findingCounts?: (envId: string) => Promise<ReadonlyMap<string, number>>;
  /** Open advisor findings about one DAG, for DAG detail (FR-DAGD-01, REC-DAG-01 in FR-DAGD-05). */
  readonly dagFindings?: (envId: string, dagId: string) => Promise<FindingRef[]>;
}

/** A run ID query parameter: 1 to 250 characters; `null` after sending a 400 problem. */
function runIdOf(reply: FastifyReply, name: string, raw: string | undefined, required: boolean) {
  if (raw === undefined && !required) return undefined;
  if (raw !== undefined && raw.length > 0 && raw.length <= MAX_ID_LENGTH) return raw;
  void problem(reply, {
    type: 'about:blank',
    title: 'Invalid run ID',
    status: 400,
    detail: `${name} must be a run ID of 1 to ${MAX_ID_LENGTH} characters.`,
    fix_hint: required
      ? `Pick two runs from the runs list of this DAG, for example ?a=<run_id>&b=<run_id>.`
      : 'Pick a run from the runs list of this DAG, or leave run_id out for the latest run.',
  });
  return null;
}

export function registerDagRoutes(
  app: FastifyInstance,
  ws: Workspace,
  memo: Memo,
  providers: DagProviders = {},
) {
  app.get<{ Params: { env_id: string }; Querystring: { range?: string } }>(
    '/api/v1/environments/:env_id/dags',
    async (req, reply) => {
      const env = findEnvironment(ws, reply, req.params.env_id);
      if (!env) return reply;
      const range = parseRange(reply, req.query.range);
      if (!range) return reply;
      return memo(`dags:${env.env_id}:${range}`, async () =>
        getDagLeague(ws, {
          envId: env.env_id,
          range,
          sources: sourcesFor(ws, ['SRC-AF-API']),
          ...(providers.findingCounts ? { openFindings: await providers.findingCounts(env.env_id) } : {}),
        }),
      );
    },
  );

  app.get<{ Params: { env_id: string } }>('/api/v1/environments/:env_id/dag-index', async (req, reply) => {
    const env = findEnvironment(ws, reply, req.params.env_id);
    if (!env) return reply;
    return memo(`dag-index:${env.env_id}`, () => getDagIndex(ws, { envId: env.env_id }));
  });

  app.get<{ Params: { env_id: string; dag_id: string }; Querystring: { range?: string; run_id?: string } }>(
    '/api/v1/environments/:env_id/dags/:dag_id',
    async (req, reply) => {
      const env = findEnvironment(ws, reply, req.params.env_id);
      if (!env) return reply;
      const range = parseRange(reply, req.query.range);
      if (!range) return reply;
      const { dag_id: dagId } = req.params;
      const { dagFindings } = providers;
      const runId = runIdOf(reply, 'run_id', req.query.run_id, false);
      if (runId === null) return reply;
      const result = await getDagDetail(ws, {
        envId: env.env_id,
        dagId,
        range,
        ...(runId === undefined ? {} : { runId }),
        sources: sourcesFor(ws, ['SRC-AF-API', 'SRC-MON']),
        ...(dagFindings ? { loadFindings: () => dagFindings(env.env_id, dagId) } : {}),
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
  app.get<{
    Params: { env_id: string; dag_id: string };
    Querystring: { a?: string; b?: string; range?: string };
  }>('/api/v1/environments/:env_id/dags/:dag_id/runs/compare', async (req, reply) => {
    const env = findEnvironment(ws, reply, req.params.env_id);
    if (!env) return reply;
    const a = runIdOf(reply, 'a', req.query.a, true);
    if (!a) return reply;
    const b = runIdOf(reply, 'b', req.query.b, true);
    if (!b) return reply;
    const range = parseRange(reply, req.query.range ?? '7d');
    if (!range) return reply;
    const { dag_id: dagId } = req.params;
    const result = await memo(`runs-compare:${env.env_id}:${range}:${dagId}\u0000${a}\u0000${b}`, () =>
      getRunComparison(ws, {
        envId: env.env_id,
        dagId,
        a,
        b,
        range,
        sources: sourcesFor(ws, ['SRC-AF-API']),
      }),
    );
    switch (result.kind) {
      case 'ok':
        return result.comparison;
      case 'unknown-run':
        return notFound(
          reply,
          'run',
          `DAG "${dagId}" has no run "${result.runId}" with a task that started in the last ${range}.`,
        );
      case 'unknown-dag':
        return notFound(reply, 'DAG', `No DAG "${dagId}" is known in environment "${env.env_id}".`);
      case 'unknown-environment':
        return notFound(reply, 'environment', `Environment "${env.env_id}" has no configuration yet.`);
    }
  });
}
