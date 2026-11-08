import { describe, expect, it } from 'vitest';
import type { MetricQuery, MetricSeries } from '@dcam/ports';
import { monCoreCollector } from '../../src/index';
import { Budget, fakeContext, FakeMonitoring, H, MemoryStore, MIN, T0 } from './collectors-harness';

const M = 'composer.googleapis.com/';
const GIB = 1024 ** 3;

/** One series with a point at the end of every aligned interval after `from`, up to `to`. */
const perMinute = (
  q: MetricQuery,
  value: (at: number) => number | undefined,
  resourceLabels = {},
): MetricSeries => {
  const points: Array<{ at: number; value: number }> = [];
  const step = q.alignmentPeriodSeconds * 1000;
  for (let at = q.from + step; at <= q.to; at += step) {
    const v = value(at);
    if (v !== undefined) points.push({ at, value: v });
  }
  return { metricLabels: {}, resourceLabels, points };
};

/** A healthy Composer 3 environment with three workers at 2 vCPU and 8 GiB. */
function respond(over: Partial<Record<string, (at: number) => number | undefined>> = {}) {
  const values: Record<string, (at: number) => number | undefined> = {
    'environment/num_celery_workers': () => 3,
    'environment/worker/scale_factor_target': () => 1.5,
    'environment/executor/running_tasks': () => 10,
    'environment/executor/queued_tasks': () => 4,
    'workload/cpu/usage_time': () => 1.5,
    'workload/cpu/reserved_cores': () => 2,
    'workload/memory/bytes_used': () => 6 * GIB,
    'workload/memory/quota': () => 8 * GIB,
    'environment/healthy': () => 0.9,
    'environment/database_health': () => 1,
    'environment/web_server/health': () => 1,
    'environment/database/cpu/utilization': (at) => (at > T0 - 4 * H && at <= T0 - 3 * H ? 0.85 : 0.4),
    'environment/database/memory/utilization': () => 0.6,
    'environment/zombie_task_killed_count': () => 1,
    'environment/dag_processing/total_parse_time': () => 42,
    ...over,
  };
  return (q: MetricQuery): MetricSeries[] => {
    const name = q.metricType.slice(M.length);
    if (q.groupBy?.includes('resource.labels.type'))
      return ['scheduler', 'celery-worker', 'web-server'].map((type) =>
        perMinute({ ...q, from: q.to - MIN }, () => GIB, { type }),
      );
    const f = values[name];
    if (!f) return [];
    // Executor metrics are summed across executors: two series reduced to one.
    return [perMinute(q, f)];
  };
}

const sampleAt = (store: MemoryStore, at: number) => store.samples.get(at);

describe('FR-COLL-07 mon.core windows', () => {
  it('FR-COLL-07: the window ends at now minus the 120 s ingestion delay and the first one covers an hour', async () => {
    const monitoring = new FakeMonitoring(respond());
    const store = new MemoryStore();
    await monCoreCollector().collect(fakeContext({ store, monitoring, now: T0 + 30_000 }));
    const workers = monitoring.queries.find((q) => q.metricType.endsWith('num_celery_workers'));
    // now − 120 s = T0 − 90 s, floored to the minute.
    expect(workers).toMatchObject({ from: T0 - 2 * MIN - H, to: T0 - 2 * MIN, alignmentPeriodSeconds: 60 });
    expect(Math.max(...store.samples.keys())).toBe(T0 - 2 * MIN);
    expect([...store.samples.keys()].every((at) => at <= T0 + 30_000 - 120_000)).toBe(true);
  });

  it('FR-COLL-07: each cycle re-reads the trailing 10 minutes and upserts late points', async () => {
    let late = false;
    const monitoring = new FakeMonitoring(
      respond({ 'environment/num_celery_workers': (at) => (late && at === T0 - 5 * MIN ? 5 : 3) }),
    );
    const store = new MemoryStore();
    const collector = monCoreCollector();
    const ctx = fakeContext({ store, monitoring });
    await collector.collect(ctx);
    expect(sampleAt(store, T0 - 5 * MIN)?.workers).toBe(3);
    late = true;
    ctx.advance(MIN);
    await collector.collect(ctx);
    const q = monitoring.queries.filter((x) => x.metricType.endsWith('num_celery_workers')).at(-1);
    expect(q).toMatchObject({ from: T0 - 2 * MIN - 10 * MIN, to: T0 - MIN });
    expect(sampleAt(store, T0 - 5 * MIN)?.workers).toBe(5);
  });
});

describe('HM-011 mon.core worker samples', () => {
  it('HM-011/HM-012: one sample per minute with workers, target, executor load and peak worker CPU and memory', async () => {
    const monitoring = new FakeMonitoring(respond());
    const store = new MemoryStore();
    await store.saveConfig('acme-prod', {
      envId: 'acme-prod',
      tier: 'prod',
      composerImage: 'composer-3-airflow-2.11.1-build.22',
      airflowVersion: '2.11.1',
      parallelism: 64,
      schedulers: 2,
      maxActiveTasksPerDag: 16,
      maxActiveRunsPerDag: 25,
      workerConcurrency: 4,
      minWorkers: 2,
      maxWorkers: 4,
      pools: [],
    });
    const result = await monCoreCollector().collect(fakeContext({ store, monitoring }));
    expect(store.samples.size).toBe(60);
    expect(sampleAt(store, T0 - 10 * MIN)).toEqual({
      at: T0 - 10 * MIN,
      workers: 3,
      // ⚠️ scale_factor_target read as a ratio: ceil(3 × 1.5) = 5, clamped to max_count 4.
      target: 4,
      running: 10,
      queued: 4,
      cpu: 0.75,
      memory: 0.75,
    });
    expect(result.dataAsOf).toBe(T0 - 2 * MIN);
  });

  it('NFR-DATA-03: a minute without one of its inputs is left out, never filled with zero', async () => {
    const monitoring = new FakeMonitoring(
      respond({ 'workload/cpu/usage_time': (at) => (at === T0 - 7 * MIN ? undefined : 1) }),
    );
    const store = new MemoryStore();
    await monCoreCollector().collect(fakeContext({ store, monitoring }));
    expect(sampleAt(store, T0 - 7 * MIN)).toBeUndefined();
    expect(sampleAt(store, T0 - 8 * MIN)).toBeDefined();
  });

  it('HM-012: without an autoscaler target the target is the current worker count', async () => {
    const monitoring = new FakeMonitoring(
      respond({ 'environment/worker/scale_factor_target': () => undefined }),
    );
    const store = new MemoryStore();
    await monCoreCollector().collect(fakeContext({ store, monitoring }));
    expect(sampleAt(store, T0 - 10 * MIN)).toMatchObject({ workers: 3, target: 3 });
  });
});

describe('NFR-OBS-06 mon.core series budget', () => {
  it('NFR-OBS-06: counts every series returned and reduces across series wherever detail is not needed', async () => {
    const monitoring = new FakeMonitoring(respond());
    const collector = monCoreCollector();
    const ctx = fakeContext({ monitoring });
    await collector.collect(ctx);
    const returned = monitoring.queries.map((q) => respond()(q).length);
    expect(ctx.seriesCounted).toEqual(returned);
    const discovery = monitoring.queries.filter((q) => q.groupBy?.includes('resource.labels.type'));
    expect(discovery).toHaveLength(1);
    for (const q of monitoring.queries.filter((x) => !discovery.includes(x))) {
      expect(q.reducer).toBeDefined();
      expect(q.resourceType.startsWith('cloud_composer_')).toBe(true);
      expect(q.resourceLabels).toMatchObject({
        location: 'europe-west1',
        environment_name: 'acme-composer-prod',
      });
      expect(q.alignmentPeriodSeconds).toBeGreaterThanOrEqual(60);
    }
    const workload = monitoring.queries.filter(
      (q) => q.resourceType === 'cloud_composer_workload' && !q.groupBy,
    );
    expect(workload.every((q) => q.resourceLabels.type === 'celery-worker')).toBe(true);

    // The next cycle reuses the discovered worker type and skips the hourly limits and the 5-minute health.
    const before = monitoring.queries.length;
    ctx.advance(MIN);
    await collector.collect(ctx);
    const second = monitoring.queries.slice(before);
    expect(second.map((q) => q.metricType.slice(M.length)).sort()).toEqual([
      'environment/executor/queued_tasks',
      'environment/executor/running_tasks',
      'environment/num_celery_workers',
      'environment/worker/scale_factor_target',
      'workload/cpu/usage_time',
      'workload/memory/bytes_used',
    ]);
  });
});

describe('HM-028 mon.core platform health', () => {
  it('HM-028: derives the health inputs over their windows and keeps the import errors from af.inventory', async () => {
    const monitoring = new FakeMonitoring(respond());
    const store = new MemoryStore();
    await store.savePlatformHealth('acme-prod', {
      ...(await store.platformHealth('acme-prod')),
      importErrors: 2,
    });
    await monCoreCollector().collect(fakeContext({ store, monitoring }));
    expect(await store.platformHealth('acme-prod')).toEqual({
      envHealthyRatio: 0.9,
      dbHealthyRatio: 1,
      heartbeatCompleteness: null,
      webServerHealthyRatio: 1,
      dbCpuMemoryMax: 0.85,
      zombies24h: 24,
      workerRestarts24h: null,
      importErrors: 2,
      parseLoopP95Seconds: 42,
    });
    const healthy = monitoring.queries.find((q) => q.metricType.endsWith('environment/healthy'));
    expect(healthy).toMatchObject({
      aligner: 'ALIGN_FRACTION_TRUE',
      from: T0 - 2 * MIN - 4 * H,
      to: T0 - 2 * MIN,
    });
    const db = monitoring.queries.find((q) => q.metricType.endsWith('database/cpu/utilization'));
    // Database metrics become visible after up to 180 s.
    expect(db?.to).toBe(T0 - 3 * MIN);
  });

  it('HM-028: metrics without data stay unknown', async () => {
    const monitoring = new FakeMonitoring(
      respond({
        'environment/healthy': () => undefined,
        'environment/zombie_task_killed_count': () => undefined,
      }),
    );
    const store = new MemoryStore();
    await monCoreCollector().collect(fakeContext({ store, monitoring }));
    expect(await store.platformHealth('acme-prod')).toMatchObject({
      envHealthyRatio: null,
      zombies24h: null,
    });
  });
});

describe('FR-COLL-06 mon.core within the budget', () => {
  it('FR-COLL-06: an exhausted budget writes no partial samples and the next cycle reads the same window', async () => {
    const monitoring = new FakeMonitoring(respond(), new Budget('monitoring', 3));
    const store = new MemoryStore();
    const collector = monCoreCollector();
    const ctx = fakeContext({ store, monitoring });
    expect(await collector.collect(ctx)).toEqual({ dataAsOf: null });
    expect(store.samples.size).toBe(0);
    expect(ctx.fidelity.length).toBeGreaterThan(0);

    monitoring.budget.limit = Number.POSITIVE_INFINITY;
    ctx.advance(MIN);
    await collector.collect(ctx);
    const q = monitoring.queries.filter((x) => x.metricType.endsWith('num_celery_workers')).at(-1);
    expect(q?.from).toBe(T0 - MIN - H);
  });

  it('FR-COLL-01: declares a Monitoring collector for Composer environments only', () => {
    expect(monCoreCollector().manifest).toMatchObject({
      id: 'mon.core',
      source: 'SRC-MON',
      api: 'monitoring',
      cadence: 'monitoring',
      priority: 'standard',
      outputs: ['samples', 'health'],
      sourceKinds: ['composer'],
    });
  });
});
