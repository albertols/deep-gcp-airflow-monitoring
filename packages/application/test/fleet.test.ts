import { describe, expect, it } from 'vitest';
import type { EnvironmentConfig, LiveSnapshot, PlatformHealth } from '@dcam/domain';
import type { EnvironmentModelSource, StoredTaskTry, TaskInstanceStore } from '@dcam/ports';
import { getFleet } from '../src/index';

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const config = (envId: string, tier: EnvironmentConfig['tier']): EnvironmentConfig => ({
  envId,
  tier,
  composerImage: 'composer-3-airflow-2.11.1-build.22',
  airflowVersion: '2.11.1',
  parallelism: 100,
  schedulers: 1,
  maxActiveTasksPerDag: 16,
  maxActiveRunsPerDag: 25,
  workerConcurrency: 4,
  minWorkers: 1,
  maxWorkers: 3,
  pools: [{ name: 'default_pool', slots: 128 }],
});
const health: PlatformHealth = {
  envHealthyRatio: 1,
  dbHealthyRatio: 1,
  heartbeatCompleteness: 1,
  webServerHealthyRatio: 1,
  dbCpuMemoryMax: 0.3,
  zombies24h: 0,
  workerRestarts24h: 3,
  importErrors: 0,
  parseLoopP95Seconds: 60,
};
const snapshot: LiveSnapshot = {
  at: NOW - 30_000,
  scheduled: [],
  queued: [],
  pools: [{ name: 'default_pool', slots: 128, running: 5, queued: 2, open: 121 }],
  dagActive: {},
  executor: { running: 5, queued: 2 },
  workers: { current: 2, target: 2 },
};
const tryOf = (state: string, i: number): StoredTaskTry => ({
  envId: 'acme-prod',
  dagId: 'orders_daily',
  runId: 'r',
  taskId: `t${i}`,
  mapIndex: -1,
  tryNumber: 1,
  pool: 'default_pool',
  poolSlots: 1,
  state,
  readyAt: NOW - 3_700_000,
  queuedAt: NOW - 3_650_000,
  startAt: NOW - 3_600_000,
  endAt: NOW - 1_800_000,
  sourceUpdatedAt: NOW - 1_800_000,
  operator: 'PythonOperator',
});
const store: TaskInstanceStore = {
  upsertTaskTries: async () => {},
  taskTries: async (envId) => (envId === 'acme-prod' ? [tryOf('success', 1), tryOf('failed', 2)] : []),
  countTaskTries: async () => 0,
};
const model: EnvironmentModelSource = {
  config: async (id) =>
    id === 'acme-prod' ? config(id, 'prod') : id === 'acme-dev' ? config(id, 'dev') : null,
  dags: async () => [],
  snapshots: async (id) => (id === 'acme-prod' ? [snapshot] : []),
  workerSamples: async () => [],
  platformHealth: async () => health,
};
const deps = { store, model, clock: { now: () => NOW } };
const environments = [
  { env_id: 'acme-prod', display_name: 'acme-prod', tier: 'prod' as const },
  { env_id: 'acme-dev', display_name: 'acme-dev', tier: 'dev' as const },
];

describe('getFleet use case (FR-FLEET-01/02, HM-028)', () => {
  it('FR-FLEET-01: one card per environment with live load, workers, failures and slot time', async () => {
    const fleet = await getFleet(deps, { environments, sources: ['DEMO'] });
    expect(fleet.environments.map((e) => e.env_id)).toEqual(['acme-prod', 'acme-dev']);
    expect(fleet.environments[0]).toMatchObject({
      running: 5,
      queued: 2,
      workers: { current: 2, min: 1, max: 3 },
      failures_24h: 1,
      slot_seconds_24h: 2 * 1_800,
      composer_image: 'composer-3-airflow-2.11.1-build.22',
    });
  });

  it('FR-FLEET-02 / HM-028: each card carries the explainable health score', async () => {
    const [prod] = (await getFleet(deps, { environments, sources: ['DEMO'] })).environments;
    expect(prod?.health).toMatchObject({ score: 95, label: 'healthy', evaluated: 9, total: 9 });
    expect(prod?.health.checks.find((c) => c.id === 'worker-restarts')?.state).toBe('fail');
  });

  it('FR-FLEET-01: adds the top findings and firing alerts when providers are given', async () => {
    const fleet = await getFleet(deps, {
      environments,
      sources: ['DEMO'],
      topFindings: async (id) =>
        id === 'acme-prod'
          ? [{ id: 'f1', rule_id: 'REC-CAP-01', title: 'Workers at max', severity: 'critical' }]
          : [],
      alertsFiring: async (id) => (id === 'acme-prod' ? 2 : 0),
    });
    expect(fleet.environments[0]).toMatchObject({
      alerts_firing: 2,
      top_findings: [{ rule_id: 'REC-CAP-01' }],
    });
    expect(fleet.environments[1]).toMatchObject({ alerts_firing: 0, top_findings: [] });
  });

  it('shows an environment without live data with zero load instead of failing', async () => {
    const dev = (await getFleet(deps, { environments, sources: ['DEMO'] })).environments[1];
    expect(dev).toMatchObject({ running: 0, queued: 0, workers: { current: 0 }, top_reason: null });
  });
});
