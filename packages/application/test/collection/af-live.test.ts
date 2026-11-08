import { describe, expect, it } from 'vitest';
import { classifySnapshot, occupancySeries, TOTAL_KEY, type EnvironmentConfig } from '@dcam/domain';
import { afFactsCollector, afLiveCollector } from '../../src/index';
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
    const key = (taskId: string) => ['acme-prod', 'acme_orders_daily', RUN, taskId, -1, 1].join('|');
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

describe('HM-003 af.live: running tries end when they stop running', () => {
  const H = 60 * MIN;
  const running = (taskId: string, over: Parameters<typeof ti>[0] = {}) =>
    ti({ taskId, state: 'running', startAt: T0 - MIN, endAt: null, ...over });

  it('HM-003: a complete snapshot ends the tries it no longer lists when they were last seen running', async () => {
    const airflow = new FakeAirflow({ tis: [running('run_a'), running('run_b')], pools: livePools() });
    const store = new MemoryStore();
    const live = afLiveCollector();
    const ctx = fakeContext({ airflow, store, shared });
    await live.collect(ctx);
    airflow.data.tis = [running('run_b')];
    ctx.advance(30_000);
    await live.collect(ctx);

    const tries = new Map((await store.taskTries('acme-prod', T0 - H, T0 + H)).map((t) => [t.taskId, t]));
    expect(tries.get('run_a')).toMatchObject({ state: null, endAt: T0, endEstimated: true });
    expect(tries.get('run_b')).toMatchObject({
      state: 'running',
      endAt: null,
      endEstimated: false,
      seenRunningAt: T0 + 30_000,
    });
  });

  it('HM-003: a sample of the running state ends nothing, because a try it did not read may still be running', async () => {
    // More running tries than two pages hold: no cycle reads them all.
    const crowd = Array.from({ length: 250 }, (_, i) => running(`r_${i}`));
    const airflow = new FakeAirflow({ tis: [running('run_a')], pools: livePools() });
    const store = new MemoryStore();
    const live = afLiveCollector();
    const ctx = fakeContext({ airflow, store, shared });
    await live.collect(ctx);
    airflow.data.tis = crowd;
    for (let i = 0; i < 3; i++) {
      ctx.advance(30_000);
      await live.collect(ctx);
    }
    expect(
      (await store.taskTries('acme-prod', T0 - H, T0 + H)).find((t) => t.taskId === 'run_a'),
    ).toMatchObject({
      endAt: null,
    });
  });

  it('HM-003: a failed try rescheduled before af.facts read its row does not run forever', async () => {
    // The task instance list holds the current try only: once try 2 is scheduled, try 1's row is gone.
    const flaky = { dagId: 'acme_orders_daily', runId: RUN, taskId: 'flaky', mapIndex: -1 };
    const airflow = new FakeAirflow({
      pools: livePools(),
      tis: [ti({ ...flaky, tryNumber: 1, state: 'running', startAt: T0 - MIN, endAt: null })],
    });
    const store = new MemoryStore();
    const ctx = fakeContext({ airflow, store, shared });
    const live = afLiveCollector();
    const facts = afFactsCollector();
    await facts.collect(ctx);
    await live.collect(ctx);
    airflow.data.tis = [
      ti({ ...flaky, tryNumber: 2, state: 'scheduled', queuedAt: null, startAt: null, endAt: null }),
    ];
    ctx.advance(MIN);
    await facts.collect(ctx);
    await live.collect(ctx);
    airflow.data.tis = [
      ti({
        ...flaky,
        tryNumber: 2,
        queuedAt: T0 + 2 * MIN,
        startAt: T0 + 2 * MIN,
        endAt: T0 + 3 * MIN,
        updatedAt: T0 + 3 * MIN,
      }),
    ];
    ctx.advance(5 * MIN);
    await facts.collect(ctx);

    expect(await store.taskTries('acme-prod', T0 + 24 * H, T0 + 25 * H)).toEqual([]);
    const first = (await store.taskTries('acme-prod', T0 - H, T0 + H)).find((t) => t.tryNumber === 1);
    expect(first).toMatchObject({ endAt: T0, endEstimated: true });
  });

  it('HM-011: peak concurrency never exceeds the running count of the snapshots while af.facts lags', async () => {
    // Four slots, each running tries back to back; every fourth task fails once and is retried on the same
    // slot, so its first try leaves the task instance list before af.facts can read it.
    const SLOTS = 4;
    const LIVE_MS = 10_000;
    const plan: Array<{
      taskId: string;
      tryNumber: number;
      readyAt: number;
      startAt: number;
      endAt: number;
      state: string;
    }> = [];
    for (let slot = 0; slot < SLOTS; slot++) {
      let t = T0 + slot * 3_000;
      for (let i = 0; t < T0 + 8 * MIN; i++) {
        const taskId = `s${slot}_t${i}`;
        const tries = i % 4 === 1 ? 2 : 1;
        for (let n = 1; n <= tries; n++) {
          const startAt = t + 3_000;
          const endAt = startAt + [25_000, 41_000, 17_000, 33_000][(i + n + slot) % 4]!;
          plan.push({
            taskId,
            tryNumber: n,
            readyAt: startAt - 2_000,
            startAt,
            endAt,
            state: n < tries ? 'up_for_retry' : 'success',
          });
          t = endAt;
        }
      }
    }
    /** The task instance list at `now`: one row per task instance, its latest try that is ready. */
    const listAt = (now: number) => {
      const current = new Map<string, (typeof plan)[number]>();
      for (const p of plan) if (p.readyAt <= now) current.set(p.taskId, p);
      return [...current.values()].map((p) => {
        const state = now < p.startAt ? 'queued' : now < p.endAt ? 'running' : p.state;
        return ti({
          taskId: p.taskId,
          tryNumber: p.tryNumber,
          state,
          queuedAt: p.readyAt + 1_000,
          startAt: now < p.startAt ? null : p.startAt,
          endAt: now < p.endAt ? null : p.endAt,
          updatedAt: now < p.startAt ? p.readyAt : now < p.endAt ? p.startAt : p.endAt,
        });
      });
    };

    const airflow = new FakeAirflow({ pools: livePools() });
    const store = new MemoryStore();
    const ctx = fakeContext({ airflow, store, shared, now: T0 });
    const live = afLiveCollector();
    const facts = afFactsCollector();
    let snapshotPeak = 0;
    let peak = 0;
    for (let now = T0; now <= T0 + 8 * MIN; now += LIVE_MS) {
      ctx.advance(now - ctx.now());
      airflow.data.tis = listAt(now);
      await live.collect(ctx);
      if ((now - T0) % (3 * LIVE_MS) === 0) await facts.collect(ctx);
      snapshotPeak = Math.max(snapshotPeak, store.snaps.at(-1)?.executor.running ?? 0);
      const w = { from: T0, to: now, now };
      const series = occupancySeries(await store.taskTries('acme-prod', w.from, w.to), w, {
        bucketMs: 1_000,
      });
      peak = Math.max(peak, ...(series.get(TOTAL_KEY) ?? []).map((b) => b.max));
    }
    expect(snapshotPeak).toBe(SLOTS);
    expect(peak).toBeLessThanOrEqual(snapshotPeak);
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
    expect(store.snaps[0]?.workers).toEqual({ current: 3, target: 5, source: 'monitoring' });
  });

  it('HM-011: without a fresh sample, workers are at least min_count and the distinct worker hosts', async () => {
    const airflow = new FakeAirflow({ tis: liveRows(), pools: livePools() });
    const store = new MemoryStore();
    await store.saveConfig('acme-prod', { ...prodConfig, minWorkers: 1 });
    await store.saveWorkerSamples('acme-prod', [
      { at: T0 - 30 * MIN, workers: 6, target: 6, running: 0, queued: 0, cpu: 0, memory: 0 },
    ]);
    await afLiveCollector().collect(fakeContext({ airflow, store, shared }));
    // run_a on worker-1, run_b on worker-2, run_c on the default host airflow-worker-abc12: a lower bound.
    expect(store.snaps[0]?.workers).toEqual({ current: 3, target: 3, source: 'hostnames' });
  });

  it('FR-EMU-02: a self-managed Airflow uses the configured workers and writes its config from limits', async () => {
    const airflow = new FakeAirflow({ tis: liveRows(), pools: livePools() });
    const store = new MemoryStore();
    await afLiveCollector().collect(
      fakeContext({ env: emulatorEntry, airflow, store, shared: { airflowVersion: '2.11.1' } }),
    );
    expect(store.snaps[0]?.workers).toEqual({ current: 2, target: 2, source: 'config' });
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

  /** A busy moment: more waiting and running task instances than two pages hold, rows of every state mixed. */
  const busy = () => {
    const [q, r, s] = [crowd(300, 'queued'), crowd(120, 'running'), crowd(60, 'scheduled')];
    return Array.from({ length: 300 }, (_, i) => [q[i], r[i], s[i]])
      .flat()
      .filter((t) => t !== undefined);
  };
  const sample = {
    at: T0 - 3 * MIN,
    workers: 6,
    target: 6,
    running: 118,
    queued: 290,
    cpu: 0.9,
    memory: 0.6,
  };

  it('FR-COLL-06: a snapshot that fits one page costs /pools and that page, and says it is complete', async () => {
    const airflow = new FakeAirflow({ tis: liveRows(), pools: livePools() });
    const store = new MemoryStore();
    const ctx = fakeContext({ airflow, store, shared });
    await afLiveCollector().collect(ctx);
    expect(airflow.calls).toEqual(['pools', 'taskInstances']);
    expect(store.snaps[0]?.coverage).toEqual({ read: 6, total: 6, complete: true });
    expect(ctx.fidelity).toEqual([]);
  });

  it('FR-COLL-06: reads at most /pools and two pages a cycle (spec §7.5), the second for the running state', async () => {
    const airflow = new FakeAirflow({ tis: busy(), pools: livePools() });
    const live = afLiveCollector();
    await live.collect(fakeContext({ airflow, shared }));
    expect(live.manifest.maxRequestsPerCycle).toBe(3);
    expect(airflow.calls).toEqual(['pools', 'taskInstances', 'taskInstances']);
    expect(airflow.tiQueries).toEqual([
      { states: ['scheduled', 'queued', 'running'], limit: 100, offset: 0 },
      { states: ['running'], limit: 100, offset: 0 },
    ]);
  });

  it('FR-COLL-06: a sample is labelled with its coverage and sampled states; its running count is exact and its queued count comes from Monitoring', async () => {
    const airflow = new FakeAirflow({ tis: busy(), pools: livePools() });
    const store = new MemoryStore();
    await store.saveWorkerSamples('acme-prod', [sample]);
    const ctx = fakeContext({ airflow, store, shared });
    await afLiveCollector().collect(ctx);
    const s = store.snaps[0];
    // The first page holds 34 queued, 33 running and 33 scheduled rows; the running page holds 100 of 120.
    expect(s?.coverage).toEqual({
      read: 167,
      total: 480,
      complete: false,
      sampled: ['scheduled', 'queued', 'running'],
    });
    expect(s?.queued).toHaveLength(34);
    // Running from `total_entries` of the running page; queued from the fresh Cloud Monitoring sample.
    expect(s?.executor).toEqual({ queued: 290, running: 120 });
    expect(ctx.fidelity).toEqual([
      expect.stringMatching(
        /read 167 of 480 .* its scheduled, queued and running task instances are a sample/,
      ),
    ]);
  });

  it('FR-COLL-06: while the snapshot is a sample, the next cycle reads the running state first, then scheduled and queued', async () => {
    const tis = [...crowd(300, 'queued'), ...crowd(60, 'running'), ...crowd(60, 'scheduled')];
    const airflow = new FakeAirflow({ tis, pools: livePools() });
    const live = afLiveCollector();
    const ctx = fakeContext({ airflow, shared });
    await live.collect(ctx);
    ctx.advance(30_000);
    await live.collect(ctx);
    expect(airflow.tiQueries.slice(2)).toEqual([
      { states: ['running'], limit: 100, offset: 0 },
      { states: ['scheduled', 'queued'], limit: 100, offset: 0 },
    ]);
    expect(airflow.calls).toHaveLength(6);
  });

  it('HM-003: when only the queued state overflows, the running set is complete and ends the tries it no longer lists', async () => {
    const running = (taskId: string) => ti({ taskId, state: 'running', startAt: T0 - MIN, endAt: null });
    const airflow = new FakeAirflow({
      tis: [...crowd(300, 'queued'), running('run_a'), running('run_b')],
      pools: livePools(),
    });
    const store = new MemoryStore();
    const live = afLiveCollector();
    const ctx = fakeContext({ airflow, store, shared });
    await live.collect(ctx);
    ctx.advance(30_000);
    await live.collect(ctx);
    airflow.data.tis = [...crowd(300, 'queued'), running('run_b')];
    ctx.advance(30_000);
    await live.collect(ctx);
    const s = store.snaps.at(-1);
    expect(s?.coverage).toEqual({ read: 101, total: 301, complete: false, sampled: ['scheduled', 'queued'] });
    expect(s?.executor.running).toBe(1);
    const tries = new Map((await store.taskTries('acme-prod', T0 - MIN, T0 + MIN)).map((t) => [t.taskId, t]));
    expect(tries.get('run_a')).toMatchObject({ endAt: T0 + 30_000, endEstimated: true });
    expect(tries.get('run_b')).toMatchObject({ endAt: null });
  });

  it('HM-003: when the scheduled state overflows, the running set is still complete and ends the tries it no longer lists', async () => {
    // Task instances waiting on a pool or max_active_tasks stay scheduled: the bottleneck DCAM diagnoses.
    const running = (taskId: string) => ti({ taskId, state: 'running', startAt: T0 - MIN, endAt: null });
    const airflow = new FakeAirflow({
      tis: [...crowd(300, 'scheduled'), running('run_a'), running('run_b')],
      pools: livePools(),
    });
    const store = new MemoryStore();
    const live = afLiveCollector();
    const ctx = fakeContext({ airflow, store, shared });
    await live.collect(ctx);
    airflow.data.tis = [...crowd(300, 'scheduled'), running('run_b')];
    ctx.advance(30_000);
    await live.collect(ctx);
    expect(airflow.calls).toHaveLength(6);
    const s = store.snaps.at(-1);
    expect(s?.coverage).toEqual({ read: 101, total: 301, complete: false, sampled: ['scheduled', 'queued'] });
    expect(s?.scheduled).toHaveLength(100);
    expect(s?.executor.running).toBe(1);
    const tries = new Map((await store.taskTries('acme-prod', T0 - MIN, T0 + MIN)).map((t) => [t.taskId, t]));
    expect(tries.get('run_a')).toMatchObject({ endAt: T0, endEstimated: true });
    expect(tries.get('run_b')).toMatchObject({ endAt: null });
  });

  it('HM-003: more running tries than a page: every other cycle completes them, and no snapshot lacks the waiting states', async () => {
    const tis = [...crowd(150, 'running'), ...crowd(200, 'scheduled')];
    const airflow = new FakeAirflow({ tis, pools: livePools() });
    const store = new MemoryStore();
    const live = afLiveCollector();
    const ctx = fakeContext({ airflow, store, shared });
    const requests: number[] = [];
    for (let cycle = 0; cycle < 6; cycle++) {
      // One running try stops after the first cycle.
      if (cycle === 1) airflow.data.tis = tis.filter((t) => t.taskId !== 't_running_0');
      const before = airflow.calls.length;
      await live.collect(ctx);
      requests.push(airflow.calls.length - before);
      ctx.advance(30_000);
    }
    expect(requests.every((n) => n <= 3)).toBe(true);
    // Snapshots every other cycle, each with scheduled rows and an exact running count.
    expect(store.snaps.map((s) => s.at)).toEqual([T0, T0 + 60_000, T0 + 120_000]);
    for (const s of store.snaps) {
      expect(s.scheduled.length).toBeGreaterThan(0);
      expect(s.executor.running).toBe(s.at === T0 ? 150 : 149);
      expect(s.coverage?.sampled).toEqual(['scheduled', 'queued', 'running']);
    }
    const stopped = (await store.taskTries('acme-prod', T0 - MIN, T0 + 5 * MIN)).find(
      (t) => t.taskId === 't_running_0',
    );
    expect(stopped).toMatchObject({ endAt: T0, endEstimated: true });
    const open = (await store.taskTries('acme-prod', T0 - MIN, T0 + 5 * MIN)).filter((t) => t.endAt === null);
    expect(open).toHaveLength(149);
    expect(ctx.fidelity.some((f) => /149 running .* saved no snapshot/.test(f))).toBe(true);
  });

  it('FR-COLL-06: once everything fits again, the next cycle is one page', async () => {
    const airflow = new FakeAirflow({ tis: busy(), pools: livePools() });
    const live = afLiveCollector();
    const ctx = fakeContext({ airflow, shared });
    await live.collect(ctx);
    airflow.data.tis = liveRows();
    ctx.advance(30_000);
    await live.collect(ctx);
    ctx.advance(30_000);
    await live.collect(ctx);
    expect(airflow.tiQueries.slice(2).map((q) => q.states)).toEqual([
      ['running'],
      ['scheduled', 'queued'],
      ['scheduled', 'queued', 'running'],
    ]);
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

  it('FR-COLL-08: refuses Airflow below 2.10, whose try numbers DCAM would misread', async () => {
    const airflow = new FakeAirflow({ pools: livePools() });
    const ctx = fakeContext({ airflow, shared: { ...shared, airflowVersion: '2.9.3' } });
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
