import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, openFileStore, openStore, type Migration } from '../src/index';
import { ENV, T0, tempDir, tryRow } from './fixtures';

/** Two extra migrations so a test can step a file through more versions than the product has. */
const LATER: readonly Migration[] = [
  ...MIGRATIONS,
  { id: '9001_test', sql: 'CREATE TABLE meta.test_9001 (x INTEGER);' },
  { id: '9002_test', sql: 'CREATE TABLE meta.test_9002 (x INTEGER);' },
];

const backupsOf = (dataDir: string) =>
  readdirSync(join(dataDir, 'backups'))
    .filter((f) => f.endsWith('.duckdb'))
    .sort();

// File-backed DuckDB on a shared 4-vCPU runner: realistic timeouts, few opens per test.
describe('FR-STORE-01 / FR-COLL-03 file store in the data directory (§17.5)', { timeout: 60_000 }, () => {
  it('FR-COLL-03: after close and reopen, collection resumes from the watermark without duplicate tries', async () => {
    const dataDir = join(tempDir(), 'data');
    const first = await openFileStore({ dataDir });
    await first.commitFacts(ENV, 'af.facts', [tryRow({ taskId: 'a' }), tryRow({ taskId: 'b' })], T0 + 60_000);
    first.close();
    expect(existsSync(join(dataDir, 'dcam.duckdb'))).toBe(true);

    const second = await openFileStore({ dataDir });
    expect(await second.watermark(ENV, 'af.facts')).toBe(T0 + 60_000);
    // The next window overlaps the last one (FR-COLL-03): a and b arrive again, c is new.
    await second.commitFacts(
      ENV,
      'af.facts',
      [tryRow({ taskId: 'b', state: 'failed' }), tryRow({ taskId: 'a' }), tryRow({ taskId: 'c' })],
      T0 + 120_000,
    );
    expect(await second.countTaskTries(ENV)).toBe(3);
    const states = new Map((await second.taskTries(ENV, T0, T0 + 1)).map((t) => [t.taskId, t.state]));
    expect(states).toEqual(
      new Map([
        ['a', 'success'],
        ['b', 'failed'],
        ['c', 'success'],
      ]),
    );
    expect(await second.watermark(ENV, 'af.facts')).toBe(T0 + 120_000);
    // A fresh file at the current schema version needs no backup.
    expect(existsSync(join(dataDir, 'backups'))).toBe(false);
    second.close();
  });

  it('FR-STORE-01: backs up a file with an older schema before migrating it, named by version and time', async () => {
    const dataDir = tempDir();
    (await openFileStore({ dataDir, migrations: MIGRATIONS.slice(0, 3) })).close();
    // A try written by the older version (today's upsert needs the newer schema, so plain SQL).
    const instance = await DuckDBInstance.create(join(dataDir, 'dcam.duckdb'));
    const con = await instance.connect();
    await con.run(
      `INSERT INTO fact.task_instance (env_id, dag_id, run_id, task_id, try_number, pool, ingested_at)
       VALUES ('${ENV}', 'acme_orders_daily', 'manual__1', 'load', 1, 'default_pool', now())`,
    );
    con.closeSync();
    instance.closeSync();

    const now = () => Date.UTC(2026, 10, 5, 23, 4, 5, 678);
    const migrated = await openFileStore({ dataDir, now });
    expect(await migrated.appliedMigrations()).toEqual(MIGRATIONS.map((m) => m.id));
    expect(await migrated.countTaskTries(ENV)).toBe(1);
    migrated.close();

    expect(backupsOf(dataDir)).toEqual(['dcam-20261105T230405678Z-from-0003_ready_operator.duckdb']);
    // The backup is the old file as it was: three migrations, the same data.
    const backup = await openStore({
      path: join(dataDir, 'backups', 'dcam-20261105T230405678Z-from-0003_ready_operator.duckdb'),
      migrations: MIGRATIONS.slice(0, 3),
    });
    expect(await backup.appliedMigrations()).toEqual(MIGRATIONS.slice(0, 3).map((m) => m.id));
    expect(await backup.countTaskTries(ENV)).toBe(1);
    backup.close();
  });

  it('FR-STORE-01: keeps only the last 3 backups and never touches other files in backups/', async () => {
    const dataDir = tempDir();
    let clock = Date.UTC(2026, 10, 5, 8, 0, 0, 0);
    const now = () => clock;
    const versions = [3, 4, 5, 6] as const;
    (await openFileStore({ dataDir, now, migrations: LATER.slice(0, 2) })).close();
    for (const n of versions) {
      clock += 60_000;
      const store = await openFileStore({ dataDir, now, migrations: LATER.slice(0, n) });
      if (n === 3) writeFileSync(join(dataDir, 'backups', 'notes.txt'), 'kept by the user\n');
      store.close();
    }
    expect(backupsOf(dataDir)).toEqual([
      'dcam-20261105T080200000Z-from-0003_ready_operator.duckdb',
      'dcam-20261105T080300000Z-from-0004_collection.duckdb',
      'dcam-20261105T080400000Z-from-9001_test.duckdb',
    ]);
    expect(existsSync(join(dataDir, 'backups', 'notes.txt'))).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'FR-STORE-01: creates the data directory and backups/ owner-only (0700)',
    async () => {
      const dataDir = join(tempDir(), 'nested', 'data');
      (await openFileStore({ dataDir, migrations: MIGRATIONS.slice(0, 3) })).close();
      (await openFileStore({ dataDir })).close();
      expect(statSync(dataDir).mode & 0o777).toBe(0o700);
      expect(statSync(join(dataDir, '..')).mode & 0o777).toBe(0o700);
      expect(statSync(join(dataDir, 'backups')).mode & 0o777).toBe(0o700);
    },
  );
});
