import { describe, expect, it } from 'vitest';
import { afFactsCollector, afLiveCollector } from '../../src/index';
import { Budget, fakeContext, FakeAirflow, H, MemoryStore, MIN, pool, T0, ti } from './collectors-harness';

const shared = { airflowBaseUrl: 'https://acme-composer-prod.example.test', airflowVersion: '2.11.1' };
/** The window end: now minus the settling delay. */
const END = T0 - MIN;

const spread = (n: number, from: number, to: number, state = 'success') =>
  Array.from({ length: n }, (_, i) => {
    const at = from + Math.floor(((to - from) * i) / n);
    return ti({ taskId: `t_${i}`, state, startAt: at - MIN, endAt: at, updatedAt: at });
  });

describe('FR-COLL-03 af.facts: watermark, overlap and idempotent upserts', () => {
  it('FR-COLL-03: the first cycle reads a bounded first window of finished task instances and commits its end', async () => {
    const airflow = new FakeAirflow({
      tis: [
        ti({ taskId: 'old', updatedAt: T0 - 2 * H }),
        ti({ taskId: 'recent', updatedAt: T0 - 30 * MIN }),
        ti({ taskId: 'running', state: 'running', endAt: null, updatedAt: T0 - 10 * MIN }),
      ],
    });
    const store = new MemoryStore();
    const result = await afFactsCollector().collect(fakeContext({ airflow, store, shared }));

    expect(airflow.tiQueries).toEqual([
      {
        states: ['success', 'failed', 'upstream_failed', 'skipped', 'up_for_retry'],
        updatedFrom: END - H,
        updatedTo: END,
        limit: 100,
        offset: 0,
      },
    ]);
    expect([...store.tries.values()].map((t) => t.taskId)).toEqual(['recent']);
    expect(store.commits).toEqual([{ rows: 1, watermark: END }]);
    expect(result.dataAsOf).toBe(END);
  });

  it('FR-COLL-03: re-reads the overlap, picks up late updates, and a restart resumes without duplicates', async () => {
    const airflow = new FakeAirflow({ tis: spread(40, T0 - 50 * MIN, T0 - 2 * MIN) });
    const store = new MemoryStore();
    const ctx = fakeContext({ airflow, store, shared });
    await afFactsCollector().collect(ctx);
    expect(await store.countTaskTries('acme-prod')).toBe(40);

    // A row finished long ago is marked again by hand; its updated_at falls inside the overlap.
    airflow.data.tis.push(
      ti({ taskId: 'marked_again', state: 'failed', endAt: T0 - 3 * H, updatedAt: END - 5 * MIN }),
    );
    ctx.advance(5 * MIN);
    // A restart: a new collector with the same store resumes from the persisted watermark.
    await afFactsCollector().collect(ctx);
    const q = airflow.tiQueries.at(-1);
    expect(q?.updatedFrom).toBe(END - 10 * MIN);
    expect(q?.updatedTo).toBe(END + 5 * MIN);
    expect(await store.countTaskTries('acme-prod')).toBe(41);
    expect(store.tries.size).toBe(41);
    expect(store.commits.at(-1)?.watermark).toBe(END + 5 * MIN);
  });

  it('FR-COLL-03: in steady state the overlap is re-read once per overlap period, not every cycle', async () => {
    const airflow = new FakeAirflow({ tis: spread(20, T0 - 50 * MIN, T0 - 2 * MIN) });
    const store = new MemoryStore();
    const collector = afFactsCollector();
    const ctx = fakeContext({ airflow, store, shared });
    const overlapped: boolean[] = [];
    for (let i = 0; i < 12; i++) {
      const before = await store.watermark('acme-prod', 'af.facts');
      const seen = airflow.tiQueries.length;
      await collector.collect(ctx);
      const from = airflow.tiQueries[seen]?.updatedFrom;
      if (before !== null) overlapped.push(from === before - 10 * MIN);
      if (before !== null && !overlapped.at(-1)) expect(from).toBe(before);
      ctx.advance(MIN);
    }
    // Cycle 2 (the first with a watermark) and cycle 12, ten minutes later.
    expect(overlapped.filter(Boolean)).toHaveLength(2);
    expect(overlapped[0]).toBe(true);
    expect(overlapped[10]).toBe(true);
    expect(store.tries.size).toBe(20);
  });

  it('FR-COLL-03: stored tries have no source updated_at, which the Airflow 2.11.1 API v1 row does not carry', async () => {
    const airflow = new FakeAirflow({
      tis: [
        ti({ taskId: 'finished', updatedAt: T0 - 5 * MIN }),
        ti({ taskId: 'running', state: 'running', endAt: null, updatedAt: T0 - 2 * MIN }),
      ],
      pools: [pool()],
    });
    const store = new MemoryStore();
    const ctx = fakeContext({ airflow, store, shared });
    await afFactsCollector().collect(ctx);
    await afLiveCollector().collect(ctx);
    const tries = [...store.tries.values()];
    expect(tries.map((t) => [t.taskId, t.sourceUpdatedAt])).toEqual([
      ['finished', null],
      ['running', null],
    ]);
  });

  it('FR-COLL-03: a failed try waiting for its retry is stored under its own try number', async () => {
    const airflow = new FakeAirflow({
      tis: [ti({ taskId: 'flaky', state: 'up_for_retry', tryNumber: 1, updatedAt: T0 - 5 * MIN })],
    });
    const store = new MemoryStore();
    await afFactsCollector().collect(fakeContext({ airflow, store, shared }));
    expect([...store.tries.values()]).toMatchObject([
      { taskId: 'flaky', tryNumber: 1, state: 'up_for_retry', startAt: T0 - 9 * MIN, endAt: T0 - 5 * MIN },
    ]);
  });

  it('HM-001/HM-006: a finished try gets the ready time af.live recorded while it was scheduled', async () => {
    const airflow = new FakeAirflow({
      tis: [ti({ taskId: 'waits', state: 'scheduled', queuedAt: null, startAt: null, endAt: null })],
      pools: [pool()],
    });
    const store = new MemoryStore();
    const ctx = fakeContext({ airflow, store, shared });
    await afLiveCollector().collect(ctx);
    airflow.data.tis = [
      ti({
        taskId: 'waits',
        queuedAt: T0 + MIN,
        startAt: T0 + 2 * MIN,
        endAt: T0 + 3 * MIN,
        updatedAt: T0 + 3 * MIN,
      }),
    ];
    ctx.advance(10 * MIN);
    await afFactsCollector().collect(ctx);
    expect([...store.tries.values()].find((t) => t.taskId === 'waits')).toMatchObject({
      readyAt: T0,
      queuedAt: T0 + MIN,
      state: 'success',
    });
  });
});

describe('HM-028 af.facts: import errors every fact cycle (spec §7.5 L653, §7.7 L715)', () => {
  it('HM-028: reads GET /importErrors every cycle and patches only that health input', async () => {
    const airflow = new FakeAirflow({ importErrors: 3 });
    const store = new MemoryStore();
    await store.patchPlatformHealth('acme-prod', { envHealthyRatio: 0.98 });
    const collector = afFactsCollector();
    const ctx = fakeContext({ airflow, store, shared });
    await collector.collect(ctx);
    airflow.data.importErrors = 4;
    ctx.advance(MIN);
    await collector.collect(ctx);
    expect(airflow.calls.filter((c) => c === 'importErrors')).toHaveLength(2);
    expect(await store.platformHealth('acme-prod')).toMatchObject({ importErrors: 4, envHealthyRatio: 0.98 });
  });

  it('HM-028: the import errors take their own request, so a cycle that pages six windows still reads them', async () => {
    const airflow = new FakeAirflow({ tis: spread(350, END - H + MIN, END - MIN), importErrors: 2 });
    const store = new MemoryStore();
    const collector = afFactsCollector();
    await collector.collect(fakeContext({ airflow, store, shared }));
    expect(airflow.calls.filter((c) => c === 'taskInstances')).toHaveLength(6);
    expect(airflow.calls.at(-1)).toBe('importErrors');
    expect(collector.manifest.maxRequestsPerCycle).toBe(7);
    expect((await store.platformHealth('acme-prod')).importErrors).toBe(2);
  });

  it('FR-COLL-06: without budget for the import errors the cycle still commits its facts', async () => {
    const airflow = new FakeAirflow({ tis: [ti({ updatedAt: T0 - 5 * MIN })] }, new Budget('airflow', 1));
    const store = new MemoryStore();
    const ctx = fakeContext({ airflow, store, shared });
    const result = await afFactsCollector().collect(ctx);
    expect(store.tries.size).toBe(1);
    expect(result.dataAsOf).toBe(END);
    expect(ctx.fidelity).toEqual([expect.stringMatching(/import errors/)]);
  });
});

describe('FR-COLL-06 af.facts: windows that fit in one page, within the budget', () => {
  it('FR-COLL-06: splits a window with more rows than a page until each request fits, never paging by offset', async () => {
    const airflow = new FakeAirflow({ tis: spread(350, END - H + MIN, END - MIN) });
    const store = new MemoryStore();
    const collector = afFactsCollector();
    const ctx = fakeContext({ airflow, store, shared });
    for (let i = 0; i < 4 && store.commits.at(-1)?.watermark !== END; i++) await collector.collect(ctx);

    expect(store.tries.size).toBe(350);
    expect(store.commits.at(-1)?.watermark).toBe(END);
    expect(airflow.tiQueries.every((q) => q.offset === 0 && q.limit === 100)).toBe(true);
    // Windows are contiguous: each starts where the previous complete one ended.
    const windows = airflow.tiQueries.map((q) => [q.updatedFrom, q.updatedTo] as const);
    expect(windows[0]?.[0]).toBe(END - H);
  });

  it('FR-COLL-06: more rows than a page in the smallest window are read by offset until every key is seen', async () => {
    const same = Array.from({ length: 150 }, (_, i) =>
      ti({ taskId: `burst_${i}`, updatedAt: T0 - 20 * MIN }),
    );
    const airflow = new FakeAirflow({ tis: same });
    const store = new MemoryStore();
    const collector = afFactsCollector();
    const ctx = fakeContext({ airflow, store, shared });
    for (let i = 0; i < 6 && store.commits.at(-1)?.watermark !== END; i++) await collector.collect(ctx);
    expect(store.tries.size).toBe(150);
    expect(store.commits.at(-1)?.watermark).toBe(END);
    expect(airflow.tiQueries.some((q) => q.offset === 100)).toBe(true);
  });

  describe('a server that returns pages smaller than 100 (spec §7.5, VC-11 open)', () => {
    const capped = (tis: ReturnType<typeof ti>[], cap: number) => {
      const airflow = new FakeAirflow({ tis });
      airflow.pageCap = cap;
      return airflow;
    };
    const drain = async (airflow: FakeAirflow, cycles: number) => {
      const store = new MemoryStore();
      const collector = afFactsCollector();
      const ctx = fakeContext({ airflow, store, shared });
      for (let i = 0; i < cycles && store.commits.at(-1)?.watermark !== END; i++)
        await collector.collect(ctx);
      return store;
    };

    it('FR-COLL-06: a window with fewer rows than 100 but more than a page is split to the page the server returns', async () => {
      const airflow = capped(spread(80, END - H + MIN, END - MIN), 50);
      const store = await drain(airflow, 4);
      expect(store.tries.size).toBe(80);
      expect(store.commits.at(-1)?.watermark).toBe(END);
      // Never the same window twice in a row: a short page leads to a split, not a retry.
      const windows = airflow.tiQueries.map((q) => `${q.updatedFrom}-${q.updatedTo}-${q.offset}`);
      for (let i = 1; i < windows.length; i++) expect(windows[i]).not.toBe(windows[i - 1]);
    });

    it('FR-COLL-06: a window above 100 rows is split until each part fits the page the server returns', async () => {
      const airflow = capped(spread(350, END - H + MIN, END - MIN), 40);
      const store = await drain(airflow, 10);
      expect(store.tries.size).toBe(350);
      expect(store.commits.at(-1)?.watermark).toBe(END);
    });

    it('FR-COLL-06: a dense second is paged by the size of the pages the server returns', async () => {
      const same = Array.from({ length: 150 }, (_, i) =>
        ti({ taskId: `burst_${i}`, updatedAt: T0 - 20 * MIN }),
      );
      const airflow = capped(same, 50);
      const store = await drain(airflow, 6);
      expect(store.tries.size).toBe(150);
      expect(store.commits.at(-1)?.watermark).toBe(END);
      expect(airflow.tiQueries.filter((q) => q.offset > 0).map((q) => q.offset)).toEqual([50, 100]);
    });
  });

  describe('a second with more finished task instances than a cycle can page', () => {
    // A branch skipping 1,500 mapped tasks marks them all in one statement: one `updated_at` second. Six
    // requests a cycle read at most 600 of them; before the fix the collector stalled there for good.
    const N = 1_500;
    const BURST = T0 - 20 * MIN;
    const burst = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        ti({ taskId: 'mapped', mapIndex: i, state: 'skipped', updatedAt: BURST }),
      );
    const after = ti({ taskId: 'after_burst', updatedAt: T0 - 10 * MIN });
    const run = async (airflow: FakeAirflow, cycles: number) => {
      const store = new MemoryStore();
      const ctx = fakeContext({ airflow, store, shared });
      const collector = afFactsCollector();
      const trace: Array<{ watermark: number | null; afterStored: boolean; denseStored: number }> = [];
      for (let i = 0; i < cycles; i++) {
        await collector.collect(ctx);
        const tries = [...store.tries.values()];
        trace.push({
          watermark: await store.watermark('acme-prod', 'af.facts'),
          afterStored: tries.some((t) => t.taskId === 'after_burst'),
          denseStored: tries.filter((t) => t.taskId === 'mapped').length,
        });
        ctx.advance(MIN);
      }
      return { store, ctx, trace };
    };

    it('FR-COLL-06: reads it across cycles and stores later rows meanwhile, the watermark waiting at it', async () => {
      const { store, trace } = await run(new FakeAirflow({ tis: [...burst(N), after] }), 40);
      // While the burst is incomplete, later finished task instances are already stored ...
      const waiting = trace.filter((c) => c.afterStored && c.denseStored < N);
      expect(waiting.length).toBeGreaterThan(0);
      // ... and the watermark never passes the burst second until every row of it is stored.
      for (const c of trace) if (c.denseStored < N) expect(c.watermark ?? 0).toBeLessThanOrEqual(BURST);
      expect(store.tries.size).toBe(N + 1);
      expect(trace.at(-1)?.watermark).toBe(END + 39 * MIN);
    });

    it('FR-COLL-06: says the history is stuck at that second while it is incomplete', async () => {
      const { ctx } = await run(new FakeAirflow({ tis: [...burst(N), after] }), 40);
      const stuck = ctx.fidelity
        .map((f) => /history is stuck at (\S+): 1500 task instances changed within that second/.exec(f))
        .filter((m) => m !== null);
      expect(stuck.length).toBeGreaterThan(1);
      for (const m of stuck) {
        const at = Date.parse(m[1] as string);
        expect(at).toBeGreaterThan(BURST - 1_000);
        expect(at).toBeLessThanOrEqual(BURST);
      }
    });

    it('FR-COLL-06: after a bounded number of cycles it keeps what it read and reports the gap', async () => {
      /** Offset paging over an unstable order: past the second page, the first rows come back again. */
      class UnstableAirflow extends FakeAirflow {
        override async taskInstances(q: Parameters<FakeAirflow['taskInstances']>[0]) {
          return super.taskInstances(q.offset >= 200 ? { ...q, offset: q.offset % 200 } : q);
        }
      }
      const { store, ctx, trace } = await run(new UnstableAirflow({ tis: [...burst(700), after] }), 60);
      expect(trace.at(-1)?.denseStored).toBe(200);
      expect(trace.at(-1)?.watermark).toBe(END + 59 * MIN);
      expect(store.tries.size).toBe(201);
      expect(ctx.fidelity.some((f) => /200 of the 700 .* the other 500 are missing/.test(f))).toBe(true);
    });
  });

  it('FR-COLL-06: an exhausted budget mid-window commits nothing past the last complete window', async () => {
    const tis = spread(350, END - H + MIN, END - MIN);
    const airflow = new FakeAirflow({ tis }, new Budget('airflow', 3));
    const store = new MemoryStore();
    const ctx = fakeContext({ airflow, store, shared });
    const result = await afFactsCollector().collect(ctx);

    expect(ctx.fidelity).toHaveLength(1);
    const mark = store.commits.at(-1)?.watermark ?? null;
    if (mark !== null) {
      expect(mark).toBeLessThan(END);
      // Every row up to the watermark is stored; none after it.
      const expected = tis.filter((t) => t.updatedAt <= mark).map((t) => t.taskId);
      expect([...store.tries.keys()].length).toBe(expected.length);
      expect(result.dataAsOf).toBe(mark);
    } else expect(store.tries.size).toBe(0);

    airflow.budget.limit = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 4 && store.commits.at(-1)?.watermark !== END; i++)
      await afFactsCollector().collect(ctx);
    expect(store.tries.size).toBe(350);
  });

  it('FR-COLL-08: refuses an Airflow 3 environment', async () => {
    const ctx = fakeContext({ airflow: new FakeAirflow(), shared: { ...shared, airflowVersion: '3.1.8' } });
    await expect(afFactsCollector().collect(ctx)).rejects.toMatchObject({ kind: 'unsupported' });
  });

  it('FR-COLL-08: refuses Airflow below 2.10, whose try numbers DCAM would misread', async () => {
    const airflow = new FakeAirflow();
    const ctx = fakeContext({ airflow, shared: { ...shared, airflowVersion: '2.9.3' } });
    await expect(afFactsCollector().collect(ctx)).rejects.toMatchObject({ kind: 'unsupported' });
    expect(airflow.calls).toEqual([]);
  });

  it('FR-COLL-01: declares a standard Airflow facts collector', () => {
    expect(afFactsCollector().manifest).toMatchObject({
      id: 'af.facts',
      source: 'SRC-AF-API',
      api: 'airflow',
      cadence: 'airflowFacts',
      priority: 'standard',
      outputs: ['tries', 'health'],
      sourceKinds: ['composer', 'airflow'],
    });
  });
});
