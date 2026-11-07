import { describe, expect, it } from 'vitest';
import { afBackfillCollector, afFactsCollector, DAY_MS, FACTS_SETTLE_MS } from '../../src/index';
import {
  Budget,
  composerEntry,
  fakeContext,
  FakeAirflow,
  H,
  MemoryStore,
  MIN,
  storeKey,
  T0,
  ti,
  type FakeContext,
} from './collectors-harness';

const shared = { airflowBaseUrl: 'https://acme-composer-prod.example.test', airflowVersion: '2.11.1' };
/** af.facts' window end on its first cycle at T0: its watermark, and so the backfill's boundary. */
const A = T0 - FACTS_SETTLE_MS;
const DAY = DAY_MS;

/** `n` finished task instances spread over `[from, to)`, with distinct keys under `prefix`. */
const spread = (n: number, from: number, to: number, prefix = 't') =>
  Array.from({ length: n }, (_, i) => {
    const at = from + Math.floor(((to - from) * (i + 0.5)) / n);
    return ti({ taskId: `${prefix}_${i}`, startAt: at - MIN, endAt: at, updatedAt: at });
  });

const lastReport = (ctx: FakeContext) => ctx.reports.at(-1);

/** Runs backfill cycles a minute apart until it reports complete (or `cycles` run out). */
async function backfill(ctx: FakeContext, collector = afBackfillCollector(), cycles = 200) {
  for (let i = 0; i < cycles; i++) {
    await collector.collect(ctx);
    if (lastReport(ctx)?.state === 'complete') return i + 1;
    ctx.advance(MIN);
  }
  return cycles;
}

describe('FR-COLL-04 af.backfill: seven days of finished task instances before af.facts', () => {
  it('FR-COLL-04: waits for the first facts window, without a request', async () => {
    const airflow = new FakeAirflow({ tis: spread(50, A - DAY, A) });
    const ctx = fakeContext({ airflow, shared });
    await afBackfillCollector().collect(ctx);
    expect(airflow.calls).toEqual([]);
    expect(lastReport(ctx)).toMatchObject({ state: 'waiting', days: 7, from: null, coveredFrom: null });
    expect(await ctx.store.backfill('acme-prod', 'af.backfill')).toBeNull();
  });

  it('FR-COLL-04: reads [A − 7 days, A] newest first after af.facts committed A, and stores each row once', async () => {
    const tis = [
      ...spread(600, A - 7 * DAY, A, 'week'),
      ...spread(5, A - 9 * DAY, A - 7 * DAY - MIN, 'older'),
      ti({ taskId: 'at_boundary', updatedAt: A }),
      ti({ taskId: 'at_from', updatedAt: A - 7 * DAY }),
    ];
    const airflow = new FakeAirflow({ tis });
    const store = new MemoryStore();
    const ctx = fakeContext({ airflow, store, shared });
    await afFactsCollector().collect(ctx);
    expect(await store.watermark('acme-prod', 'af.facts')).toBe(A);
    const factsQueries = airflow.tiQueries.length;

    await backfill(ctx);
    const backfillQueries = airflow.tiQueries.slice(factsQueries);
    // Newest first: the first window read whole ends at A.
    expect(backfillQueries.find((q, i) => i > 0)?.updatedTo).toBe(A);
    expect(backfillQueries.every((q) => (q.updatedFrom ?? 0) >= A - 7 * DAY && (q.updatedTo ?? 0) <= A)).toBe(
      true,
    );
    const ids = [...store.tries.values()].map((t) => t.taskId);
    expect(ids.filter((id) => id.startsWith('week'))).toHaveLength(600);
    expect(ids.filter((id) => id.startsWith('older'))).toHaveLength(0);
    expect(ids).toContain('at_boundary');
    expect(ids).toContain('at_from');
    expect(store.tries.size).toBe(602);
    expect(await store.backfill('acme-prod', 'af.backfill')).toMatchObject({
      from: A - 7 * DAY,
      to: A,
      coveredFrom: A - 7 * DAY,
      itemsRead: expect.any(Number),
      completedAt: expect.any(Number),
    });
    expect(lastReport(ctx)).toMatchObject({ state: 'complete', etaSeconds: 0, coveredFrom: A - 7 * DAY });
  });

  it('FR-COLL-03: no gap and no double counting at the boundary with af.facts, even for rows that change meanwhile', async () => {
    const before = spread(300, A - 7 * DAY, A, 'before');
    const facts = spread(40, A - H, A + 30 * MIN, 'facts');
    const airflow = new FakeAirflow({ tis: [...before, ...facts, ti({ taskId: 'edge', updatedAt: A })] });
    const store = new MemoryStore();
    const ctx = fakeContext({ airflow, store, shared });
    const factsCollector = afFactsCollector();
    await factsCollector.collect(ctx);
    // While the backfill runs, a row it will read is marked again by hand: its updated_at moves after A.
    const marked = before[150];
    if (!marked) throw new Error('fixture');
    airflow.data.tis = airflow.data.tis.map((t) =>
      t === marked ? { ...t, state: 'failed', updatedAt: A + 20 * MIN } : t,
    );
    await backfill(ctx);
    ctx.advance(45 * MIN);
    await factsCollector.collect(ctx);

    const expected = new Set(airflow.data.tis.map((t) => storeKey('acme-prod', t)));
    expect(new Set(store.tries.keys())).toEqual(expected);
    expect(store.tries.get(storeKey('acme-prod', marked))?.state).toBe('failed');
  });

  it('FR-COLL-03: a restart resumes from the persisted progress without re-reading what is covered', async () => {
    const airflow = new FakeAirflow({ tis: spread(1_500, A - 7 * DAY, A) }, new Budget('airflow', 0));
    const store = new MemoryStore();
    const ctx = fakeContext({ airflow, store, shared });
    await store.commitFacts('acme-prod', 'af.facts', [], A);
    const first = afBackfillCollector();
    for (let i = 0; i < 4; i++) {
      airflow.budget.limit = airflow.budget.used + 3;
      await first.collect(ctx);
      ctx.advance(MIN);
    }
    const saved = await store.backfill('acme-prod', 'af.backfill');
    if (!saved) throw new Error('no progress saved');
    expect(saved.coveredFrom).toBeLessThan(A);
    expect(saved.requestsUsed).toBe(12);
    const storedBefore = store.tries.size;
    expect(storedBefore).toBe(airflow.data.tis.filter((t) => t.updatedAt >= saved.coveredFrom).length);

    // Restart: a new collector with the same store.
    const seen = airflow.tiQueries.length;
    airflow.budget.limit = Number.POSITIVE_INFINITY;
    await backfill(ctx, afBackfillCollector());
    const after = airflow.tiQueries.slice(seen);
    expect(after.every((q) => (q.updatedTo ?? Infinity) <= saved.coveredFrom)).toBe(true);
    expect(after[0]?.updatedFrom).toBe(A - 7 * DAY);
    expect(store.tries.size).toBe(1_500);
    const done = await store.backfill('acme-prod', 'af.backfill');
    expect(done?.requestsUsed).toBe(12 + after.length);
    expect(done?.startedAt).toBe(saved.startedAt);
  });

  it('FR-COLL-04: yielding to the budget is progress, not reduced fidelity', async () => {
    const airflow = new FakeAirflow({ tis: spread(800, A - 7 * DAY, A) }, new Budget('airflow', 2));
    const store = new MemoryStore();
    const ctx = fakeContext({ airflow, store, shared });
    await store.commitFacts('acme-prod', 'af.facts', [], A);
    await afBackfillCollector().collect(ctx);
    expect(ctx.fidelity).toEqual([]);
    expect(lastReport(ctx)).toMatchObject({ state: 'running', requestsUsed: 2, to: A, from: A - 7 * DAY });
  });

  it('FR-COLL-04: reports an ETA from the observed rate once five minutes are observed', async () => {
    const airflow = new FakeAirflow({ tis: spread(3_000, A - 7 * DAY, A) }, new Budget('airflow', 0));
    const store = new MemoryStore();
    const ctx = fakeContext({ airflow, store, shared });
    await store.commitFacts('acme-prod', 'af.facts', [], A);
    const collector = afBackfillCollector();
    const etas: Array<number | null> = [];
    for (let i = 0; i < 12; i++) {
      airflow.budget.limit = airflow.budget.used + 2;
      await collector.collect(ctx);
      etas.push(lastReport(ctx)?.etaSeconds ?? null);
      ctx.advance(MIN);
    }
    expect(etas.slice(0, 5).every((e) => e === null)).toBe(true);
    const eta = etas.at(-1);
    if (eta === null || eta === undefined) throw new Error('no ETA');
    // Actual: keep going at the same pace and see how long it takes.
    const at = ctx.now();
    for (let i = 0; i < 500 && lastReport(ctx)?.state !== 'complete'; i++) {
      airflow.budget.limit = airflow.budget.used + 2;
      ctx.advance(MIN);
      await collector.collect(ctx);
    }
    const actual = (ctx.now() - at) / 1_000;
    expect(eta).toBeGreaterThan(actual * 0.7);
    expect(eta).toBeLessThan(actual * 1.3);
  });

  it('FR-COLL-04: 0 days turns it off; more days later extend it further back', async () => {
    const airflow = new FakeAirflow({ tis: spread(200, A - 10 * DAY, A) });
    const store = new MemoryStore();
    await store.commitFacts('acme-prod', 'af.facts', [], A);
    const off = fakeContext({
      airflow,
      store,
      shared,
      env: { ...composerEntry, backfill: { taskInstancesDays: 0, metricsDays: 14 } },
    });
    await afBackfillCollector().collect(off);
    expect(airflow.calls).toEqual([]);
    expect(lastReport(off)).toMatchObject({ state: 'disabled', days: 0 });

    const seven = fakeContext({ airflow, store, shared });
    await backfill(seven);
    expect(store.tries.size).toBe(140);
    const nine = fakeContext({
      airflow,
      store,
      shared,
      env: { ...composerEntry, backfill: { taskInstancesDays: 9, metricsDays: 14 } },
    });
    await backfill(nine);
    expect(store.tries.size).toBe(180);
    expect(lastReport(nine)).toMatchObject({ state: 'complete', days: 9, from: A - 9 * DAY });
  });

  it('FR-COLL-08: refuses an Airflow 3 environment', async () => {
    const ctx = fakeContext({ airflow: new FakeAirflow(), shared: { ...shared, airflowVersion: '3.1.8' } });
    await expect(afBackfillCollector().collect(ctx)).rejects.toMatchObject({ kind: 'unsupported' });
  });

  it('FR-COLL-01: declares a background Airflow backfill collector', () => {
    expect(afBackfillCollector().manifest).toMatchObject({
      id: 'af.backfill',
      source: 'SRC-AF-API',
      api: 'airflow',
      cadence: 'airflowFacts',
      priority: 'background',
      outputs: ['tries'],
      sourceKinds: ['composer', 'airflow'],
      backfill: 'task_instances',
    });
  });
});
