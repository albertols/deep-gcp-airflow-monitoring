/**
 * Shared HTTP helpers for route modules: RFC 9457 problems, environment lookup and range parsing.
 */
import type { FastifyReply } from 'fastify';
import type { Meta, Problem, Range, SourceId } from '@dcam/contracts';
import type { Workspace } from './workspace';

const ERRORS = 'https://github.com/albertols/deep-gcp-airflow-monitoring/blob/main/docs/errors.md';
const RANGES: ReadonlySet<string> = new Set<Range>(['1h', '6h', '24h']);

export function problem(reply: FastifyReply, p: Problem) {
  return reply.code(p.status).type('application/problem+json').send(p);
}

export type Environment = Meta['environments'][number];

/** The configured environment, or `null` after sending a 404 problem. */
export function findEnvironment(ws: Workspace, reply: FastifyReply, envId: string): Environment | null {
  const env = ws.environments.find((e) => e.env_id === envId);
  if (env) return env;
  void problem(reply, {
    type: `${ERRORS}#unknown-environment`,
    title: 'Unknown environment',
    status: 404,
    detail: `No environment "${envId}" is configured in this workspace.`,
    fix_hint: 'Check the environment ID in dcam.config.yaml, or pick one from GET /api/v1/meta.',
  });
  return null;
}

/** The requested range (24 h by default), or `null` after sending a 400 problem. */
export function parseRange(reply: FastifyReply, raw: string | undefined): Range | null {
  const range = raw ?? '24h';
  if (RANGES.has(range)) return range as Range;
  void problem(reply, {
    type: `${ERRORS}#invalid-range`,
    title: 'Invalid time range',
    status: 400,
    detail: `"${raw}" is not a supported range.`,
    fix_hint: 'Use one of 1h, 6h or 24h.',
  });
  return null;
}

export function notFound(reply: FastifyReply, what: string, detail: string) {
  return problem(reply, { type: `${ERRORS}#not-found`, title: `Unknown ${what}`, status: 404, detail });
}

/** Where the data comes from, for provenance footers (FR-UI-08). */
export function sourcesFor(ws: Workspace, live: readonly SourceId[]): SourceId[] {
  return ws.mode === 'demo' ? ['DEMO'] : [...live];
}

/** Placeholder for an endpoint whose slice is not implemented yet. */
export function notImplemented(reply: FastifyReply, what: string) {
  return problem(reply, {
    type: `${ERRORS}#not-implemented`,
    title: 'Not implemented yet',
    status: 501,
    detail: `${what} is not available in this build.`,
  });
}
