/**
 * HTTP API and static UI (spec §11.3, §11.9). Binds to loopback only; validates the Host header
 * against DNS rebinding; sends a strict CSP (NFR-SEC-01, NFR-SEC-02). Handlers stay thin: logic
 * lives in @dcam/application (ARCH-EMB-01).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { Meta } from '@dcam/contracts';
import type { Workspace } from './demo';
import { problem } from './http';
import { registerAlertRoutes } from './routes/alerts';
import { registerBottleneckRoutes } from './routes/bottlenecks';
import { registerDagRoutes } from './routes/dags';
import { registerFindingRoutes } from './routes/findings';
import { registerFleetRoutes } from './routes/fleet';
import { registerOverviewRoutes } from './routes/overview';

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

  registerOverviewRoutes(app, options);
  registerDagRoutes(app, options);
  registerBottleneckRoutes(app, options);
  registerFindingRoutes(app, options);
  registerAlertRoutes(app, options);
  registerFleetRoutes(app, options);

  if (options.staticDir && existsSync(join(options.staticDir, 'index.html'))) {
    // Files are looked up per request, so a rebuilt UI is served without a restart.
    await app.register(fastifyStatic, { root: options.staticDir, wildcard: true });
    // Single-page app: unknown routes render the UI; unknown API paths and missing files are 404s,
    // so a stale bundle never receives HTML in place of JavaScript.
    app.setNotFoundHandler((req, reply) => {
      const path = req.url.split('?')[0] ?? '';
      const isFile = /\.[a-z0-9]+$/i.test(path);
      return path.startsWith('/api/') || isFile
        ? problem(reply, { type: 'about:blank', title: 'Not found', status: 404 })
        : reply.sendFile('index.html');
    });
  }

  return app;
}
