import { describe, expect, it } from 'vitest';
import { openStore } from '../src/index';
import { ENV, T0, config, dag, health, sample, snapshot, tryRow } from './fixtures';

const key = (over: Partial<ReturnType<typeof tryRow>> = {}) => {
  const { dagId, runId, taskId, mapIndex, tryNumber } = tryRow(over);
  return { dagId, runId, taskId, mapIndex, tryNumber };
};

// Real DuckDB I/O on a shared 4-vCPU runner: Vitest's default 5 s is too tight (see store.test.ts).
describe('CollectionStore round trips (migration 0004)', { timeout: 60_000 }, () => {
  it('FR-STORE-01: migration 0004 is applied after 0001-0003', async () => {
    const store = await openStore({ path: ':memory:' });
    expect(await store.appliedMigrations()).toEqual([
      '0001_initial',
      '0002_staging',
      '0003_ready_operator',
      '0004_collection',
    ]);
    store.close();
  });

  it('FR-COLL-03: environment configuration round-trips and the latest save wins', async () => {
    const store = await openStore({ path: ':memory:' });
    expect(await store.config(ENV)).toBeNull();
    await store.saveConfig(ENV, config({ parallelism: 32 }));
    await store.saveConfig(ENV, config());
    await store.saveConfig('acme-dev', config({ envId: 'acme-dev', tier: 'dev' }));
    expect(await store.config(ENV)).toEqual(config());
    expect(await store.config('acme-dev')).toEqual(config({ envId: 'acme-dev', tier: 'dev' }));
    store.close();
  });

  it('FR-COLL-03: DAG metadata round-trips, upserted by DAG id (pages may be saved one at a time)', async () => {
    const store = await openStore({ path: ':memory:' });
    expect(await store.dags(ENV)).toEqual([]);
    await store.saveDags(ENV, [
      dag('acme_orders_daily'),
      dag('acme_billing_hourly', { schedule: '@hourly' }),
    ]);
    await store.saveDags(ENV, [
      dag('acme_orders_daily', { paused: true, tags: [], owners: [] }),
      dag('acme_zz'),
    ]);
    await store.saveDags('acme-dev', [dag('acme_dev_only')]);
    expect(await store.dags(ENV)).toEqual([
      dag('acme_billing_hourly', { schedule: '@hourly' }),
      dag('acme_orders_daily', { paused: true, tags: [], owners: [] }),
      dag('acme_zz'),
    ]);
    store.close();
  });

  it('FR-COLL-03: saving 2,000 DAGs (the reference inventory) is quick', async () => {
    const store = await openStore({ path: ':memory:' });
    const dags = Array.from({ length: 2_000 }, (_, i) => dag(`acme_dag_${String(i).padStart(4, '0')}`));
    const started = performance.now();
    await store.saveDags(ENV, dags);
    // Regression bound, not a benchmark (about 50 ms on a laptop).
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(await store.dags(ENV)).toHaveLength(2_000);
    store.close();
  });

  it('HM-028: platform health round-trips; an environment without data reads as all null', async () => {
    const store = await openStore({ path: ':memory:' });
    expect(Object.values(await store.platformHealth(ENV)).every((v) => v === null)).toBe(true);
    expect(Object.keys(await store.platformHealth(ENV)).sort()).toEqual(Object.keys(health).sort());
    await store.savePlatformHealth(ENV, { ...health, importErrors: 9 });
    await store.savePlatformHealth(ENV, health);
    expect(await store.platformHealth(ENV)).toEqual(health);
    store.close();
  });

  it('HM-006: live snapshots round-trip, from <= at < to, oldest first; a repeated at replaces', async () => {
    const store = await openStore({ path: ':memory:' });
    await store.saveSnapshot(ENV, snapshot(T0 + 60_000));
    await store.saveSnapshot(ENV, snapshot(T0));
    await store.saveSnapshot(ENV, { ...snapshot(T0 + 30_000), queued: snapshot(0).scheduled });
    await store.saveSnapshot(ENV, snapshot(T0 + 30_000));
    await store.saveSnapshot('acme-dev', snapshot(T0));
    expect(await store.snapshots(ENV, T0, T0 + 60_000)).toEqual([snapshot(T0), snapshot(T0 + 30_000)]);
    expect(await store.snapshots(ENV, T0 + 1, T0 + 60_001)).toEqual([
      snapshot(T0 + 30_000),
      snapshot(T0 + 60_000),
    ]);
    store.close();
  });

  it('FR-COLL-07: worker samples round-trip and upsert by at (a re-read trailing window replaces)', async () => {
    const store = await openStore({ path: ':memory:' });
    await store.saveWorkerSamples(ENV, [sample(T0), sample(T0 + 60_000), sample(T0 + 120_000)]);
    await store.saveWorkerSamples(ENV, [sample(T0 + 60_000, { workers: 3, cpu: 0.9 }), sample(T0 + 180_000)]);
    await store.saveWorkerSamples('acme-dev', [sample(T0)]);
    expect(await store.workerSamples(ENV, T0, T0 + 180_000)).toEqual([
      sample(T0),
      sample(T0 + 60_000, { workers: 3, cpu: 0.9 }),
      sample(T0 + 120_000),
    ]);
    store.close();
  });

  it('HM-006: first-seen ready times keep the earliest and fill readyAt of tries stored without one', async () => {
    const store = await openStore({ path: ':memory:' });
    await store.recordReady(ENV, [key(), key({ taskId: 'explicit' })], T0 - 20_000);
    await store.recordReady(ENV, [key()], T0 - 30_000);
    await store.recordReady(ENV, [key(), key()], T0 - 10_000);
    await store.recordReady('acme-dev', [key({ taskId: 'unknown' })], T0 - 40_000);
    await store.upsertTaskTries([
      tryRow(),
      tryRow({ taskId: 'explicit', readyAt: T0 - 1_000 }),
      tryRow({ taskId: 'unknown' }),
    ]);
    const byId = new Map((await store.taskTries(ENV, T0, T0 + 1)).map((t) => [t.taskId, t.readyAt]));
    expect(byId).toEqual(
      new Map([
        ['load', T0 - 30_000],
        ['explicit', T0 - 1_000],
        ['unknown', null],
      ]),
    );
    store.close();
  });

  it('HM-006: re-upserting a try without readyAt keeps the ready time it already has', async () => {
    const store = await openStore({ path: ':memory:' });
    await store.upsertTaskTries([tryRow({ readyAt: T0 - 7_000, state: 'running', endAt: null })]);
    await store.upsertTaskTries([tryRow()]);
    const [only] = await store.taskTries(ENV, T0, T0 + 1);
    expect(only).toMatchObject({ state: 'success', readyAt: T0 - 7_000 });
    store.close();
  });

  it('FR-COLL-03: a watermark is null before the first commit, then the committed value per collector', async () => {
    const store = await openStore({ path: ':memory:' });
    expect(await store.watermark(ENV, 'af.facts')).toBeNull();
    await store.commitFacts(ENV, 'af.facts', [tryRow()], T0 + 60_007);
    await store.commitFacts(ENV, 'af.facts', [], T0 + 90_011);
    expect(await store.watermark(ENV, 'af.facts')).toBe(T0 + 90_011);
    expect(await store.watermark(ENV, 'af.inventory')).toBeNull();
    expect(await store.watermark('acme-dev', 'af.facts')).toBeNull();
    expect(await store.countTaskTries(ENV)).toBe(1);
    store.close();
  });

  it('FR-COLL-03: commitFacts refuses tries of another environment', async () => {
    const store = await openStore({ path: ':memory:' });
    await expect(store.commitFacts(ENV, 'af.facts', [tryRow({ envId: 'acme-dev' })], T0)).rejects.toThrow(
      /acme-dev/,
    );
    expect(await store.watermark(ENV, 'af.facts')).toBeNull();
    store.close();
  });

  it('FR-STORE-06: a failure inside commitFacts leaves the previous tries and watermark intact', async () => {
    const store = await openStore({ path: ':memory:' });
    await store.commitFacts(ENV, 'af.facts', [tryRow({ state: 'running', endAt: null })], T0);
    const before = await store.taskTries(ENV, T0, T0 + 1);
    // The second row breaks a NOT NULL constraint inside the transaction, after the first row is staged.
    const broken = tryRow({ taskId: 'broken', pool: null as unknown as string });
    await expect(
      store.commitFacts(ENV, 'af.facts', [tryRow({ state: 'success' }), broken], T0 + 60_000),
    ).rejects.toThrow();
    expect(await store.watermark(ENV, 'af.facts')).toBe(T0);
    expect(await store.taskTries(ENV, T0, T0 + 1)).toEqual(before);
    // The store is still usable after the rollback.
    await store.commitFacts(ENV, 'af.facts', [tryRow({ state: 'success' })], T0 + 60_000);
    expect(await store.watermark(ENV, 'af.facts')).toBe(T0 + 60_000);
    store.close();
  });

  it('FR-STORE-06: concurrent writes never share a transaction', async () => {
    const store = await openStore({ path: ':memory:' });
    const broken = tryRow({ taskId: 'broken', pool: null as unknown as string });
    const results = await Promise.allSettled([
      store.commitFacts(ENV, 'af.facts', [tryRow(), broken], T0),
      store.saveSnapshot(ENV, snapshot(T0)),
      store.saveWorkerSamples(ENV, [sample(T0)]),
      store.commitFacts(ENV, 'af.facts', [tryRow({ taskId: 'other' })], T0 + 1),
    ]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled', 'fulfilled', 'fulfilled']);
    expect(await store.snapshots(ENV, T0, T0 + 1)).toEqual([snapshot(T0)]);
    expect(await store.workerSamples(ENV, T0, T0 + 1)).toEqual([sample(T0)]);
    expect((await store.taskTries(ENV, T0, T0 + 1)).map((t) => t.taskId)).toEqual(['other']);
    expect(await store.watermark(ENV, 'af.facts')).toBe(T0 + 1);
    store.close();
  });

  it('FR-STORE-02: prune removes snapshots, samples and ready times older than the cut-off', async () => {
    const store = await openStore({ path: ':memory:' });
    await store.saveSnapshot(ENV, snapshot(T0 - 1));
    await store.saveSnapshot(ENV, snapshot(T0));
    await store.saveWorkerSamples(ENV, [sample(T0 - 60_000), sample(T0)]);
    await store.recordReady(ENV, [key({ taskId: 'old' })], T0 - 1);
    await store.recordReady(ENV, [key({ taskId: 'new' })], T0);
    await store.prune(T0);
    expect(await store.snapshots(ENV, 0, T0 + 1)).toEqual([snapshot(T0)]);
    expect(await store.workerSamples(ENV, 0, T0 + 1)).toEqual([sample(T0)]);
    await store.upsertTaskTries([tryRow({ taskId: 'old' }), tryRow({ taskId: 'new' })]);
    const ready = new Map((await store.taskTries(ENV, T0, T0 + 1)).map((t) => [t.taskId, t.readyAt]));
    expect(ready).toEqual(
      new Map([
        ['old', null],
        ['new', T0],
      ]),
    );
    store.close();
  });
});
