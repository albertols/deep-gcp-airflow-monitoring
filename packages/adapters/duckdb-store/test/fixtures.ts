/** Fictitious `acme` model values (spec §18.12) for store round trips. Times are not whole seconds on purpose. */
import type { DagMeta, EnvironmentConfig, LiveSnapshot, PlatformHealth, WorkerSample } from '@dcam/domain';
import type { StoredTaskTry } from '@dcam/ports';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';

export const ENV = 'acme-prod';
export const T0 = Date.UTC(2026, 10, 1) + 123;

export const tryRow = (over: Partial<StoredTaskTry> = {}): StoredTaskTry => ({
  envId: ENV,
  dagId: 'acme_orders_daily',
  runId: 'scheduled__2026-11-01T00:00:00+00:00',
  taskId: 'load',
  mapIndex: -1,
  tryNumber: 1,
  pool: 'default_pool',
  poolSlots: 1,
  state: 'success',
  queuedAt: T0 - 5_001,
  startAt: T0,
  endAt: T0 + 60_007,
  sourceUpdatedAt: T0 + 60_007,
  readyAt: null,
  operator: 'PythonOperator',
  ...over,
});

export const config = (over: Partial<EnvironmentConfig> = {}): EnvironmentConfig => ({
  envId: ENV,
  tier: 'prod',
  composerImage: 'composer-3-airflow-2.11.1',
  airflowVersion: '2.11.1',
  parallelism: 96,
  schedulers: 2,
  maxActiveTasksPerDag: 16,
  maxActiveRunsPerDag: 16,
  workerConcurrency: 12,
  minWorkers: 1,
  maxWorkers: 8,
  pools: [
    { name: 'default_pool', slots: 128 },
    { name: 'acme_warehouse', slots: 4 },
  ],
  ...over,
});

export const dag = (dagId: string, over: Partial<DagMeta> = {}): DagMeta => ({
  dagId,
  fileloc: `/home/airflow/gcs/dags/${dagId}.py`,
  owners: ['acme-data'],
  tags: ['acme', 'daily'],
  team: 'data-platform',
  schedule: '@daily',
  maxActiveTasks: 16,
  maxActiveRuns: 1,
  catchup: false,
  paused: false,
  ...over,
});

export const snapshot = (at: number): LiveSnapshot => ({
  at,
  scheduled: [
    {
      dagId: 'acme_orders_daily',
      runId: 'scheduled__2026-11-01T00:00:00+00:00',
      taskId: 'extract',
      mapIndex: 3,
      tryNumber: 1,
      pool: 'acme_warehouse',
      poolSlots: 2,
      priorityWeight: 5,
      since: at - 12_345,
    },
  ],
  queued: [],
  pools: [{ name: 'acme_warehouse', slots: 4, running: 4, queued: 0, open: 0 }],
  dagActive: { acme_orders_daily: 4, acme_billing_hourly: 1 },
  executor: { running: 17, queued: 3 },
  workers: { current: 2, target: 3 },
});

export const sample = (at: number, over: Partial<WorkerSample> = {}): WorkerSample => ({
  at,
  workers: 2,
  target: 2.5,
  running: 14,
  queued: 1,
  cpu: 0.625,
  memory: 0.4375,
  ...over,
});

export const health: PlatformHealth = {
  envHealthyRatio: 0.98,
  dbHealthyRatio: 1,
  heartbeatCompleteness: 0.995,
  webServerHealthyRatio: null,
  dbCpuMemoryMax: 0.71,
  zombies24h: 0,
  workerRestarts24h: 2,
  importErrors: 1,
  parseLoopP95Seconds: 41.5,
};

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A fresh temporary folder, removed after the test. */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dcam-store-'));
  dirs.push(dir);
  return dir;
}
