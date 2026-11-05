import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { StoredTaskTry } from '@dcam/ports';
import { StoreVersionError, openStore } from '../src/index';

const T0 = Date.UTC(2026, 10, 1);
const row = (over: Partial<StoredTaskTry> = {}): StoredTaskTry => ({
  envId: 'acme-prod',
  dagId: 'orders_daily',
  runId: 'scheduled__2026-11-01T00:00:00+00:00',
  taskId: 'load',
  mapIndex: -1,
  tryNumber: 1,
  pool: 'default_pool',
  poolSlots: 1,
  state: 'success',
  queuedAt: T0 - 5_000,
  startAt: T0,
  endAt: T0 + 60_000,
  sourceUpdatedAt: T0 + 60_000,
  readyAt: T0 - 20_000,
  operator: 'PythonOperator',
  ...over,
});

const dirs: string[] = [];
const tempDb = () => {
  const dir = mkdtempSync(join(tmpdir(), 'dcam-store-'));
  dirs.push(dir);
  return join(dir, 'dcam.duckdb');
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

// These tests do real DuckDB I/O, and in CI they share 4 vCPUs with every other package's tests (Turborepo
// runs them in parallel), so Vitest's default 5 s timeout is too tight. Performance bounds are explicit.
describe('FR-STORE-01 embedded store with migrations', { timeout: 60_000 }, () => {
  it('FR-STORE-01: applies migrations once and records them', async () => {
    const path = tempDb();
    const store = await openStore({ path });
    expect(await store.appliedMigrations()).toEqual([
      '0001_initial',
      '0002_staging',
      '0003_ready_operator',
      '0004_collection',
    ]);
    store.close();
    const again = await openStore({ path });
    expect(await again.appliedMigrations()).toEqual([
      '0001_initial',
      '0002_staging',
      '0003_ready_operator',
      '0004_collection',
    ]);
    again.close();
  });

  it('FR-COLL-03: upserts are idempotent on the natural key', async () => {
    const store = await openStore({ path: ':memory:' });
    await store.upsertTaskTries([row(), row({ taskId: 'transform' })]);
    await store.upsertTaskTries([row({ state: 'failed' })]);
    expect(await store.countTaskTries('acme-prod')).toBe(2);
    const tries = await store.taskTries('acme-prod', T0, T0 + 120_000);
    expect(tries.find((t) => t.taskId === 'load')?.state).toBe('failed');
    store.close();
  });

  it('FR-COLL-03: keeps the last row when a batch repeats a natural key', async () => {
    const store = await openStore({ path: ':memory:' });
    await store.upsertTaskTries([row({ state: 'running', endAt: null }), row({ state: 'success' })]);
    const [only] = await store.taskTries('acme-prod', T0, T0 + 60_000);
    expect(only?.state).toBe('success');
    expect(await store.countTaskTries('acme-prod')).toBe(1);
    store.close();
  });

  it('FR-STORE-01: ingests a large batch quickly through the staging table', async () => {
    const store = await openStore({ path: ':memory:' });
    const rows = Array.from({ length: 100_000 }, (_, i) =>
      row({ taskId: `t${i}`, startAt: T0 + i, endAt: T0 + i + 1_000 }),
    );
    const started = performance.now();
    await store.upsertTaskTries(rows);
    // Regression bound, not a benchmark: a batch far larger than any live snapshot must still fit in one
    // af.live cycle of the default `standard` profile (30 s, spec §7.7). Measured: about 1 s on a laptop,
    // 3-7 s on a loaded 4-vCPU Linux runner.
    expect(performance.now() - started).toBeLessThan(30_000);
    expect(await store.countTaskTries('acme-prod')).toBe(100_000);
    store.close();
  });

  it('FR-STORE-01: returns tries overlapping the window, including running ones', async () => {
    const store = await openStore({ path: ':memory:' });
    await store.upsertTaskTries([
      row({ taskId: 'before', startAt: T0 - 600_000, endAt: T0 - 300_000 }),
      row({ taskId: 'overlap', startAt: T0 - 30_000, endAt: T0 + 30_000 }),
      row({ taskId: 'running', startAt: T0 - 3_600_000, endAt: null, state: 'running' }),
      row({ taskId: 'other-env', envId: 'acme-dev' }),
    ]);
    const ids = (await store.taskTries('acme-prod', T0, T0 + 60_000)).map((t) => t.taskId).sort();
    expect(ids).toEqual(['overlap', 'running']);
    store.close();
  });

  it('HM-006 / HM-008: stores when a try became ready and its operator (migration 0003)', async () => {
    const store = await openStore({ path: ':memory:' });
    await store.upsertTaskTries([
      row({ taskId: 'known' }),
      row({ taskId: 'unknown', readyAt: null, operator: null }),
    ]);
    const tries = await store.taskTries('acme-prod', T0, T0 + 60_000);
    const byId = new Map(tries.map((t) => [t.taskId, t]));
    expect(byId.get('known')).toMatchObject({ readyAt: T0 - 20_000, operator: 'PythonOperator' });
    expect(byId.get('unknown')).toMatchObject({ readyAt: null, operator: null });
    store.close();
  });

  it('NFR-PORT-04: refuses to open a store written by a newer storage major version', async () => {
    const path = tempDb();
    const store = await openStore({ path });
    await store.setInfo('store_major', '999');
    store.close();
    await expect(openStore({ path })).rejects.toBeInstanceOf(StoreVersionError);
  });
});
