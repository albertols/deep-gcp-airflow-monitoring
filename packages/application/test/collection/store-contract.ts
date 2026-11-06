/**
 * One contract for every {@link CollectionStore}: the in-memory fake the collector tests use and the DuckDB
 * store must behave alike, or collector tests prove nothing about production. Each package runs these cases
 * against its own store (`store-contract.test.ts` here, `contract.test.ts` in `@dcam/duckdb-store`).
 * Fictitious `acme_*` data only.
 */
import type { ExpectStatic } from 'vitest';
import type { CollectionStore, StoredTaskTry, TryKey } from '@dcam/ports';

export interface StoreContractCase {
  readonly name: string;
  run(store: CollectionStore, expect: ExpectStatic): Promise<void>;
}

const ENV = 'acme-prod';
const T0 = Date.UTC(2026, 10, 5, 12, 0, 0);
const S = 1_000;
const MIN = 60 * S;
const DAY = 24 * 60 * MIN;

const tryRow = (over: Partial<StoredTaskTry> = {}): StoredTaskTry => ({
  envId: ENV,
  dagId: 'acme_orders_daily',
  runId: 'scheduled__2026-11-05T11:00:00+00:00',
  taskId: 'load',
  mapIndex: -1,
  tryNumber: 1,
  pool: 'default_pool',
  poolSlots: 1,
  state: 'success',
  queuedAt: T0 - MIN,
  startAt: T0,
  endAt: T0 + 5 * MIN,
  sourceUpdatedAt: null,
  readyAt: null,
  operator: 'PythonOperator',
  ...over,
});

/** A try as `af.live` stores it: running, no end, seen running at `seenAt`. */
const runningRow = (over: Partial<StoredTaskTry> = {}, seenAt = T0 + MIN): StoredTaskTry =>
  tryRow({ state: 'running', endAt: null, seenRunningAt: seenAt, ...over });

const keyOf = (t: TryKey): TryKey => ({
  dagId: t.dagId,
  runId: t.runId,
  taskId: t.taskId,
  mapIndex: t.mapIndex,
  tryNumber: t.tryNumber,
});

/** Every stored try of the environment, by task id and try number. */
async function all(store: CollectionStore) {
  const tries = await store.taskTries(ENV, 0, T0 + DAY);
  return new Map(tries.map((t) => [`${t.taskId}#${t.tryNumber}`, t]));
}

export const STORE_CONTRACT: readonly StoreContractCase[] = [
  {
    name: 'FR-COLL-03: a running row never replaces a stored try that has a true end (af.live races af.facts)',
    async run(store, expect) {
      await store.upsertTaskTries([tryRow()]);
      await store.upsertTaskTries([runningRow()]);
      expect((await all(store)).get('load#1')).toMatchObject({
        state: 'success',
        endAt: T0 + 5 * MIN,
        endEstimated: false,
      });
    },
  },
  {
    name: 'FR-COLL-03: a finished row replaces a running one, and the true row replaces an estimated end',
    async run(store, expect) {
      await store.upsertTaskTries([runningRow()]);
      await store.closeRunningTries(ENV, [], T0 + 2 * MIN);
      expect((await all(store)).get('load#1')).toMatchObject({ endEstimated: true });
      await store.upsertTaskTries([tryRow()]);
      expect((await all(store)).get('load#1')).toMatchObject({
        state: 'success',
        endAt: T0 + 5 * MIN,
        endEstimated: false,
      });
    },
  },
  {
    name: 'HM-003: a try running again after an estimated end (resumed from deferral) is open again',
    async run(store, expect) {
      await store.upsertTaskTries([runningRow()]);
      await store.closeRunningTries(ENV, [], T0 + 2 * MIN);
      await store.upsertTaskTries([runningRow({}, T0 + 4 * MIN)]);
      expect((await all(store)).get('load#1')).toMatchObject({
        state: 'running',
        endAt: null,
        endEstimated: false,
      });
    },
  },
  {
    name: 'HM-003: a complete running set ends every other running try when it was last seen running, estimated',
    async run(store, expect) {
      await store.upsertTaskTries([
        runningRow({ taskId: 'gone' }, T0 + MIN),
        runningRow({ taskId: 'still' }, T0 + MIN),
        runningRow({ taskId: 'unseen', seenRunningAt: null }),
        tryRow({ taskId: 'done' }),
      ]);
      await store.upsertTaskTries([{ ...runningRow({ taskId: 'gone' }), envId: 'acme-dev' }]);
      await store.closeRunningTries(ENV, [keyOf(runningRow({ taskId: 'still' }))], T0 + 2 * MIN);
      const tries = await all(store);
      expect(tries.get('gone#1')).toMatchObject({ state: null, endAt: T0 + MIN, endEstimated: true });
      // Never seen running by this DCAM version: the snapshot time is the only bound.
      expect(tries.get('unseen#1')).toMatchObject({ state: null, endAt: T0 + 2 * MIN, endEstimated: true });
      expect(tries.get('still#1')).toMatchObject({ state: 'running', endAt: null, endEstimated: false });
      expect(tries.get('done#1')).toMatchObject({
        state: 'success',
        endAt: T0 + 5 * MIN,
        endEstimated: false,
      });
      const other = await store.taskTries('acme-dev', 0, T0 + DAY);
      expect(other.map((t) => [t.taskId, t.endAt])).toEqual([['gone', null]]);
    },
  },
  {
    name: 'HM-003: a later try closes the open earlier try at its earliest known time, estimated',
    async run(store, expect) {
      await store.upsertTaskTries([runningRow({ taskId: 'flaky' })]);
      await store.upsertTaskTries([
        tryRow({
          taskId: 'flaky',
          tryNumber: 2,
          queuedAt: T0 + 7 * MIN,
          startAt: T0 + 8 * MIN,
          endAt: T0 + 9 * MIN,
        }),
      ]);
      expect((await all(store)).get('flaky#1')).toMatchObject({
        state: null,
        endAt: T0 + 7 * MIN,
        endEstimated: true,
      });
    },
  },
  {
    name: 'HM-003: a later try stored first still closes an earlier try written open afterwards',
    async run(store, expect) {
      await store.upsertTaskTries([
        runningRow({ taskId: 'flaky', tryNumber: 2, queuedAt: null, startAt: T0 + 8 * MIN }, T0 + 8 * MIN),
      ]);
      await store.upsertTaskTries([runningRow({ taskId: 'flaky' })]);
      expect((await all(store)).get('flaky#1')).toMatchObject({ endAt: T0 + 8 * MIN, endEstimated: true });
      expect((await all(store)).get('flaky#2')).toMatchObject({ endAt: null, endEstimated: false });
    },
  },
  {
    name: 'HM-003: an estimated end is never before the try started',
    async run(store, expect) {
      await store.upsertTaskTries([runningRow({ taskId: 'flaky', startAt: T0 + 3 * MIN })]);
      await store.upsertTaskTries([tryRow({ taskId: 'flaky', tryNumber: 2, queuedAt: T0 - 10 * MIN })]);
      expect((await all(store)).get('flaky#1')).toMatchObject({ endAt: T0 + 3 * MIN, endEstimated: true });
    },
  },
  {
    name: 'HM-006: a recorded ready time fills a try stored without one; a stored ready time is kept',
    async run(store, expect) {
      await store.recordReady(ENV, [keyOf(tryRow({ taskId: 'recorded' }))], T0 - 2 * MIN);
      await store.upsertTaskTries([
        tryRow({ taskId: 'recorded' }),
        tryRow({ taskId: 'explicit', readyAt: T0 - 3 * MIN }),
        runningRow({ taskId: 'kept', readyAt: T0 - 4 * MIN }),
      ]);
      await store.upsertTaskTries([tryRow({ taskId: 'kept' })]);
      const tries = await all(store);
      expect(tries.get('recorded#1')?.readyAt).toBe(T0 - 2 * MIN);
      expect(tries.get('explicit#1')?.readyAt).toBe(T0 - 3 * MIN);
      expect(tries.get('kept#1')?.readyAt).toBe(T0 - 4 * MIN);
    },
  },
];
