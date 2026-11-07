import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';
import { createCollectionEngine, type Collector, type CollectorManifest } from '@dcam/application';
import {
  SourceError,
  type AirflowApi,
  type CollectionStore,
  type ProfileCadences,
  type Sleeper,
  type WorkspaceConfig,
} from '@dcam/ports';

const spec = parse(
  readFileSync(fileURLToPath(import.meta.resolve('@dcam/contracts/openapi.yaml')), 'utf8'),
) as Record<string, unknown>;
const ajv = new Ajv2020({ strict: false });
addFormats.default(ajv);
ajv.addSchema({ ...spec, $id: 'dcam' });
const conforms = (schema: string, body: unknown) => {
  const validate = ajv.getSchema(`dcam#/components/schemas/${schema}`);
  if (!validate) throw new Error(`no schema ${schema}`);
  return validate(body) ? true : validate.errors;
};

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const cadences: ProfileCadences = {
  airflowLive: 30,
  airflowFacts: 60,
  airflowInventory: 3600,
  monitoring: 60,
  composer: 600,
};
const config: WorkspaceConfig = {
  path: '/home/acme/dcam.config.yaml',
  dataDir: '/home/acme/.dcam/data',
  quotaProjectId: null,
  caBundlePath: null,
  profiles: { live: cadences, standard: cadences, eco: cadences },
  budgets: {
    airflowApi: { live: 60, standard: 12, eco: 4, background: 2, maxConcurrent: 2 },
    monitoringPerProjectPerMinute: 30,
    composerApiPerMinute: 6,
  },
  environments: [
    {
      id: 'acme-composer-prod',
      displayName: 'acme-composer-prod',
      tier: 'prod',
      profile: 'standard',
      source: {
        kind: 'composer',
        projectId: 'acme-prod-123',
        location: 'europe-west1',
        environment: 'acme-composer-prod',
      },
    },
    {
      id: 'acme-emulator',
      displayName: 'acme-emulator',
      tier: 'dev',
      profile: 'live',
      source: {
        kind: 'airflow',
        baseUrl: 'http://127.0.0.1:8080/api/v1',
        usernameEnv: 'DCAM_EMULATOR_USER',
        passwordEnv: 'DCAM_EMULATOR_PASSWORD',
        limits: {
          parallelism: 32,
          schedulers: 1,
          maxActiveTasksPerDag: 16,
          maxActiveRunsPerDag: 16,
          workerConcurrency: 16,
          workers: 1,
        },
      },
    },
    {
      id: 'acme-composer-dev',
      displayName: 'acme-composer-dev',
      tier: 'dev',
      profile: 'off',
      source: {
        kind: 'composer',
        projectId: 'acme-dev-456',
        location: 'europe-west1',
        environment: 'acme-composer-dev',
      },
    },
  ],
};

const airflow: AirflowApi = {
  version: async () => ({ version: '2.11.1' }),
  health: async () => ({ metadatabase: 'healthy', scheduler: { status: 'healthy', latestHeartbeat: NOW } }),
  dags: async () => ({ items: [], total: 0 }),
  pools: async () => [],
  importErrorCount: async () => 0,
  taskInstances: async () => ({ items: [], total: 0 }),
  canReadProviders: async () => false,
};

const manifest = (
  m: Pick<CollectorManifest, 'id' | 'source' | 'api' | 'cadence' | 'sourceKinds'>,
): CollectorManifest => ({
  priority: 'standard',
  maxRequestsPerCycle: 5,
  outputs: ['health'],
  ...m,
});

const collectors: Collector[] = [
  {
    manifest: manifest({
      id: 'composer.config',
      source: 'SRC-COMPOSER',
      api: 'composer',
      cadence: 'composer',
      sourceKinds: ['composer'],
    }),
    collect: async (ctx) => {
      await ctx.composer?.environment({
        projectId: 'acme-prod-123',
        location: 'europe-west1',
        environment: 'acme',
      });
      return { dataAsOf: ctx.now() };
    },
  },
  {
    manifest: manifest({
      id: 'af.live',
      source: 'SRC-AF-API',
      api: 'airflow',
      cadence: 'airflowLive',
      sourceKinds: ['composer', 'airflow'],
    }),
    collect: async (ctx) => {
      await ctx.airflow().pools();
      return { dataAsOf: ctx.now() - 5_000 };
    },
  },
  {
    manifest: manifest({
      id: 'mon.core',
      source: 'SRC-MON',
      api: 'monitoring',
      cadence: 'monitoring',
      sourceKinds: ['composer'],
    }),
    collect: async (ctx) => {
      await ctx.monitoring?.series({
        projectId: 'acme-prod-123',
        metricType: 'composer.googleapis.com/environment/num_celery_workers',
        resourceType: 'cloud_composer_environment',
        resourceLabels: {},
        from: NOW - 600_000,
        to: NOW,
        alignmentPeriodSeconds: 60,
        aligner: 'ALIGN_MAX',
      });
      ctx.countSeries(3);
      return { dataAsOf: null };
    },
  },
  {
    manifest: {
      ...manifest({
        id: 'af.backfill',
        source: 'SRC-AF-API',
        api: 'airflow',
        cadence: 'airflowFacts',
        sourceKinds: ['composer', 'airflow'],
      }),
      priority: 'background',
      outputs: ['tries'],
      backfill: 'task_instances',
    },
    collect: async (ctx) => {
      await ctx.airflow().taskInstances({ limit: 100, offset: 0 });
      ctx.reportBackfill({
        state: 'running',
        days: 7,
        from: NOW - 7 * 86_400_000,
        to: NOW - 60_000,
        coveredFrom: NOW - 3 * 86_400_000,
        itemsRead: 81_250,
        requestsUsed: 1_090,
        etaSeconds: 21_600,
      });
      return { dataAsOf: null };
    },
  },
];

/** Sleeps end only when the engine aborts them (on stop). */
const sleeper: Sleeper = {
  sleep: (_ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      signal?.addEventListener('abort', () => resolve());
    }),
};

describe('collection status (FR-COLL-11, FR-SELF-01, HM-030)', () => {
  it('FR-SELF-01: the engine status conforms to the Collection contract', async () => {
    const engine = createCollectionEngine({
      config,
      store: {} as CollectionStore,
      clock: { now: () => NOW },
      sleeper,
      sources: () => ({
        airflow: () => airflow,
        composer: {
          environment: async () => {
            throw new SourceError('forbidden', 'The account may not read the environment.', {
              status: 403,
              fixHint: 'Grant roles/composer.user on acme-prod-123.',
            });
          },
        },
        monitoring: { series: async () => [] },
      }),
      collectors,
    });
    engine.recordRequest('acme-composer-prod', 'composer', {
      at: NOW,
      status: 403,
      latencyMs: 210,
      bytes: 320,
    });
    engine.recordRequest('acme-composer-prod', 'monitoring', {
      at: NOW,
      status: 200,
      latencyMs: 95,
      bytes: 2_048,
    });
    engine.recordRequest('acme-emulator', 'airflow', { at: NOW, status: null, latencyMs: 10_000, bytes: 0 });
    engine.start();
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));

    const status = engine.status();
    expect(conforms('Collection', status)).toBe(true);
    // The schema is strict: a field the contract does not define is refused.
    const env = status.environments[0]!;
    expect(conforms('Collection', { ...status, environments: [{ ...env, extra: 1 }] })).not.toBe(true);
    const byId = new Map(status.environments.map((e) => [e.env_id, e]));
    const states = (envId: string) =>
      Object.fromEntries(byId.get(envId)!.collectors.map((c) => [c.id, c.state]));
    expect(states('acme-composer-prod')).toEqual({
      'composer.config': 'degraded',
      'af.live': 'waiting',
      'mon.core': 'ok',
      'af.backfill': 'waiting',
    });
    expect(states('acme-emulator')).toEqual({
      'composer.config': 'disabled',
      'af.live': 'ok',
      'mon.core': 'disabled',
      'af.backfill': 'ok',
    });
    expect(states('acme-composer-dev')).toEqual({
      'composer.config': 'disabled',
      'af.live': 'disabled',
      'mon.core': 'disabled',
      'af.backfill': 'disabled',
    });
    // FR-COLL-04: backfill progress, waiting before the first report; none while collection is off.
    expect(byId.get('acme-composer-prod')?.backfill).toMatchObject([{ state: 'waiting', days: 7 }]);
    expect(byId.get('acme-emulator')?.backfill).toEqual([
      {
        collector_id: 'af.backfill',
        kind: 'task_instances',
        state: 'running',
        days: 7,
        from: new Date(NOW - 7 * 86_400_000).toISOString(),
        to: new Date(NOW - 60_000).toISOString(),
        covered_from: new Date(NOW - 3 * 86_400_000).toISOString(),
        items_read: 81_250,
        requests_used: 1_090,
        eta_seconds: 21_600,
      },
    ]);
    expect(byId.get('acme-composer-dev')?.backfill).toEqual([]);
    const backfill = byId.get('acme-emulator')?.backfill?.[0];
    expect(
      conforms('Collection', {
        ...status,
        environments: [{ ...env, backfill: [{ ...backfill, extra: 1 }] }],
      }),
    ).not.toBe(true);
    expect(byId.get('acme-composer-prod')?.series_24h).toBe(3);
    expect(byId.get('acme-emulator')?.series_24h).toBeNull();
    expect(byId.get('acme-emulator')?.footprint).toEqual([
      {
        api: 'airflow',
        budget_per_minute: 60,
        requests_1h: 1,
        requests_24h: 1,
        errors_24h: 1,
        bytes_24h: 0,
        p95_latency_ms: 10_000,
      },
    ]);
    await engine.stop();
  });
});
