/**
 * HTTP API and static UI (spec §11.3, §11.9). Binds to loopback only; validates the Host header
 * against DNS rebinding; sends a strict CSP (NFR-SEC-01, NFR-SEC-02). Handlers stay thin: logic
 * lives in @dcam/application (ARCH-EMB-01).
 *
 * @implements NFR-SEC-01, NFR-SEC-02, FR-SETUP-02
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { Meta } from '@dcam/contracts';
import type { SetupState, Workspace } from './workspace';
import { createMemo } from './cache';
import { problem } from './http';
import { alertsFiringFor, registerAlertRoutes } from './routes/alerts';
import { registerBottleneckRoutes } from './routes/bottlenecks';
import { registerCapacityRoutes } from './routes/capacity';
import { registerCollectionRoutes } from './routes/collection';
import { registerCompareRoutes } from './routes/compare';
import { registerDagRoutes } from './routes/dags';
import { dagFindingsFor, findingCountsFor, registerFindingRoutes, topFindingsFor } from './routes/findings';
import { registerFleetRoutes } from './routes/fleet';
import { registerOverviewRoutes } from './routes/overview';
import { registerScheduleRoutes } from './routes/schedule';

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

/** Setup mode in the contract's shape (FR-SETUP-02). */
function setupMeta(setup: SetupState): NonNullable<Meta['setup']> {
  return {
    config_path: setup.configPath,
    ...(setup.configFlag === undefined ? {} : { config_flag: setup.configFlag }),
    issues: setup.issues.map((i) => ({ path: i.path, message: i.message, fix_hint: i.fixHint })),
  };
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
    ...(options.setup ? { setup: setupMeta(options.setup) } : {}),
  }));

  // Aggregated views change once per collection cycle; 15 s matches the UI's stale time. Demo data
  // never changes (its clock is frozen), so results stay cached longer.
  const memo = createMemo({ ttlMs: options.mode === 'demo' ? 10 * 60_000 : 15_000 });
  registerOverviewRoutes(app, options, memo);
  registerDagRoutes(app, options, memo, {
    findingCounts: findingCountsFor(options, memo),
    dagFindings: dagFindingsFor(options, memo),
  });
  registerCompareRoutes(app, options, memo);
  registerBottleneckRoutes(app, options, memo);
  registerScheduleRoutes(app, options, memo);
  registerCapacityRoutes(app, options, memo);
  registerFindingRoutes(app, options, memo);
  registerAlertRoutes(app, options, memo);
  registerFleetRoutes(app, options, memo, {
    topFindings: topFindingsFor(options, memo),
    alertsFiring: alertsFiringFor(options, memo),
  });
  registerCollectionRoutes(app, options);

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
