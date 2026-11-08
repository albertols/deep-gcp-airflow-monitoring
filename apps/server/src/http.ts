/**
 * Shared HTTP helpers for route modules: RFC 9457 problems, environment lookup and range parsing.
 */
import type { FastifyReply } from 'fastify';
import type { CapacityRange, Meta, Problem, Range, SourceId } from '@dcam/contracts';
import { RANGES } from '@dcam/application';
import type { Workspace } from './workspace';

const ERRORS = 'https://github.com/albertols/deep-gcp-airflow-monitoring/blob/main/docs/errors.md';
/** "15m, 1h, 6h, 24h, 7d, 30d or 90d". */
const listed = (xs: readonly string[]) =>
  xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} or ${xs.at(-1) ?? ''}`;

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

/** The capacity page's ranges (`CapacityRange`): up to 7 days, the longest its per-minute analysis reads. */
export const CAPACITY_RANGES: ReadonlySet<CapacityRange> = new Set<CapacityRange>(['1h', '6h', '24h', '7d']);
/** The global range presets (FR-UI-01). */
const PRESETS: ReadonlySet<Range> = new Set(RANGES);

/** The requested range (24 h by default) among `allowed`, or `null` after sending a 400 problem. */
export function parseRange(reply: FastifyReply, raw: string | undefined): Range | null;
export function parseRange<R extends string>(
  reply: FastifyReply,
  raw: string | undefined,
  allowed: ReadonlySet<R>,
): R | null;
export function parseRange(
  reply: FastifyReply,
  raw: string | undefined,
  allowed: ReadonlySet<string> = PRESETS,
): string | null {
  const range = raw ?? '24h';
  if (allowed.has(range)) return range;
  void problem(reply, {
    type: `${ERRORS}#invalid-range`,
    title: 'Invalid time range',
    status: 400,
    detail: `"${raw}" is not a supported range.`,
    fix_hint: `Use one of ${listed([...allowed])}.`,
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
