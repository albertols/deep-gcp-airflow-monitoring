import { describe, expect, it } from 'vitest';
import { UNKNOWN_LIMIT } from '@dcam/domain';
import { SourceError } from '@dcam/ports';
import { composerConfigCollector, parseImageVersion } from '../../src/index';
import {
  Budget,
  composerEnv,
  emulatorEntry,
  fakeContext,
  FakeComposer,
  MemoryStore,
  MIN,
  T0,
} from './collectors-harness';

describe('FR-COLL-09 composer.config', () => {
  it('FR-COLL-09: detects the Composer generation and Airflow version from the image', () => {
    expect(parseImageVersion('composer-3-airflow-2.11.1-build.22')).toEqual({
      generation: 3,
      airflowVersion: '2.11.1',
    });
    expect(parseImageVersion('composer-2.9.7-airflow-2.9.3')).toEqual({
      generation: 2,
      airflowVersion: '2.9.3',
    });
    expect(parseImageVersion('composer-3-airflow-3.1.8-build.4')).toEqual({
      generation: 3,
      airflowVersion: '3.1.8',
    });
    expect(parseImageVersion('something-else')).toBeNull();
  });

  it('FR-COLL-09: maps environments.get to the environment config and shares the Airflow URL and image', async () => {
    const store = new MemoryStore();
    const composer = new FakeComposer(
      composerEnv({
        airflowConfigOverrides: {
          'core-parallelism': '48',
          'core-max_active_tasks_per_dag': '32',
          'core-max_active_runs_per_dag': '4',
          'celery-worker_concurrency': '12',
        },
      }),
    );
    const ctx = fakeContext({ store, composer });
    const result = await composerConfigCollector().collect(ctx);

    expect(ctx.shared).toEqual({
      airflowBaseUrl: 'https://acme-composer-prod.example.test',
      airflowVersion: '2.11.1',
      imageVersion: 'composer-3-airflow-2.11.1-build.22',
    });
    expect(await store.config('acme-prod')).toEqual({
      envId: 'acme-prod',
      tier: 'prod',
      composerImage: 'composer-3-airflow-2.11.1-build.22',
      airflowVersion: '2.11.1',
      parallelism: 48,
      schedulers: 2,
      maxActiveTasksPerDag: 32,
      maxActiveRunsPerDag: 4,
      workerConcurrency: 12,
      minWorkers: 2,
      maxWorkers: 6,
      pools: [],
      limitSources: {
        parallelism: 'override',
        workerConcurrency: 'override',
        maxActiveTasksPerDag: 'override',
        maxActiveRunsPerDag: 'override',
      },
    });
    expect(result.dataAsOf).toBe(T0);
    expect(composer.calls).toBe(1);
  });

  it('FR-COLL-09: without overrides, parallelism and worker_concurrency are unknown and the DAG limits use Composer defaults', async () => {
    const store = new MemoryStore();
    await composerConfigCollector().collect(fakeContext({ store, composer: new FakeComposer() }));
    const config = await store.config('acme-prod');
    expect(config).toMatchObject({
      parallelism: UNKNOWN_LIMIT,
      workerConcurrency: UNKNOWN_LIMIT,
      maxActiveTasksPerDag: 16,
      maxActiveRunsPerDag: 25,
      limitSources: {
        parallelism: 'unknown',
        workerConcurrency: 'unknown',
        maxActiveTasksPerDag: 'composer-default',
        maxActiveRunsPerDag: 'composer-default',
      },
    });
  });

  it('FR-COLL-09: keeps the pools af.live learned, from the stored config or else the newest snapshot', async () => {
    const store = new MemoryStore();
    store.snaps.push({
      at: T0 - MIN,
      scheduled: [],
      queued: [],
      pools: [{ name: 'acme_api', slots: 4, running: 1, queued: 0, open: 3 }],
      dagActive: {},
      executor: { running: 1, queued: 0 },
      workers: { current: 2, target: 2 },
    });
    const collector = composerConfigCollector();
    await collector.collect(fakeContext({ store, composer: new FakeComposer() }));
    expect((await store.config('acme-prod'))?.pools).toEqual([{ name: 'acme_api', slots: 4 }]);

    const stored = await store.config('acme-prod');
    if (!stored) throw new Error('no config');
    await store.saveConfig('acme-prod', { ...stored, pools: [{ name: 'default_pool', slots: 128 }] });
    await collector.collect(fakeContext({ store, composer: new FakeComposer() }));
    expect((await store.config('acme-prod'))?.pools).toEqual([{ name: 'default_pool', slots: 128 }]);
  });

  it('FR-COLL-08: an Airflow 3 image is reported as unsupported until M4, after sharing what it found', async () => {
    const store = new MemoryStore();
    const composer = new FakeComposer(composerEnv({ imageVersion: 'composer-3-airflow-3.1.8-build.4' }));
    const ctx = fakeContext({ store, composer });
    const error = await composerConfigCollector()
      .collect(ctx)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SourceError);
    expect(error).toMatchObject({
      kind: 'unsupported',
      message: 'Airflow 3 environments are supported from M4',
    });
    expect(ctx.shared.airflowVersion).toBe('3.1.8');
    expect(await store.config('acme-prod')).toBeNull();
  });

  it('FR-COLL-09: a Composer 1 image is reported as unsupported', async () => {
    const composer = new FakeComposer(composerEnv({ imageVersion: 'composer-1.20.12-airflow-2.4.3' }));
    await expect(composerConfigCollector().collect(fakeContext({ composer }))).rejects.toMatchObject({
      kind: 'unsupported',
    });
  });

  it('FR-COLL-06: an exhausted Composer budget is reduced fidelity, not a failure', async () => {
    const composer = new FakeComposer(composerEnv(), new Budget('composer', 0));
    const ctx = fakeContext({ composer });
    expect(await composerConfigCollector().collect(ctx)).toEqual({ dataAsOf: null });
    expect(ctx.fidelity).toHaveLength(1);
  });

  it('FR-COLL-01: declares its source, budget and output, for Composer environments only', () => {
    const { manifest } = composerConfigCollector();
    expect(manifest).toMatchObject({
      id: 'composer.config',
      source: 'SRC-COMPOSER',
      api: 'composer',
      cadence: 'composer',
      outputs: ['config'],
      sourceKinds: ['composer'],
    });
    expect(manifest.maxRequestsPerCycle).toBeGreaterThan(0);
    expect(manifest.sourceKinds).not.toContain(emulatorEntry.source.kind);
  });
});
