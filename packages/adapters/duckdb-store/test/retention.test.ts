import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LiveSnapshot } from '@dcam/domain';
import { DuckDBInstance } from '@duckdb/node-api';
import { DB_FILE_NAME, MIGRATIONS, openFileStore, openStore, type DuckDbStore } from '../src/index';
import { ENV, T0, sample, snapshot, tempDir, tryRow } from './fixtures';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const OTHER = 'acme-dev';
const THIN = { bucketMs: 5 * MIN, fallbackCadenceMs: 30_000 } as const;
const key = (taskId: string) => ({
  dagId: 'acme_orders_daily',
  runId: 'scheduled__2026-11-01T00:00:00+00:00',
  taskId,
  mapIndex: -1,
  tryNumber: 1,
});

/** Every try of the environment, whatever its times. */
const allTries = async (store: DuckDbStore, envId = ENV) =>
  (await store.taskTries(envId, 0, Number.MAX_SAFE_INTEGER)).map((t) => t.taskId).sort();

/** Saves one snapshot every `stepMs` in [from, to), in one transaction. */
async function saveSnapshots(store: DuckDbStore, envId: string, from: number, to: number, stepMs: number) {
  const snapshots = [];
  for (let at = from; at < to; at += stepMs) snapshots.push(snapshot(at));
  await store.saveSnapshots(envId, snapshots);
}

// Real DuckDB I/O on a shared 4-vCPU runner: Vitest's default 5 s is too tight (see store.test.ts).
describe(
  'FR-STORE-02 / FR-STORE-07 retention in the DuckDB store (migration 0007)',
  { timeout: 60_000 },
  () => {
    it('FR-STORE-02: deleteExpired deletes exactly the rows older than the cut-off, per environment and family', async () => {
      const store = await openStore({ path: ':memory:' });
      await store.saveSnapshot(ENV, snapshot(T0 - 1));
      await store.saveSnapshot(ENV, snapshot(T0));
      await store.saveSnapshot(OTHER, snapshot(T0 - 1));
      await store.saveWorkerSamples(ENV, [sample(T0 - MIN), sample(T0)]);
      await store.recordReady(ENV, [key('ready-old')], T0 - 1);
      await store.recordReady(ENV, [key('ready-new')], T0);
      await store.upsertTaskTries([
        tryRow({ taskId: 'ended-before', startAt: T0 - HOUR, endAt: T0 - 1 }),
        tryRow({ taskId: 'ended-at', startAt: T0 - HOUR, endAt: T0 }),
        // Started before the cut-off and still running: it overlaps every window from now on.
        tryRow({ taskId: 'open', startAt: T0 - DAY, endAt: null, state: 'running' }),
        // Never started (upstream_failed): as old as its queued time.
        tryRow({ taskId: 'never-started', startAt: null, endAt: null, queuedAt: T0 - 1, state: null }),
        tryRow({ envId: OTHER, taskId: 'other-env', startAt: T0 - HOUR, endAt: T0 - 1 }),
      ]);

      expect(await store.deleteExpired(ENV, 'snapshots', T0, 1_000)).toBe(1);
      expect(await store.deleteExpired(ENV, 'worker-samples', T0, 1_000)).toBe(1);
      expect(await store.deleteExpired(ENV, 'ready-times', T0, 1_000)).toBe(1);
      expect(await store.deleteExpired(ENV, 'task-tries', T0, 1_000)).toBe(2);

      expect((await store.snapshots(ENV, 0, T0 + 1)).map((s) => s.at)).toEqual([T0]);
      expect((await store.snapshots(OTHER, 0, T0 + 1)).map((s) => s.at)).toEqual([T0 - 1]);
      expect((await store.workerSamples(ENV, 0, T0 + 1)).map((s) => s.at)).toEqual([T0]);
      expect(await allTries(store)).toEqual(['ended-at', 'open']);
      expect(await store.countTaskTries(ENV)).toBe(2);
      expect(await allTries(store, OTHER)).toEqual(['other-env']);
      // The kept ready time still reaches the try stored later; the deleted one does not.
      await store.upsertTaskTries([tryRow({ taskId: 'ready-old' }), tryRow({ taskId: 'ready-new' })]);
      const ready = new Map((await store.taskTries(ENV, T0, T0 + 1)).map((t) => [t.taskId, t.readyAt]));
      expect(ready.get('ready-old')).toBeNull();
      expect(ready.get('ready-new')).toBe(T0);
      store.close();
    });

    it('FR-STORE-02: deletes in batches of at most `limit` rows and records the horizon with the first batch', async () => {
      const store = await openStore({ path: ':memory:' });
      await saveSnapshots(store, ENV, T0 - 25 * MIN, T0 + 5 * MIN, MIN);
      expect(await store.horizon(ENV, 'snapshots')).toEqual({ deletedBefore: null, thinnedBefore: null });
      expect(await store.deleteExpired(ENV, 'snapshots', T0, 10)).toBe(10);
      expect(await store.horizon(ENV, 'snapshots')).toEqual({ deletedBefore: T0, thinnedBefore: null });
      expect(await store.deleteExpired(ENV, 'snapshots', T0, 10)).toBe(10);
      expect(await store.deleteExpired(ENV, 'snapshots', T0, 10)).toBe(5);
      expect(await store.deleteExpired(ENV, 'snapshots', T0, 10)).toBe(0);
      expect(await store.snapshots(ENV, 0, T0 + HOUR)).toHaveLength(5);
      // An earlier cut-off never moves the horizon back.
      await store.deleteExpired(ENV, 'snapshots', T0 - DAY, 10);
      expect((await store.snapshotHorizon(ENV)).deletedBefore).toBe(T0);
      expect((await store.horizon(OTHER, 'snapshots')).deletedBefore).toBeNull();
      store.close();
    });

    it('FR-STORE-02: lists every environment with retained data and the oldest row that can expire', async () => {
      const store = await openStore({ path: ':memory:' });
      await store.saveSnapshot(ENV, snapshot(T0));
      await store.saveWorkerSamples('acme-gone', [sample(T0 - HOUR)]);
      await store.upsertTaskTries([
        tryRow({ envId: OTHER, taskId: 'open', startAt: T0 - DAY, endAt: null, state: 'running' }),
        tryRow({ envId: OTHER, taskId: 'done', startAt: T0 - 2 * HOUR, endAt: T0 - HOUR }),
      ]);
      expect(await store.retainedEnvironments()).toEqual(['acme-dev', 'acme-gone', 'acme-prod']);
      expect(await store.oldest(ENV, 'snapshots')).toBe(T0);
      expect(await store.oldest('acme-gone', 'worker-samples')).toBe(T0 - HOUR);
      // The open try never expires, so the oldest task try is the one that ended an hour ago.
      expect(await store.oldest(OTHER, 'task-tries')).toBe(T0 - HOUR);
      expect(await store.oldest(ENV, 'task-tries')).toBeNull();
      store.close();
    });

    it('FR-STORE-07: a snapshot round-trips its span, and a raw one has none', async () => {
      const store = await openStore({ path: ':memory:' });
      const thinned: LiveSnapshot = { ...snapshot(T0), spanMs: 5 * MIN };
      await store.saveSnapshot(ENV, thinned);
      await store.saveSnapshot(ENV, snapshot(T0 + 5 * MIN));
      const [a, b] = await store.snapshots(ENV, T0, T0 + HOUR);
      expect(a).toEqual(thinned);
      expect(b).toEqual(snapshot(T0 + 5 * MIN));
      expect(b && 'spanMs' in b).toBe(false);
      store.close();
    });

    it('FR-STORE-07: thinSnapshots keeps one snapshot per 5 minutes with its span, a day per call, and is idempotent', async () => {
      const store = await openStore({ path: ':memory:' });
      // 26 h of snapshots a minute, starting on a day boundary; thin everything older than the last 2 h.
      const start = Math.floor(T0 / DAY) * DAY;
      const before = start + 24 * HOUR;
      await saveSnapshots(store, ENV, start, start + 26 * HOUR, MIN);
      await saveSnapshots(store, OTHER, start, start + HOUR, MIN);

      const first = await store.thinSnapshots(ENV, { ...THIN, before: before + 2 * MIN });
      expect(first).toEqual({ dropped: 288 * 4, done: true });
      expect(await store.thinSnapshots(ENV, { ...THIN, before })).toEqual({ dropped: 0, done: true });

      const thinned = await store.snapshots(ENV, start, before);
      expect(thinned).toHaveLength(288);
      for (const [i, s] of thinned.entries()) {
        expect(Math.floor((s.at - start) / (5 * MIN))).toBe(i);
        expect(s.spanMs).toBe(5 * MIN);
      }
      // The last 2 h stay raw, as does the other environment.
      const raw = await store.snapshots(ENV, before, start + 26 * HOUR);
      expect(raw).toHaveLength(120);
      expect(raw.every((s) => s.spanMs === undefined)).toBe(true);
      expect(await store.snapshots(OTHER, start, start + HOUR)).toHaveLength(60);
      expect(await store.snapshotHorizon(ENV)).toEqual({ deletedBefore: null, thinnedBefore: before });
      store.close();
    });

    it('FR-STORE-07: thinning keeps the payload of the kept snapshot, coverage included, also one stored before migration 0007', async () => {
      const sampled = (at: number) => ({
        ...snapshot(at),
        coverage: { read: 100, total: 250, complete: false },
      });
      const dir = tempDir();
      const old = await openFileStore({
        dataDir: dir,
        migrations: MIGRATIONS.filter((m) => m.id !== '0007_retention'),
      });
      old.close();
      // Written by the payload alone, as DCAM before migration 0007 did.
      const raw = await DuckDBInstance.create(join(dir, DB_FILE_NAME));
      const con = await raw.connect();
      const first = T0 - (T0 % (5 * MIN));
      await con.run(`INSERT INTO fact.live_snapshot VALUES ($1, to_timestamp($2), $3)`, [
        ENV,
        first / 1000,
        JSON.stringify(sampled(first)),
      ]);
      con.closeSync();
      raw.closeSync();
      const store = await openFileStore({ dataDir: dir });
      const start = T0 - (T0 % (5 * MIN));
      await store.saveSnapshots(ENV, [
        sampled(start + MIN),
        sampled(start + 2 * MIN),
        sampled(start + 5 * MIN),
      ]);
      await store.thinSnapshots(ENV, { ...THIN, before: start + 10 * MIN });
      const kept = await store.snapshots(ENV, start, start + 10 * MIN);
      // 60 + 60 + 120 s (the 3-minute gap is capped at two 60 s cadences); the lone one stands for 60 s.
      expect(kept.map((s) => s.spanMs)).toEqual([4 * MIN, MIN]);
      expect(kept[0]?.at).toBeLessThan(start + 5 * MIN);
      for (const s of kept) expect(s).toEqual({ ...sampled(s.at), spanMs: s.spanMs });
      store.close();
    });

    it('FR-STORE-02: at reference scale one delete batch holds the write queue for well under a second', async () => {
      // About two days of tries at 2,000 DAGs (NFR-SCALE-02: up to 200,000 a day); half of them expired.
      const store = await openStore({ path: ':memory:' });
      for (let part = 0; part < 4; part++)
        await store.upsertTaskTries(
          Array.from({ length: 25_000 }, (_, i) => {
            const end = T0 - DAY + (part * 25_000 + i) * 1_000;
            return tryRow({ taskId: `t${part}_${i}`, startAt: end - 60_000, endAt: end });
          }),
        );
      const slowest = { ms: 0 };
      let batches = 0;
      for (;;) {
        const started = performance.now();
        const deleted = await store.deleteExpired(ENV, 'task-tries', T0 - DAY + 50_000_000, 5_000);
        slowest.ms = Math.max(slowest.ms, performance.now() - started);
        batches++;
        if (deleted < 5_000) break;
      }
      expect(batches).toBe(11);
      expect(await store.countTaskTries(ENV)).toBe(50_000);
      // Regression bound, not a benchmark (tens of ms a batch on a laptop).
      expect(slowest.ms).toBeLessThan(2_000);
      store.close();
    });

    it('FR-STORE-07: thinning more than a day takes one call per day, oldest first', async () => {
      const store = await openStore({ path: ':memory:' });
      const start = Math.floor(T0 / DAY) * DAY;
      await saveSnapshots(store, ENV, start, start + 2 * DAY + HOUR, (5 * MIN) / 2);
      const options = { ...THIN, before: start + 2 * DAY };
      expect(await store.thinSnapshots(ENV, options)).toEqual({ dropped: 288, done: false });
      expect((await store.snapshotHorizon(ENV)).thinnedBefore).toBe(start + DAY);
      expect(await store.thinSnapshots(ENV, options)).toEqual({ dropped: 288, done: true });
      expect(await store.snapshots(ENV, start, start + 2 * DAY)).toHaveLength(2 * 288);
      store.close();
    });

    it('FR-STORE-07: storageUsage measures the file and the blocks in use; deletes and CHECKPOINT reduce what is in use', async () => {
      const dataDir = join(tempDir(), 'data');
      const store = await openFileStore({ dataDir });
      const empty = await store.storageUsage();
      expect(empty.fileBytes).toBeGreaterThan(0);
      for (let i = 0; i < 4; i++)
        await store.upsertTaskTries(
          Array.from({ length: 25_000 }, (_, j) =>
            tryRow({ taskId: `t${i}_${j}`, startAt: T0 - DAY + j, endAt: T0 - DAY + j + 1 }),
          ),
        );
      await store.checkpoint();
      const full = await store.storageUsage();
      expect(full.usedBytes).toBeGreaterThan(empty.usedBytes);
      expect(full.fileBytes).toBeGreaterThanOrEqual(full.usedBytes);
      while ((await store.deleteExpired(ENV, 'task-tries', T0, 50_000)) > 0);
      await store.checkpoint();
      const after = await store.storageUsage();
      expect(after.usedBytes).toBeLessThan(full.usedBytes);
      // DuckDB reuses freed blocks before it grows the file; it does not shrink it.
      expect(after.fileBytes).toBeGreaterThanOrEqual(after.usedBytes);
      store.close();
    });
  },
);
