/**
 * GET /api/v1/environments/{env_id}/findings (FR-ADV-01..04, FR-ADV-08). Read-only: remediation
 * snippets are returned as text for people to review and apply; DCAM never runs them (FR-ADV-03).
 */
import type { FastifyInstance } from 'fastify';
import type { FindingRef, Findings } from '@dcam/contracts';
import { countFindingsByDag, getFindings } from '@dcam/application';
import type { Memo } from '../cache';
import type { Workspace } from '../workspace';
import { findEnvironment, sourcesFor } from '../http';

/** The (memoised) advisor findings of one environment, shared with the fleet and league views. */
export function findingsFor(ws: Workspace, memo: Memo) {
  return (envId: string): Promise<Findings> =>
    memo(`findings:${envId}`, () =>
      getFindings(ws, { envId, sources: sourcesFor(ws, ['SRC-AF-API', 'SRC-MON', 'SRC-COMPOSER']) }),
    );
}

/** The highest-priority findings of one environment, for its fleet card (FR-FLEET-01). */
export function topFindingsFor(ws: Workspace, memo: Memo) {
  const findings = findingsFor(ws, memo);
  return async (envId: string): Promise<FindingRef[]> =>
    (await findings(envId)).findings.map(({ id, rule_id, title, severity }) => ({
      id,
      rule_id,
      title,
      severity,
    }));
}

/** Open findings that name one DAG among their affected DAGs, for DAG detail (FR-DAGD-01, FR-DAGD-05). */
export function dagFindingsFor(ws: Workspace, memo: Memo) {
  const findings = findingsFor(ws, memo);
  return async (envId: string, dagId: string): Promise<FindingRef[]> =>
    (await findings(envId)).findings
      .filter((f) => f.affected_dags.includes(dagId))
      .map(({ id, rule_id, title, severity }) => ({ id, rule_id, title, severity }));
}

/** Open findings per DAG of one environment, for the league table (FR-DAGX-02). */
export function findingCountsFor(ws: Workspace, memo: Memo) {
  const findings = findingsFor(ws, memo);
  return async (envId: string): Promise<Map<string, number>> =>
    countFindingsByDag((await findings(envId)).findings);
}

export function registerFindingRoutes(app: FastifyInstance, ws: Workspace, memo: Memo) {
  const findings = findingsFor(ws, memo);
  app.get<{ Params: { env_id: string } }>('/api/v1/environments/:env_id/findings', async (req, reply) => {
    const env = findEnvironment(ws, reply, req.params.env_id);
    if (!env) return reply;
    return findings(env.env_id);
  });
}
