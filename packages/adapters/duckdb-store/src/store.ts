/**
 * DuckDB store (spec §11.7, ADR-0005). One writer process; idempotent upserts on natural keys;
 * a DCAM storage major version guards against opening data written by a newer DCAM (NFR-PORT-04).
 *
 * @implements FR-STORE-01, FR-STORE-06, FR-COLL-03, NFR-PORT-04
 */
import { DuckDBInstance, type DuckDBConnection, type DuckDBValue } from '@duckdb/node-api';
import type { StoredTaskTry, TaskInstanceStore } from '@dcam/ports';
import { MIGRATIONS } from './migrations';

/** Bump when a migration cannot be read by older DCAM versions. */
export const STORE_MAJOR = 1;

export class StoreVersionError extends Error {
  override readonly name = 'StoreVersionError';
}

export interface OpenStoreOptions {
  /** Database file path, or `:memory:` for tests and demo mode. */
  readonly path: string;
  /** Injected clock for `ingested_at`. */
  readonly now?: () => number;
}

export interface Store extends TaskInstanceStore {
  appliedMigrations(): Promise<string[]>;
  setInfo(key: string, value: string): Promise<void>;
  close(): void;
}

const ts = (ms: number | null): DuckDBValue => (ms === null ? null : ms / 1000);

export async function openStore(options: OpenStoreOptions): Promise<Store> {
  const now = options.now ?? Date.now;
  const instance = await DuckDBInstance.create(options.path);
  const con = await instance.connect();
  try {
    await con.run(`SET TimeZone = 'UTC'`);
    await con.run(`CREATE SCHEMA IF NOT EXISTS meta`);
    await con.run(`CREATE TABLE IF NOT EXISTS meta.store_info (key VARCHAR PRIMARY KEY, value VARCHAR NOT NULL)`);
    await con.run(
      `CREATE TABLE IF NOT EXISTS meta.schema_migrations (id VARCHAR PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL)`,
    );
    await checkVersion(con);
    await migrate(con, now);
  } catch (error) {
    con.closeSync();
    instance.closeSync();
    throw error;
  }

  const all = async (sql: string, values: DuckDBValue[] = []) =>
    (await con.runAndReadAll(sql, values)).getRowObjectsJS();

  return {
    async appliedMigrations() {
      return (await all(`SELECT id FROM meta.schema_migrations ORDER BY id`)).map((r) => String(r['id']));
    },
    async setInfo(key, value) {
      await con.run(`INSERT OR REPLACE INTO meta.store_info VALUES ($1, $2)`, [key, value]);
    },
    async upsertTaskTries(rows) {
      if (rows.length === 0) return;
      await con.run('BEGIN TRANSACTION');
      try {
        await con.run('DELETE FROM meta.staging_task_instance');
        const appender = await con.createAppender('staging_task_instance', 'meta');
        const dbl = (v: number | null) => (v === null ? appender.appendNull() : appender.appendDouble(v / 1000));
        for (const r of rows) {
          appender.appendVarchar(r.envId);
          appender.appendVarchar(r.dagId);
          appender.appendVarchar(r.runId);
          appender.appendVarchar(r.taskId);
          appender.appendInteger(r.mapIndex);
          appender.appendInteger(r.tryNumber);
          if (r.state === null) appender.appendNull();
          else appender.appendVarchar(r.state);
          appender.appendVarchar(r.pool);
          appender.appendInteger(r.poolSlots);
          dbl(r.queuedAt);
          dbl(r.startAt);
          dbl(r.endAt);
          dbl(r.sourceUpdatedAt);
          appender.endRow();
        }
        appender.flushSync();
        appender.closeSync();
        // The last row wins when a batch repeats a natural key.
        await con.run(
          `INSERT OR REPLACE INTO fact.task_instance
           SELECT env_id, dag_id, run_id, task_id, map_index, try_number, state, pool, pool_slots,
                  to_timestamp(queued_s), to_timestamp(start_s), to_timestamp(end_s), to_timestamp(updated_s),
                  to_timestamp($1)
           FROM meta.staging_task_instance
           QUALIFY row_number() OVER (
             PARTITION BY env_id, dag_id, run_id, task_id, map_index, try_number ORDER BY rowid DESC) = 1`,
          [ts(now())],
        );
        await con.run('DELETE FROM meta.staging_task_instance');
        await con.run('COMMIT');
      } catch (error) {
        await con.run('ROLLBACK');
        throw error;
      }
    },
    async taskTries(envId, from, to) {
      const rows = await all(
        `SELECT env_id, dag_id, run_id, task_id, map_index, try_number, state, pool, pool_slots,
                epoch_ms(queued_at)::DOUBLE AS queued_at, epoch_ms(start_at)::DOUBLE AS start_at,
                epoch_ms(end_at)::DOUBLE AS end_at, epoch_ms(source_updated_at)::DOUBLE AS source_updated_at
         FROM fact.task_instance
         WHERE env_id = $1 AND start_at IS NOT NULL AND start_at < to_timestamp($3)
           AND (end_at IS NULL OR end_at > to_timestamp($2))`,
        [envId, from / 1000, to / 1000],
      );
      return rows.map(toTry);
    },
    async countTaskTries(envId) {
      const [row] = await all(`SELECT count(*)::INTEGER AS n FROM fact.task_instance WHERE env_id = $1`, [envId]);
      return Number(row?.['n'] ?? 0);
    },
    close() {
      con.closeSync();
      instance.closeSync();
    },
  };
}

async function checkVersion(con: DuckDBConnection): Promise<void> {
  const rows = (await con.runAndReadAll(`SELECT value FROM meta.store_info WHERE key = 'store_major'`)).getRowObjectsJS();
  const stored = rows[0] ? Number(rows[0]['value']) : undefined;
  if (stored === undefined) {
    await con.run(`INSERT INTO meta.store_info VALUES ('store_major', $1)`, [String(STORE_MAJOR)]);
  } else if (stored > STORE_MAJOR) {
    throw new StoreVersionError(
      `This data directory was written by a newer DCAM (storage version ${stored}; this version supports ${STORE_MAJOR}). ` +
        'Upgrade DCAM, or start it with a different data directory.',
    );
  }
}

async function migrate(con: DuckDBConnection, now: () => number): Promise<void> {
  const applied = new Set(
    (await con.runAndReadAll(`SELECT id FROM meta.schema_migrations`)).getRowObjectsJS().map((r) => String(r['id'])),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    await con.run('BEGIN TRANSACTION');
    try {
      await con.run(m.sql);
      await con.run(`INSERT INTO meta.schema_migrations VALUES ($1, to_timestamp($2))`, [m.id, now() / 1000]);
      await con.run('COMMIT');
    } catch (error) {
      await con.run('ROLLBACK');
      throw error;
    }
  }
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function toTry(r: Record<string, unknown>): StoredTaskTry {
  return {
    envId: String(r['env_id']),
    dagId: String(r['dag_id']),
    runId: String(r['run_id']),
    taskId: String(r['task_id']),
    mapIndex: Number(r['map_index']),
    tryNumber: Number(r['try_number']),
    state: r['state'] === null ? null : String(r['state']),
    pool: String(r['pool']),
    poolSlots: Number(r['pool_slots']),
    queuedAt: num(r['queued_at']),
    startAt: num(r['start_at']),
    endAt: num(r['end_at']),
    sourceUpdatedAt: num(r['source_updated_at']),
  };
}
