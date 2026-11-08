/**
 * GET /api/v1/compare/dags?dags=<env>:<dag>,…&range=: 2 to 4 DAGs from the same or different environments side by
 * side (S-14).
 *
 * An item splits at its first colon: environment IDs have none (`^[a-z0-9][a-z0-9-]{0,62}$`), and Airflow DAG IDs
 * match `^[\w.-]+$` (`KEY_REGEX` in `airflow/utils/helpers.py`, ⚠️ VERIFY against the 2.11.1 source), so a comma
 * never occurs inside an item.
 *
 * @implements FR-DAGD-08
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { getDagComparison, type DagRef } from '@dcam/application';
import type { Memo } from '../cache';
import type { Workspace } from '../workspace';
import { notFound, parseRange, problem, sourcesFor } from '../http';

const MIN_DAGS = 2;
const MAX_DAGS = 4;
const MAX_ID_LENGTH = 250;

const invalid = (reply: FastifyReply, detail: string) =>
  problem(reply, {
    type: 'about:blank',
    title: 'Invalid DAG list',
    status: 400,
    detail,
    fix_hint: `List ${MIN_DAGS} to ${MAX_DAGS} different DAGs as env_id:dag_id, separated by commas, for example ?dags=acme-prod:orders_daily,acme-test:orders_daily.`,
  });

/** The DAGs of the `dags` parameter, or `null` after sending a 400 problem. */
function parseDags(reply: FastifyReply, raw: string | undefined): DagRef[] | null {
  if (raw === undefined || raw.trim() === '') {
    void invalid(reply, 'The dags parameter is missing.');
    return null;
  }
  const items: DagRef[] = [];
  for (const part of raw.split(',')) {
    const item = part.trim();
    const colon = item.indexOf(':');
    const envId = colon > 0 ? item.slice(0, colon) : '';
    const dagId = colon > 0 ? item.slice(colon + 1) : '';
    if (!envId || !dagId || dagId.length > MAX_ID_LENGTH) {
      void invalid(reply, `"${item}" is not of the form env_id:dag_id.`);
      return null;
    }
    items.push({ envId, dagId });
  }
  if (items.length < MIN_DAGS || items.length > MAX_DAGS) {
    void invalid(reply, `${items.length} DAGs were listed; compare ${MIN_DAGS} to ${MAX_DAGS}.`);
    return null;
  }
  const keys = new Set(items.map((i) => `${i.envId}:${i.dagId}`));
  if (keys.size < items.length) {
    void invalid(reply, 'A DAG is listed twice.');
    return null;
  }
  return items;
}

export function registerCompareRoutes(app: FastifyInstance, ws: Workspace, memo: Memo) {
  app.get<{ Querystring: { dags?: string; range?: string } }>('/api/v1/compare/dags', async (req, reply) => {
    const items = parseDags(reply, req.query.dags);
    if (!items) return reply;
    const range = parseRange(reply, req.query.range);
    if (!range) return reply;
    for (const { envId } of items)
      if (!ws.environments.some((e) => e.env_id === envId))
        return notFound(reply, 'environment', `No environment "${envId}" is configured in this workspace.`);
    const key = items.map((i) => `${i.envId}:${i.dagId}`).join(',');
    const result = await memo(`compare-dags:${range}:${key}`, () =>
      getDagComparison(ws, { items, range, sources: sourcesFor(ws, ['SRC-AF-API']) }),
    );
    switch (result.kind) {
      case 'ok':
        return result.comparison;
      case 'unknown-environment':
        return notFound(reply, 'environment', `Environment "${result.envId}" has no configuration yet.`);
      case 'unknown-dag':
        return notFound(reply, 'DAG', `No DAG "${result.dagId}" is known in environment "${result.envId}".`);
    }
  });
}
