/**
 * HTTP API and static UI (spec §11.3, §11.9). Binds to loopback only; validates the Host header
 * against DNS rebinding; sends a strict CSP (NFR-SEC-01, NFR-SEC-02). Handlers stay thin: logic
 * lives in @dcam/application (ARCH-EMB-01).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { Meta, Problem } from '@dcam/contracts';
import { getEnvironmentOverview, type OverviewRange } from '@dcam/application';
import type { Workspace } from './demo';

export interface AppOptions extends Workspace {
  readonly version: string;
  /** Exact `host:port` values accepted in the Host header. */
  readonly allowedHosts: readonly string[];
  /** Built web UI (apps/web/dist); omitted in API-only tests. */
  readonly staticDir?: string;
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // MUI (Emotion) injects style elements at runtime.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

const RANGES = new Set<OverviewRange>(['1h', '6h', '24h']);

function problem(reply: FastifyReply, p: Problem) {
  return reply.code(p.status).type('application/problem+json').send(p);
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const hosts = new Set(options.allowedHosts);

  app.addHook('onRequest', async (req, reply) => {
    if (!hosts.has(req.headers.host ?? '')) {
      return problem(reply, {
        type: 'https://github.com/albertols/deep-gcp-airflow-monitoring/blob/main/docs/errors.md#forbidden-host',
        title: 'Forbidden host',
        status: 403,
        detail: 'DCAM only answers requests addressed to its own local address.',
        fix_hint: 'Open DCAM at the URL it printed when it started, for example http://127.0.0.1:8787.',
      });
    }
  });
  app.addHook('onSend', async (_req, reply) => {
    reply.header('content-security-policy', CSP);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
  });

  app.get('/api/v1/health', async () => ({ status: 'ok' as const }));

  app.get('/api/v1/meta', async (): Promise<Meta> => ({
    name: 'DCAM',
    version: options.version,
    mode: options.mode,
    environments: options.environments,
  }));

  app.get<{ Params: { env_id: string }; Querystring: { range?: string } }>(
    '/api/v1/environments/:env_id/overview',
    async (req, reply) => {
      const env = options.environments.find((e) => e.env_id === req.params.env_id);
      if (!env) {
        return problem(reply, {
          type: 'https://github.com/albertols/deep-gcp-airflow-monitoring/blob/main/docs/errors.md#unknown-environment',
          title: 'Unknown environment',
          status: 404,
          detail: `No environment "${req.params.env_id}" is configured in this workspace.`,
          fix_hint: 'Check the environment ID in dcam.config.yaml, or pick one from GET /api/v1/meta.',
        });
      }
      const range = (req.query.range ?? '24h') as OverviewRange;
      if (!RANGES.has(range)) {
        return problem(reply, {
          type: 'https://github.com/albertols/deep-gcp-airflow-monitoring/blob/main/docs/errors.md#invalid-range',
          title: 'Invalid time range',
          status: 400,
          detail: `"${req.query.range}" is not a supported range.`,
          fix_hint: 'Use one of 1h, 6h or 24h.',
        });
      }
      return getEnvironmentOverview(options, {
        envId: env.env_id,
        range,
        sources: options.mode === 'demo' ? ['DEMO'] : ['SRC-AF-API'],
      });
    },
  );

  if (options.staticDir && existsSync(join(options.staticDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: options.staticDir, wildcard: false });
    // Single-page app: unknown non-API paths render the UI.
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api/')
        ? problem(reply, { type: 'about:blank', title: 'Not found', status: 404 })
        : reply.sendFile('index.html'),
    );
  }

  return app;
}
