import { describe, expect, it } from 'vitest';
import { classifySnapshot, type EnvironmentConfig } from '@dcam/domain';
import { afLiveCollector } from '../../src/index';
import {
  Budget,
  emulatorEntry,
  fakeContext,
  FakeAirflow,
  MemoryStore,
  MIN,
  pool,
  T0,
  ti,
} from './collectors-harness';

const shared = { airflowBaseUrl: 'https://acme-composer-prod.example.test', airflowVersion: '2.11.1' };
const RUN = 'scheduled__2026-11-05T11:00:00+00:00';

const prodConfig: EnvironmentConfig = {
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
  maxWorkers: 6,
  pools: [{ name: 'default_pool', slots: 128 }],
};

const liveRows = () => [
  ti({ taskId: 'wait_a', state: 'scheduled', queuedAt: null, startAt: null, endAt: null }),
  ti({ taskId: 'wait_b', state: 'scheduled', pool: 'acme_api', poolSlots: 2, priorityWeight: null }),
  ti({ taskId: 'queued_a', state: 'queued', queuedAt: T0 - 2 * MIN, startAt: null, endAt: null }),
  ti({ taskId: 'run_a', state: 'running', startAt: T0 - 3 * MIN, endAt: null, hostname: 'airflow-worker-1' }),
  ti({ taskId: 'run_b', state: 'running', startAt: T0 - MIN, endAt: null, hostname: 'airflow-worker-2' }),
  ti({ dagId: 'acme_other', taskId: 'run_c', state: 'running', startAt: T0 - MIN, endAt: null }),
  ti({ taskId: 'done', state: 'success' }),
];
const livePools = () => [
  pool({ runningSlots: 3, queuedSlots: 1, openSlots: 124 }),
  pool({ name: 'acme_api', slots: 4, runningSlots: 4, queuedSlots: 0, openSlots: 0 }),
];

describe('HM-006 af.live snapshot', () => {
  it('HM-006: maps pools and non-terminal task instances to the live snapshot the classifier reads', async () => {
    const airflow = new FakeAirflow({ tis: liveRows(), pools: livePools() });
    const store = new MemoryStore();
    await store.saveConfig('acme-prod', prodConfig);
    const result = await afLiveCollector().collect(fakeContext({ airflow, store, shared }));

    expect(airflow.tiQueries).toEqual([
      { states: ['scheduled', 'queued', 'running'], limit: 100, offset: 0 },
    ]);
    const [s] = store.snaps;
    expect(s?.at).toBe(T0);
    expect(s?.scheduled.map((x) => [x.taskId, x.pool, x.poolSlots, x.priorityWeight, x.since])).toEqual([
      ['wait_a', 'default_pool', 1, 1, T0],
      ['wait_b', 'acme_api', 2, 1, T0],
    ]);
    expect(s?.queued.map((x) => [x.taskId, x.since])).toEqual([['queued_a', T0 - 2 * MIN]]);
    expect(s?.pools).toEqual([
      { name: 'default_pool', slots: 128, running: 3, queued: 1, open: 124 },
      { name: 'acme_api', slots: 4, running: 4, queued: 0, open: 0 },
    ]);
    expect(s?.dagActive).toEqual({ acme_orders_daily: 3, acme_other: 1 });
    expect(s?.executor).toEqual({ running: 3, queued: 1 });
    expect(result.dataAsOf).toBe(T0);

    const classified = classifySnapshot(s!, { config: prodConfig, dagMaxActiveTasks: new Map() });
    expect(classified.find((c) => c.ti.taskId === 'wait_b')?.reason).toBe('pool-exhausted');
  });

  it('HM-001/HM-006: a scheduled try keeps the time it was first seen ready across cycles', async () => {
    const airflow = new FakeAirflow({ tis: liveRows(), pools: livePools() });
    const store = new MemoryStore();
    const live = afLiveCollector();
    const ctx = fakeContext({ airflow, store, shared });
    await live.collect(ctx);
    ctx.advance(30_000);
    await live.collect(ctx);
    expect(store.snaps[1]?.scheduled.find((x) => x.taskId === 'wait_a')?.since).toBe(T0);
    expect(store.snaps[1]?.queued.find((x) => x.taskId === 'queued_a')?.since).toBe(T0 - 2 * MIN);
    const key = (taskId: string) => ['acme_orders_daily', RUN, taskId, -1, 1].join('|');
    expect(store.ready.get(key('wait_a'))).toBe(T0);
    expect(store.ready.get(key('wait_b'))).toBe(T0);
    expect(store.ready.has(key('queued_a'))).toBe(false);
  });

  it('HM-006: after a gap the first-seen time starts again rather than spanning the gap', async () => {
    const airflow = new FakeAirflow({ tis: liveRows(), pools: livePools() });
    const store = new MemoryStore();
    const live = afLiveCollector();
    const ctx = fakeContext({ airflow, store, shared });
    await live.collect(ctx);
    ctx.advance(60 * MIN);
    await live.collect(ctx);
    expect(store.snaps[1]?.scheduled.find((x) => x.taskId === 'wait_a')?.since).toBe(T0 + 60 * MIN);
  });

  it('HM-003: running tries are upserted as running so the pages count their slot time', async () => {
    const airflow = new FakeAirflow({ tis: liveRows(), pools: livePools() });
    const store = new MemoryStore();
    await afLiveCollector().collect(fakeContext({ airflow, store, shared }));
    const running = [...store.tries.values()];
    expect(running.map((t) => [t.taskId, t.state, t.startAt, t.endAt])).toEqual([
      ['run_a', 'running', T0 - 3 * MIN, null],
      ['run_b', 'running', T0 - MIN, null],
      ['run_c', 'running', T0 - MIN, null],
    ]);
    expect(await store.taskTries('acme-prod', T0 - 10 * MIN, T0)).toHaveLength(3);
  });
});

describe('HM-011 af.live workers', () => {
  it('HM-011: takes workers and the autoscaler target from the newest fresh worker sample', async () => {
    const airflow = new FakeAirflow({ tis: liveRows(), pools: livePools() });
    const store = new MemoryStore();
    await store.saveWorkerSamples('acme-prod', [
      { at: T0 - 5 * MIN, workers: 2, target: 2, running: 3, queued: 1, cpu: 0.5, memory: 0.5 },
      { at: T0 - 3 * MIN, workers: 3, target: 5, running: 3, queued: 1, cpu: 0.5, memory: 0.5 },
    ]);
    await afLiveCollector().collect(fakeContext({ airflow, store, shared }));
    expect(store.snaps[0]?.workers).toEqual({ current: 3, target: 5 });
  });

  it('HM-011: without a fresh sample, workers are at least min_count and the distinct worker hosts', async () => {
    const airflow = new FakeAirflow({ tis: liveRows(), pools: livePools() });
    const store = new MemoryStore();
    await store.saveConfig('acme-prod', { ...prodConfig, minWorkers: 1 });
    await store.saveWorkerSamples('acme-prod', [
      { at: T0 - 30 * MIN, workers: 6, target: 6, running: 0, queued: 0, cpu: 0, memory: 0 },
    ]);
    await afLiveCollector().collect(fakeContext({ airflow, store, shared }));
    // run_a on worker-1, run_b on worker-2, run_c on the default host airflow-worker-abc12.
    expect(store.snaps[0]?.workers).toEqual({ current: 3, target: 3 });
  });

  it('FR-EMU-02: a self-managed Airflow uses the configured workers and writes its config from limits', async () => {
    const airflow = new FakeAirflow({ tis: liveRows(), pools: livePools() });
    const store = new MemoryStore();
    await afLiveCollector().collect(
      fakeContext({ env: emulatorEntry, airflow, store, shared: { airflowVersion: '2.11.1' } }),
    );
    expect(store.snaps[0]?.workers).toEqual({ current: 2, target: 2 });
    expect(await store.config('acme-emulator')).toMatchObject({
      envId: 'acme-emulator',
      tier: 'dev',
      airflowVersion: '2.11.1',
      parallelism: 32,
      schedulers: 1,
      workerConcurrency: 8,
      minWorkers: 2,
      maxWorkers: 2,
      pools: [
        { name: 'default_pool', slots: 128 },
        { name: 'acme_api', slots: 4 },
      ],
    });
  });

  it('FR-COLL-09: keeps the pools of a stored Composer config current, and writes none before composer.config', async () => {
    const airflow = new FakeAirflow({ tis: [], pools: livePools() });
    const store = new MemoryStore();
    await afLiveCollector().collect(fakeContext({ airflow, store, shared }));
    expect(await store.config('acme-prod')).toBeNull();

    await store.saveConfig('acme-prod', prodConfig);
    await afLiveCollector().collect(fakeContext({ airflow, store, shared }));
    expect((await store.config('acme-prod'))?.pools).toEqual([
      { name: 'default_pool', slots: 128 },
      { name: 'acme_api', slots: 4 },
    ]);
    expect((await store.config('acme-prod'))?.parallelism).toBe(64);
  });
});

describe('FR-COLL-06 af.live within the budget', () => {
  const crowd = (n: number, state: string) =>
    Array.from({ length: n }, (_, i) =>
      ti({ taskId: `t_${state}_${i}`, state, startAt: state === 'running' ? T0 - MIN : null, endAt: null }),
    );

  it('FR-COLL-06: stops at the page cap, labels the snapshot a sample and takes executor counts from Monitoring', async () => {
    const airflow = new FakeAirflow({
      tis: [...crowd(300, 'queued'), ...crowd(300, 'running')],
      pools: livePools(),
    });
    const store = new MemoryStore();
    await store.saveWorkerSamples('acme-prod', [
      { at: T0 - 3 * MIN, workers: 6, target: 6, running: 300, queued: 310, cpu: 0.9, memory: 0.6 },
    ]);
    const live = afLiveCollector();
    const ctx = fakeContext({ airflow, store, shared });
    await live.collect(ctx);
    expect(airflow.calls.length).toBe(live.manifest.maxRequestsPerCycle);
    expect(airflow.tiQueries.every((q) => q.limit <= 100)).toBe(true);
    expect(ctx.fidelity).toHaveLength(1);
    const s = store.snaps[0];
    const read = (s?.queued.length ?? 0) + Object.values(s?.dagActive ?? {}).reduce((a, b) => a + b, 0);
    expect(read).toBeGreaterThan(0);
    expect(s?.executor).toEqual({ running: 300, queued: 310 });
  });

  it('FR-COLL-06: an exhausted budget after the first page still saves the snapshot it has', async () => {
    const airflow = new FakeAirflow(
      { tis: crowd(250, 'queued'), pools: livePools() },
      new Budget('airflow', 2),
    );
    const store = new MemoryStore();
    const ctx = fakeContext({ airflow, store, shared });
    const result = await afLiveCollector().collect(ctx);
    expect(store.snaps[0]?.queued).toHaveLength(100);
    expect(ctx.fidelity).toHaveLength(1);
    expect(result.dataAsOf).toBe(T0);
  });

  it('FR-COLL-06: without budget for /pools there is no snapshot this cycle', async () => {
    const airflow = new FakeAirflow({ tis: [], pools: livePools() }, new Budget('airflow', 0));
    const store = new MemoryStore();
    const ctx = fakeContext({ airflow, store, shared });
    expect(await afLiveCollector().collect(ctx)).toEqual({ dataAsOf: null });
    expect(store.snaps).toEqual([]);
    expect(ctx.fidelity).toHaveLength(1);
  });

  it('FR-COLL-08: refuses an Airflow 3 environment', async () => {
    const airflow = new FakeAirflow({ pools: livePools() });
    const ctx = fakeContext({ airflow, shared: { ...shared, airflowVersion: '3.1.8' } });
    await expect(afLiveCollector().collect(ctx)).rejects.toMatchObject({ kind: 'unsupported' });
    expect(airflow.calls).toEqual([]);
  });

  it('FR-COLL-01: declares a live Airflow collector', () => {
    expect(afLiveCollector().manifest).toMatchObject({
      id: 'af.live',
      source: 'SRC-AF-API',
      api: 'airflow',
      cadence: 'airflowLive',
      priority: 'live',
      outputs: ['snapshots', 'tries', 'config'],
      sourceKinds: ['composer', 'airflow'],
    });
  });
});
