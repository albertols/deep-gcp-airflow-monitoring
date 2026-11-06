import { describe, expect, it } from 'vitest';
import type { SourceId } from '@dcam/contracts';
import type { EnvironmentConfig, LiveSnapshot, PlatformHealth, WorkerSample } from '@dcam/domain';
import type { EnvironmentModelSource, TaskInstanceStore } from '@dcam/ports';
import { getAlerts, getBottlenecks, getFindings, getFleet } from '../src/index';

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const ALL: readonly SourceId[] = ['SRC-AF-API', 'SRC-MON', 'SRC-COMPOSER'];

/** A self-managed Airflow (the emulator): limits from the configuration file, no Composer API. */
const selfManaged: EnvironmentConfig = {
  envId: 'acme-emulator',
  tier: 'dev',
  composerImage: 'none (self-managed Airflow)',
  airflowVersion: '2.11.1',
  parallelism: 32,
  schedulers: 1,
  maxActiveTasksPerDag: 16,
  maxActiveRunsPerDag: 16,
  workerConcurrency: 4,
  minWorkers: 1,
  maxWorkers: 1,
  pools: [{ name: 'default_pool', slots: 128 }],
  limitSources: {
    parallelism: 'configured',
    workerConcurrency: 'configured',
    maxActiveTasksPerDag: 'configured',
    maxActiveRunsPerDag: 'configured',
  },
};
/** A Composer environment: limits from overrides and documented defaults. */
const composer: EnvironmentConfig = {
  ...selfManaged,
  envId: 'acme-composer-prod',
  composerImage: 'composer-3-airflow-2.11.1-build.22',
  limitSources: {
    parallelism: 'unknown',
    workerConcurrency: 'override',
    maxActiveTasksPerDag: 'composer-default',
    maxActiveRunsPerDag: 'composer-default',
  },
};
const snapshots: LiveSnapshot[] = Array.from({ length: 10 }, (_, i) => ({
  at: NOW - 10 * 30_000 + i * 30_000,
  scheduled: [],
  queued: [],
  pools: [],
  dagActive: {},
  executor: { running: 1, queued: 0 },
  workers: { current: 1, target: 1 },
}));
const samples: WorkerSample[] = Array.from({ length: 5 }, (_, i) => ({
  at: NOW - 5 * 60_000 + i * 60_000,
  workers: 1,
  target: 1,
  running: 1,
  queued: 0,
  cpu: 0.1,
  memory: 0.2,
}));
const noHealth: PlatformHealth = {
  envHealthyRatio: null,
  dbHealthyRatio: null,
  heartbeatCompleteness: null,
  webServerHealthyRatio: null,
  dbCpuMemoryMax: null,
  zombies24h: null,
  workerRestarts24h: null,
  // Import errors come from the Airflow API (af.inventory), not Cloud Monitoring.
  importErrors: 1,
  parseLoopP95Seconds: null,
};
const store: TaskInstanceStore = {
  upsertTaskTries: async () => {},
  taskTries: async () => [],
  countTaskTries: async () => 0,
};
const depsFor = (config: EnvironmentConfig, withSamples: boolean) => {
  const model: EnvironmentModelSource = {
    config: async () => config,
    dags: async () => [],
    snapshots: async (_id, from, to) => snapshots.filter((s) => s.at >= from && s.at < to),
    workerSamples: async (_id, from, to) =>
      withSamples ? samples.filter((s) => s.at >= from && s.at < to) : [],
    platformHealth: async () =>
      withSamples ? { ...noHealth, envHealthyRatio: 1, dbHealthyRatio: 1 } : noHealth,
  };
  return { store, model, clock: { now: () => NOW } };
};

describe('FR-UI-08 provenance lists only the sources that contributed data', () => {
  it('FR-UI-08: an environment with only the Airflow API names only the Airflow REST API', async () => {
    const deps = depsFor(selfManaged, false);
    const envId = selfManaged.envId;
    expect((await getBottlenecks(deps, { envId, range: '1h', sources: ALL })).sources).toEqual([
      'SRC-AF-API',
    ]);
    expect((await getFindings(deps, { envId, sources: ALL })).sources).toEqual(['SRC-AF-API']);
    expect((await getAlerts(deps, { envIds: [envId], sources: ALL })).sources).toEqual(['SRC-AF-API']);
    const fleet = await getFleet(deps, {
      environments: [{ env_id: envId, display_name: envId, tier: 'dev' }],
      sources: ALL,
    });
    expect(fleet.sources).toEqual(['SRC-AF-API']);
  });

  it('FR-UI-08: a Composer environment with Cloud Monitoring data names all three', async () => {
    const deps = depsFor(composer, true);
    const b = await getBottlenecks(deps, { envId: composer.envId, range: '1h', sources: ALL });
    expect(b.sources).toEqual(ALL);
  });

  it('FR-UI-08: demo mode stays "demo data"', async () => {
    const b = await getBottlenecks(depsFor(composer, true), {
      envId: composer.envId,
      range: '1h',
      sources: ['DEMO'],
    });
    expect(b.sources).toEqual(['DEMO']);
  });
});
