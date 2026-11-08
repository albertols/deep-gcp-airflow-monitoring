/**
 * DuckDB store (spec §11.7, ADR-0005). One writer process; idempotent upserts on natural keys;
 * a DCAM storage major version guards against opening data written by a newer DCAM (NFR-PORT-04).
 *
 * The store is the live workspace's `CollectionStore` and the demo's task-instance store. Writes run one at a
 * time on a dedicated connection, each in its own transaction, so concurrent collectors never share (or roll
 * back) each other's work (FR-STORE-06). Reads use a second connection and see committed data only.
 *
 * It is also the maintenance job's `RetentionStore` (FR-STORE-02, FR-STORE-07): every delete batch and every
 * day of thinning is one write transaction on one table, queued behind (and ahead of) collector writes, so
 * maintenance never holds collection up for longer than one batch.
 *
 * @implements FR-STORE-01, FR-STORE-02, FR-STORE-06, FR-STORE-07, FR-COLL-03, FR-COLL-04 (backfill progress),
 *   NFR-PORT-04, HM-003 (estimated ends), HM-006
 */
import { existsSync, statSync } from 'node:fs';
import {
  DuckDBInstance,
  LIST,
  VARCHAR,
  type DuckDBAppender,
  type DuckDBConnection,
  type DuckDBValue,
} from '@duckdb/node-api';
import {
  DAY_MS,
  thinSnapshots,
  type DagMeta,
  type EnvironmentConfig,
  type PlatformHealth,
  type WorkerSample,
} from '@dcam/domain';
import type {
  BackfillProgress,
  BackfillRows,
  CollectionStore,
  RetainedFamily,
  RetentionHorizon,
  RetentionStore,
  StorageUsage,
  StoredLiveSnapshot,
  StoredTaskTry,
  TaskInstanceStore,
  ThinOptions,
  ThinResult,
  TryKey,
} from '@dcam/ports';
import { MIGRATIONS, type Migration } from './migrations';

/** Bump when a migration cannot be read by older DCAM versions. */
export const STORE_MAJOR = 1;

/** The columns {@link toTry} reads, from `fact.task_instance`. */
const TRY_COLUMNS = `SELECT env_id, dag_id, run_id, task_id, map_index, try_number, state, pool, pool_slots,
         epoch_ms(queued_at)::DOUBLE AS queued_at, epoch_ms(start_at)::DOUBLE AS start_at,
         epoch_ms(end_at)::DOUBLE AS end_at, epoch_ms(source_updated_at)::DOUBLE AS source_updated_at,
         epoch_ms(ready_at)::DOUBLE AS ready_at, operator, coalesce(end_estimated, false) AS end_estimated,
         epoch_ms(seen_running_at)::DOUBLE AS seen_running_at
       FROM fact.task_instance`;

/** Tries of environment $1 whose running interval overlaps [$2, $3) seconds, or that are still running. */
const TRY_OVERLAPS = `env_id = $1 AND start_at IS NOT NULL AND start_at < to_timestamp($3)
         AND (end_at IS NULL OR end_at > to_timestamp($2))`;

export class StoreVersionError extends Error {
  override readonly name = 'StoreVersionError';
}

export interface OpenStoreOptions {
  /** Database file path, or `:memory:` for tests and demo mode. */
  readonly path: string;
  /** Injected clock for `ingested_at`, `saved_at` and `committed_at`. */
  readonly now?: () => number;
  /** Migrations to apply, in order. Defaults to {@link MIGRATIONS}; tests pass a prefix to build an older file. */
  readonly migrations?: readonly Migration[];
}

export interface Store extends TaskInstanceStore {
  appliedMigrations(): Promise<string[]>;
  setInfo(key: string, value: string): Promise<void>;
  close(): void;
}

type Row = Record<string, unknown>;

/** Epoch milliseconds as the seconds that `to_timestamp` takes; DuckDB rounds them back to whole ms exactly. */
const seconds = (ms: number | null): number | null => (ms === null ? null : ms / 1000);

/** DuckDB VARCHAR values arrive as strings; anything else means the schema and the code disagree. */
function str(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError(`expected a string from DuckDB, got ${typeof value}`);
  return value;
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) throw new TypeError(`expected a list from DuckDB, got ${typeof value}`);
  return value.map(str);
}

function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`expected a boolean from DuckDB, got ${typeof value}`);
  return value;
}

const isRecord = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Parses a JSON payload this store wrote, checking that the named fields have the expected kinds. */
function payload(
  text: unknown,
  what: string,
  fields: Readonly<Record<string, 'string' | 'number' | 'array' | 'object'>>,
): Row {
  const value: unknown = JSON.parse(str(text));
  if (!isRecord(value)) throw new TypeError(`stored ${what} is not an object`);
  for (const [field, kind] of Object.entries(fields)) {
    const v = value[field];
    const ok = kind === 'array' ? Array.isArray(v) : kind === 'object' ? isRecord(v) : typeof v === kind;
    if (!ok) throw new TypeError(`stored ${what} has no ${kind} ${field}`);
  }
  return value;
}

const text = (a: DuckDBAppender, v: string | null) => (v === null ? a.appendNull() : a.appendVarchar(v));
const integer = (a: DuckDBAppender, v: number | null) => (v === null ? a.appendNull() : a.appendInteger(v));
const double = (a: DuckDBAppender, v: number | null) => (v === null ? a.appendNull() : a.appendDouble(v));

/** Appends `rows` to a `meta` staging table; on failure the appender is closed and the error rethrown. */
async function append<T>(
  con: DuckDBConnection,
  table: string,
  rows: readonly T[],
  write: (a: DuckDBAppender, row: T) => void,
): Promise<void> {
  const appender = await con.createAppender(table, 'meta');
  try {
    for (const row of rows) {
      write(appender, row);
      appender.endRow();
    }
    appender.flushSync();
  } catch (error) {
    try {
      appender.closeSync();
    } catch {
      // The error that brought us here is the one to report.
    }
    throw error;
  }
  appender.closeSync();
}

const VARCHAR_LIST = LIST(VARCHAR);

const TRY_KEY = ['env_id', 'dag_id', 'run_id', 'task_id', 'map_index', 'try_number'] as const;
const sameTry = (a: string, b: string) => TRY_KEY.map((c) => `${a}.${c} = ${b}.${c}`).join(' AND ');

/** Runs async work one task at a time: each starts after the previous one settles. */
class Serial {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

/** Columns of `fact.platform_health` by input (migration 0004). */
const HEALTH_COLUMNS = {
  envHealthyRatio: 'env_healthy_ratio',
  dbHealthyRatio: 'db_healthy_ratio',
  heartbeatCompleteness: 'heartbeat_completeness',
  webServerHealthyRatio: 'web_server_healthy_ratio',
  dbCpuMemoryMax: 'db_cpu_memory_max',
  zombies24h: 'zombies_24h',
  workerRestarts24h: 'worker_restarts_24h',
  importErrors: 'import_errors',
  parseLoopP95Seconds: 'parse_loop_p95_s',
} as const satisfies Record<keyof PlatformHealth, string>;

/**
 * Where each retained family lives, how old a row is, and which rows never expire. A task try is as old as
 * its end; one that never started (upstream failed, skipped) as its queued, ready or ingested time. An open
 * try (started, no end) overlaps every window from now on, so it is kept until it ends.
 */
const FAMILIES = {
  'task-tries': {
    table: 'fact.task_instance',
    age: 'coalesce(end_at, queued_at, ready_at, ingested_at)',
    kept: '(end_at IS NULL AND start_at IS NOT NULL)',
  },
  'ready-times': { table: 'fact.ready_time', age: 'ready_at', kept: 'false' },
  snapshots: { table: 'fact.live_snapshot', age: 'taken_at', kept: 'false' },
  'worker-samples': { table: 'fact.worker_sample', age: 'sampled_at', kept: 'false' },
} as const satisfies Record<RetainedFamily, { table: string; age: string; kept: string }>;

const NO_HEALTH: PlatformHealth = {
  envHealthyRatio: null,
  dbHealthyRatio: null,
  heartbeatCompleteness: null,
  webServerHealthyRatio: null,
  dbCpuMemoryMax: null,
  zombies24h: null,
  workerRestarts24h: null,
  importErrors: null,
  parseLoopP95Seconds: null,
};

/**
 * The DuckDB store: {@link Store} for every workspace, {@link CollectionStore} for live collection and
 * {@link RetentionStore} for the maintenance job.
 */
export class DuckDbStore implements Store, CollectionStore, RetentionStore {
  private readonly writes = new Serial();

  private constructor(
    private readonly instance: DuckDBInstance,
    private readonly writer: DuckDBConnection,
    private readonly reader: DuckDBConnection,
    private readonly now: () => number,
    private readonly path: string,
  ) {}

  /** Opens (creating if needed) the database at `options.path` and applies pending migrations. */
  static async open(options: OpenStoreOptions): Promise<DuckDbStore> {
    const now = options.now ?? Date.now;
    const instance = await DuckDBInstance.create(options.path);
    const connections: DuckDBConnection[] = [];
    try {
      const writer = await instance.connect();
      connections.push(writer);
      await bootstrap(writer, now, options.migrations ?? MIGRATIONS);
      const reader = await instance.connect();
      connections.push(reader);
      await reader.run(`SET TimeZone = 'UTC'`);
      return new DuckDbStore(instance, writer, reader, now, options.path);
    } catch (error) {
      for (const con of connections) con.closeSync();
      instance.closeSync();
      throw error;
    }
  }

  close(): void {
    this.reader.closeSync();
    this.writer.closeSync();
    this.instance.closeSync();
  }

  private async rows(sql: string, values: DuckDBValue[] = []): Promise<Row[]> {
    return (await this.reader.runAndReadAll(sql, values)).getRowObjectsJS();
  }

  /** Runs `work` in its own transaction on the write connection, after every earlier write has settled. */
  private write<T = void>(work: (con: DuckDBConnection) => Promise<T>): Promise<T> {
    return this.writes.run(async () => {
      const con = this.writer;
      await con.run('BEGIN TRANSACTION');
      try {
        const result = await work(con);
        await con.run('COMMIT');
        return result;
      } catch (error) {
        // A failed COMMIT has already ended the transaction; then ROLLBACK fails too and is not the news.
        await con.run('ROLLBACK').catch(() => undefined);
        throw error;
      }
    });
  }

  // ── Store ────────────────────────────────────────────────────────────────────────────────────────

  async appliedMigrations(): Promise<string[]> {
    return (await this.rows(`SELECT id FROM meta.schema_migrations ORDER BY id`)).map((r) => str(r['id']));
  }

  setInfo(key: string, value: string): Promise<void> {
    return this.write(async (con) => {
      await con.run(`INSERT OR REPLACE INTO meta.store_info VALUES ($1, $2)`, [key, value]);
    });
  }

  // ── TaskInstanceStore ────────────────────────────────────────────────────────────────────────────

  async upsertTaskTries(rows: readonly StoredTaskTry[]): Promise<void> {
    if (rows.length === 0) return;
    await this.write((con) => this.mergeTries(con, rows));
  }

  /**
   * Stages `rows` and upserts them into `fact.task_instance` inside the caller's transaction, by the rules of
   * `TaskInstanceStore.upsertTaskTries`:
   *
   * - When a batch repeats a natural key, a row with a true end wins, else the last row.
   * - A row without an end never replaces a stored try whose end is true: `af.live` reads a running try,
   *   `af.facts` commits its finished row, then the running row arrives (FR-COLL-03). An estimated end is
   *   replaced, so a try that runs again (resumed from deferral) is open again.
   * - A row without `readyAt` takes the first-seen ready time, else keeps the ready time the stored try already
   *   has: an unknown value never erases a known one (HM-006).
   * - Then every try of the batch's task instances that is still open while a later try exists ends,
   *   estimated, when it was last seen running (never before it started), as `closeRunningTries` ends it: a
   *   failed try rescheduled before `af.facts` read its row is no longer in the task instance list (HM-003).
   *   The later try's earliest known time would count the retry delay as slot time (Airflow's default
   *   `[core] default_task_retry_delay` is 300 s,
   *   https://airflow.apache.org/docs/apache-airflow/2.11.1/configurations-ref.html#default-task-retry-delay),
   *   so it is only the bound of a try never seen running.
   */
  private async mergeTries(con: DuckDBConnection, rows: readonly StoredTaskTry[]): Promise<void> {
    await con.run('DELETE FROM meta.staging_task_instance');
    await append(con, 'staging_task_instance', rows, (a, r) => {
      text(a, r.envId);
      text(a, r.dagId);
      text(a, r.runId);
      text(a, r.taskId);
      integer(a, r.mapIndex);
      integer(a, r.tryNumber);
      text(a, r.state);
      text(a, r.pool);
      integer(a, r.poolSlots);
      double(a, seconds(r.queuedAt));
      double(a, seconds(r.startAt));
      double(a, seconds(r.endAt));
      double(a, seconds(r.sourceUpdatedAt));
      double(a, seconds(r.readyAt));
      text(a, r.operator);
      a.appendBoolean(r.endEstimated ?? false);
      double(a, seconds(r.seenRunningAt ?? null));
    });
    const trueEnd = (t: string) => `(${t}.end_at IS NOT NULL AND NOT coalesce(${t}.end_estimated, false))`;
    await con.run(
      `INSERT OR REPLACE INTO fact.task_instance
         (env_id, dag_id, run_id, task_id, map_index, try_number, state, pool, pool_slots,
          queued_at, start_at, end_at, source_updated_at, ingested_at, ready_at, operator, end_estimated,
          seen_running_at)
       SELECT s.env_id, s.dag_id, s.run_id, s.task_id, s.map_index, s.try_number, s.state, s.pool, s.pool_slots,
              to_timestamp(s.queued_s), to_timestamp(s.start_s), to_timestamp(s.end_s), to_timestamp(s.updated_s),
              to_timestamp($1), coalesce(to_timestamp(s.ready_s), r.ready_at, f.ready_at), s.operator,
              s.end_estimated, to_timestamp(s.seen_running_s)
       FROM meta.staging_task_instance s
       LEFT JOIN fact.ready_time r ON ${sameTry('r', 's')}
       LEFT JOIN fact.task_instance f ON ${sameTry('f', 's')}
       WHERE NOT (s.end_s IS NULL AND ${trueEnd('f')})
         -- A finished row read before the stored finished one (a backfill committing a cycle late) is stale.
         -- Without both update times there is nothing to compare: the row replaces, as before.
         AND NOT (s.end_s IS NOT NULL AND ${trueEnd('f')}
                  AND coalesce(f.source_updated_at > to_timestamp(s.updated_s), false))
       QUALIFY row_number() OVER (
         PARTITION BY ${TRY_KEY.map((c) => `s.${c}`).join(', ')}
         ORDER BY (s.end_s IS NOT NULL AND NOT s.end_estimated) DESC, s.rowid DESC) = 1`,
      [seconds(this.now())],
    );
    const sameInstance = (a: string, b: string) =>
      TRY_KEY.filter((c) => c !== 'try_number')
        .map((c) => `${a}.${c} = ${b}.${c}`)
        .join(' AND ');
    await con.run(
      `UPDATE fact.task_instance AS p
       SET end_at = e.end_at, end_estimated = true, state = CASE WHEN p.state = 'running' THEN NULL ELSE p.state END
       FROM (
         SELECT o.env_id, o.dag_id, o.run_id, o.task_id, o.map_index, o.try_number,
                CASE WHEN any_value(o.seen_running_at) IS NOT NULL
                  THEN greatest(any_value(o.start_at), any_value(o.seen_running_at))
                  ELSE greatest(any_value(o.start_at), min(least(n.ready_at, n.queued_at, n.start_at, n.end_at)))
                END AS end_at
         FROM fact.task_instance o
         JOIN fact.task_instance n ON ${sameInstance('n', 'o')} AND n.try_number > o.try_number
         WHERE o.end_at IS NULL
           AND EXISTS (SELECT 1 FROM meta.staging_task_instance s WHERE ${sameInstance('s', 'o')})
         GROUP BY o.env_id, o.dag_id, o.run_id, o.task_id, o.map_index, o.try_number
         HAVING min(least(n.ready_at, n.queued_at, n.start_at, n.end_at)) IS NOT NULL
       ) e
       WHERE ${sameTry('p', 'e')}`,
    );
    await con.run('DELETE FROM meta.staging_task_instance');
  }

  async closeRunningTries(envId: string, running: readonly TryKey[], at: number): Promise<void> {
    await this.write(async (con) => {
      await con.run('DELETE FROM meta.staging_try_key');
      await append(con, 'staging_try_key', running, (a, k) => {
        text(a, k.dagId);
        text(a, k.runId);
        text(a, k.taskId);
        integer(a, k.mapIndex);
        integer(a, k.tryNumber);
      });
      await con.run(
        `UPDATE fact.task_instance AS p
         SET end_at = greatest(p.start_at, coalesce(p.seen_running_at, to_timestamp($2))), end_estimated = true,
             state = NULL
         WHERE p.env_id = $1 AND p.end_at IS NULL AND p.state = 'running'
           AND NOT EXISTS (
             SELECT 1 FROM meta.staging_try_key k
             WHERE ${TRY_KEY.filter((c) => c !== 'env_id')
               .map((c) => `k.${c} = p.${c}`)
               .join(' AND ')})`,
        [envId, seconds(at)],
      );
      await con.run('DELETE FROM meta.staging_try_key');
    });
  }

  async taskTries(envId: string, from: number, to: number): Promise<StoredTaskTry[]> {
    const rows = await this.rows(`${TRY_COLUMNS} WHERE ${TRY_OVERLAPS}`, [envId, seconds(from), seconds(to)]);
    return rows.map(toTry);
  }

  /** {@link taskTries} for one DAG: DAG detail's 28-day baseline (HM-016) without the other DAGs' rows. */
  async dagTaskTries(envId: string, dagId: string, from: number, to: number): Promise<StoredTaskTry[]> {
    const rows = await this.rows(`${TRY_COLUMNS} WHERE ${TRY_OVERLAPS} AND dag_id = $4`, [
      envId,
      seconds(from),
      seconds(to),
      dagId,
    ]);
    return rows.map(toTry);
  }

  async historyStart(envId: string): Promise<number | null> {
    const [row] = await this.rows(
      `SELECT epoch_ms(min(coalesce(start_at, queued_at)))::DOUBLE AS t FROM fact.task_instance WHERE env_id = $1`,
      [envId],
    );
    const earliest = num(row?.['t']);
    if (earliest === null) return null;
    // A try that started before the retention horizon but ended after it is kept; history is complete from there.
    const { deletedBefore } = await this.horizon(envId, 'task-tries');
    return deletedBefore === null ? earliest : Math.max(earliest, deletedBefore);
  }

  async readThrough(envId: string): Promise<number | null> {
    const [row] = await this.rows(
      `SELECT (SELECT value_ms FROM meta.watermarks WHERE env_id = $1 AND collector_id = 'af.facts') AS facts,
              (SELECT epoch_ms(max(taken_at))::DOUBLE FROM fact.live_snapshot WHERE env_id = $1) AS live`,
      [envId],
    );
    const known = [num(row?.['facts']), num(row?.['live'])].filter((t): t is number => t !== null);
    return known.length === 0 ? null : Math.min(...known);
  }

  async countTaskTries(envId: string): Promise<number> {
    const [row] = await this.rows(`SELECT count(*)::INTEGER AS n FROM fact.task_instance WHERE env_id = $1`, [
      envId,
    ]);
    return Number(row?.['n'] ?? 0);
  }

  // ── CollectionStore: writes ──────────────────────────────────────────────────────────────────────

  saveConfig(envId: string, config: EnvironmentConfig): Promise<void> {
    return this.write(async (con) => {
      await con.run(`INSERT OR REPLACE INTO dim.environment_config VALUES ($1, $2, to_timestamp($3))`, [
        envId,
        JSON.stringify(config),
        seconds(this.now()),
      ]);
    });
  }

  /** Upserts by DAG id; DAGs missing from `dags` are kept, so an inventory may be saved page by page. */
  async saveDags(envId: string, dags: readonly DagMeta[]): Promise<void> {
    if (dags.length === 0) return;
    await this.write((con) => this.mergeDags(con, envId, dags));
  }

  /** Deletes the environment's DAGs and stores `dags` in one transaction (a complete inventory pass). */
  replaceDags(envId: string, dags: readonly DagMeta[]): Promise<void> {
    return this.write(async (con) => {
      await con.run('DELETE FROM dim.dag WHERE env_id = $1', [envId]);
      if (dags.length > 0) await this.mergeDags(con, envId, dags);
    });
  }

  /** Stages `dags` and upserts them into `dim.dag` inside the caller's transaction; the last row of a DAG wins. */
  private async mergeDags(con: DuckDBConnection, envId: string, dags: readonly DagMeta[]): Promise<void> {
    await con.run('DELETE FROM meta.staging_dag');
    await append(con, 'staging_dag', dags, (a, d) => {
      text(a, envId);
      text(a, d.dagId);
      text(a, d.fileloc);
      // The item type is explicit: DuckDB cannot infer one from an empty list.
      a.appendList(d.owners, VARCHAR_LIST);
      a.appendList(d.tags, VARCHAR_LIST);
      text(a, d.team);
      text(a, d.schedule);
      integer(a, d.maxActiveTasks);
      integer(a, d.maxActiveRuns);
      a.appendBoolean(d.catchup);
      a.appendBoolean(d.paused);
    });
    await con.run(
      `INSERT OR REPLACE INTO dim.dag
         (env_id, dag_id, fileloc, owners, tags, team, schedule, max_active_tasks, max_active_runs, catchup,
          paused, saved_at)
       SELECT env_id, dag_id, fileloc, owners, tags, team, schedule, max_active_tasks, max_active_runs, catchup,
              paused, to_timestamp($1)
       FROM meta.staging_dag
       QUALIFY row_number() OVER (PARTITION BY env_id, dag_id ORDER BY rowid DESC) = 1`,
      [seconds(this.now())],
    );
    await con.run('DELETE FROM meta.staging_dag');
  }

  savePlatformHealth(envId: string, health: PlatformHealth): Promise<void> {
    return this.write(async (con) => {
      await con.run(
        `INSERT OR REPLACE INTO fact.platform_health VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, to_timestamp($11))`,
        [
          envId,
          health.envHealthyRatio,
          health.dbHealthyRatio,
          health.heartbeatCompleteness,
          health.webServerHealthyRatio,
          health.dbCpuMemoryMax,
          health.zombies24h,
          health.workerRestarts24h,
          health.importErrors,
          health.parseLoopP95Seconds,
          seconds(this.now()),
        ],
      );
    });
  }

  /** One upsert of the given columns: inputs left out keep their stored values (or stay null). */
  async patchPlatformHealth(envId: string, patch: Partial<PlatformHealth>): Promise<void> {
    const keys = (Object.keys(HEALTH_COLUMNS) as Array<keyof PlatformHealth>).filter(
      (k) => patch[k] !== undefined,
    );
    if (keys.length === 0) return;
    const columns = [...keys.map((k) => HEALTH_COLUMNS[k]), 'saved_at'];
    const values = keys.map((_, i) => `$${i + 2}`);
    await this.write(async (con) => {
      await con.run(
        `INSERT INTO fact.platform_health (env_id, ${columns.join(', ')})
         VALUES ($1, ${values.join(', ')}, to_timestamp($${keys.length + 2}))
         ON CONFLICT (env_id) DO UPDATE SET ${columns.map((c) => `${c} = excluded.${c}`).join(', ')}`,
        [envId, ...keys.map((k) => patch[k] ?? null), seconds(this.now())],
      );
    });
  }

  /**
   * The snapshot, with its coverage when it has one, is stored as JSON; the span of a thinned snapshot goes
   * to its own column, which thinning updates (FR-STORE-07).
   */
  saveSnapshot(envId: string, snapshot: StoredLiveSnapshot): Promise<void> {
    return this.write((con) => insertSnapshot(con, envId, snapshot));
  }

  /** Saves many snapshots in one transaction (imports, and tests that build history quickly). */
  async saveSnapshots(envId: string, snapshots: readonly StoredLiveSnapshot[]): Promise<void> {
    if (snapshots.length === 0) return;
    await this.write(async (con) => {
      for (const s of snapshots) await insertSnapshot(con, envId, s);
    });
  }

  async saveWorkerSamples(envId: string, samples: readonly WorkerSample[]): Promise<void> {
    if (samples.length === 0) return;
    await this.write((con) => this.mergeSamples(con, envId, samples));
  }

  /** Upserts samples by minute inside the caller's transaction. */
  private async mergeSamples(
    con: DuckDBConnection,
    envId: string,
    samples: readonly WorkerSample[],
  ): Promise<void> {
    // One statement per sample: a batch may repeat a minute, and the later sample wins.
    for (const s of samples)
      await con.run(
        `INSERT OR REPLACE INTO fact.worker_sample VALUES ($1, to_timestamp($2), $3, $4, $5, $6, $7, $8)`,
        [envId, seconds(s.at), s.workers, s.target, s.running, s.queued, s.cpu, s.memory],
      );
  }

  /** The progress is written before the rows, so a failure in either leaves both as they were (FR-STORE-06). */
  async commitBackfill(
    envId: string,
    collectorId: string,
    progress: BackfillProgress,
    rows: BackfillRows,
  ): Promise<void> {
    const foreign = rows.tries?.find((t) => t.envId !== envId);
    if (foreign !== undefined)
      throw new RangeError(`commitBackfill for ${envId} was given a try of environment ${foreign.envId}`);
    const times = [progress.from, progress.to, progress.coveredFrom, progress.startedAt];
    if (!times.every(Number.isFinite))
      throw new RangeError(`commitBackfill for ${envId} was given a progress without finite times`);
    await this.write(async (con) => {
      await con.run(
        `INSERT OR REPLACE INTO meta.backfill VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, to_timestamp($10))`,
        [
          envId,
          collectorId,
          progress.from,
          progress.to,
          progress.coveredFrom,
          progress.itemsRead,
          progress.requestsUsed,
          progress.startedAt,
          progress.completedAt,
          seconds(this.now()),
        ],
      );
      if (rows.tries?.length) await this.mergeTries(con, rows.tries);
      if (rows.samples?.length) await this.mergeSamples(con, envId, rows.samples);
    });
  }

  async recordReady(envId: string, keys: readonly TryKey[], at: number): Promise<void> {
    if (keys.length === 0) return;
    await this.write(async (con) => {
      await con.run('DELETE FROM meta.staging_ready_time');
      await append(con, 'staging_ready_time', keys, (a, k) => {
        text(a, k.dagId);
        text(a, k.runId);
        text(a, k.taskId);
        integer(a, k.mapIndex);
        integer(a, k.tryNumber);
      });
      await con.run(
        `INSERT INTO fact.ready_time
         SELECT DISTINCT $1, dag_id, run_id, task_id, map_index, try_number, to_timestamp($2)
         FROM meta.staging_ready_time
         ON CONFLICT DO UPDATE SET ready_at = least(fact.ready_time.ready_at, excluded.ready_at)`,
        [envId, seconds(at)],
      );
      await con.run('DELETE FROM meta.staging_ready_time');
    });
  }

  /** The watermark is written before the tries, so a failure in either leaves both as they were (FR-STORE-06). */
  async commitFacts(
    envId: string,
    collectorId: string,
    tries: readonly StoredTaskTry[],
    watermark: number,
  ): Promise<void> {
    const foreign = tries.find((t) => t.envId !== envId);
    if (foreign !== undefined)
      throw new RangeError(`commitFacts for ${envId} was given a try of environment ${foreign.envId}`);
    if (!Number.isFinite(watermark))
      throw new RangeError(`commitFacts for ${envId} was given no finite watermark`);
    await this.write(async (con) => {
      await con.run(`INSERT OR REPLACE INTO meta.watermarks VALUES ($1, $2, $3, to_timestamp($4))`, [
        envId,
        collectorId,
        watermark,
        seconds(this.now()),
      ]);
      if (tries.length > 0) await this.mergeTries(con, tries);
    });
  }

  /** Raw retention: snapshots, worker samples and first-seen ready times older than `before`. */
  prune(before: number): Promise<void> {
    return this.write(async (con) => {
      const cutoff = [seconds(before)];
      await con.run(`DELETE FROM fact.live_snapshot WHERE taken_at < to_timestamp($1)`, cutoff);
      await con.run(`DELETE FROM fact.worker_sample WHERE sampled_at < to_timestamp($1)`, cutoff);
      await con.run(`DELETE FROM fact.ready_time WHERE ready_at < to_timestamp($1)`, cutoff);
    });
  }

  // ── CollectionStore: reads ───────────────────────────────────────────────────────────────────────

  async backfill(envId: string, collectorId: string): Promise<BackfillProgress | null> {
    const [row] = await this.rows(`SELECT * FROM meta.backfill WHERE env_id = $1 AND collector_id = $2`, [
      envId,
      collectorId,
    ]);
    if (row === undefined) return null;
    const required = (column: string) => {
      const value = num(row[column]);
      if (value === null) throw new TypeError(`meta.backfill has no ${column} for ${envId} ${collectorId}`);
      return value;
    };
    return {
      from: required('from_ms'),
      to: required('to_ms'),
      coveredFrom: required('covered_from_ms'),
      itemsRead: required('items_read'),
      requestsUsed: required('requests_used'),
      startedAt: required('started_at_ms'),
      completedAt: num(row['completed_at_ms']),
    };
  }

  async watermark(envId: string, collectorId: string): Promise<number | null> {
    const [row] = await this.rows(
      `SELECT value_ms FROM meta.watermarks WHERE env_id = $1 AND collector_id = $2`,
      [envId, collectorId],
    );
    return row === undefined ? null : num(row['value_ms']);
  }

  async config(envId: string): Promise<EnvironmentConfig | null> {
    const [row] = await this.rows(`SELECT payload FROM dim.environment_config WHERE env_id = $1`, [envId]);
    if (row === undefined) return null;
    const value = payload(row['payload'], 'environment config', {
      envId: 'string',
      tier: 'string',
      parallelism: 'number',
      pools: 'array',
    });
    return value as unknown as EnvironmentConfig;
  }

  async dags(envId: string): Promise<DagMeta[]> {
    const rows = await this.rows(
      `SELECT dag_id, fileloc, owners, tags, team, schedule, max_active_tasks, max_active_runs, catchup, paused
       FROM dim.dag WHERE env_id = $1 ORDER BY dag_id`,
      [envId],
    );
    return rows.map((r) => ({
      dagId: str(r['dag_id']),
      fileloc: str(r['fileloc']),
      owners: strings(r['owners']),
      tags: strings(r['tags']),
      team: str(r['team']),
      schedule: str(r['schedule']),
      maxActiveTasks: Number(r['max_active_tasks']),
      maxActiveRuns: Number(r['max_active_runs']),
      catchup: bool(r['catchup']),
      paused: bool(r['paused']),
    }));
  }

  async snapshots(envId: string, from: number, to: number): Promise<StoredLiveSnapshot[]> {
    const rows = await this.rows(
      `SELECT payload, span_ms FROM fact.live_snapshot
       WHERE env_id = $1 AND taken_at >= to_timestamp($2) AND taken_at < to_timestamp($3) ORDER BY taken_at`,
      [envId, seconds(from), seconds(to)],
    );
    return rows.map((r) => {
      const snapshot = payload(r['payload'], 'live snapshot', {
        at: 'number',
        scheduled: 'array',
        queued: 'array',
        pools: 'array',
        dagActive: 'object',
        executor: 'object',
        workers: 'object',
      }) as unknown as StoredLiveSnapshot;
      const spanMs = num(r['span_ms']);
      return spanMs === null ? snapshot : { ...snapshot, spanMs };
    });
  }

  async workerSamples(envId: string, from: number, to: number): Promise<WorkerSample[]> {
    const rows = await this.rows(
      `SELECT epoch_ms(sampled_at)::DOUBLE AS at, workers, target, running, queued, cpu, memory FROM fact.worker_sample
       WHERE env_id = $1 AND sampled_at >= to_timestamp($2) AND sampled_at < to_timestamp($3) ORDER BY sampled_at`,
      [envId, seconds(from), seconds(to)],
    );
    return rows.map((r) => ({
      at: Number(r['at']),
      workers: Number(r['workers']),
      target: Number(r['target']),
      running: Number(r['running']),
      queued: Number(r['queued']),
      cpu: Number(r['cpu']),
      memory: Number(r['memory']),
    }));
  }

  async snapshotHorizon(envId: string): Promise<RetentionHorizon> {
    return this.horizon(envId, 'snapshots');
  }

  async platformHealth(envId: string): Promise<PlatformHealth> {
    const [r] = await this.rows(`SELECT * FROM fact.platform_health WHERE env_id = $1`, [envId]);
    if (r === undefined) return NO_HEALTH;
    return {
      envHealthyRatio: num(r['env_healthy_ratio']),
      dbHealthyRatio: num(r['db_healthy_ratio']),
      heartbeatCompleteness: num(r['heartbeat_completeness']),
      webServerHealthyRatio: num(r['web_server_healthy_ratio']),
      dbCpuMemoryMax: num(r['db_cpu_memory_max']),
      zombies24h: num(r['zombies_24h']),
      workerRestarts24h: num(r['worker_restarts_24h']),
      importErrors: num(r['import_errors']),
      parseLoopP95Seconds: num(r['parse_loop_p95_s']),
    };
  }

  // ── RetentionStore (FR-STORE-02, FR-STORE-06, FR-STORE-07) ─────────────────────────────────────────

  async retainedEnvironments(): Promise<string[]> {
    const union = Object.values(FAMILIES)
      .map((f) => `SELECT DISTINCT env_id FROM ${f.table}`)
      .join(' UNION ');
    return (await this.rows(`SELECT env_id FROM (${union}) ORDER BY env_id`)).map((r) => str(r['env_id']));
  }

  async oldest(envId: string, family: RetainedFamily): Promise<number | null> {
    const f = FAMILIES[family];
    const [row] = await this.rows(
      `SELECT epoch_ms(min(${f.age}))::DOUBLE AS t FROM ${f.table} WHERE env_id = $1 AND NOT ${f.kept}`,
      [envId],
    );
    return num(row?.['t']);
  }

  /** One batch: DuckDB has no `DELETE … LIMIT`, so the batch is chosen by `rowid`. */
  deleteExpired(envId: string, family: RetainedFamily, before: number, limit: number): Promise<number> {
    const f = FAMILIES[family];
    return this.write(async (con) => {
      await recordHorizon(con, envId, family, { deletedBefore: before }, this.now());
      const result = await con.run(
        `DELETE FROM ${f.table} WHERE rowid IN (
           SELECT rowid FROM ${f.table}
           WHERE env_id = $1 AND ${f.age} < to_timestamp($2) AND NOT ${f.kept} LIMIT $3)`,
        [envId, seconds(before), Math.max(0, Math.floor(limit))],
      );
      return Number(result.rowsChanged);
    });
  }

  /**
   * Finds the oldest bucket before `options.before` that is raw or holds more than one snapshot, then thins
   * the day from that bucket on: it reads only times and spans (never payloads), plans with the domain's
   * `thinSnapshots`, deletes the dropped snapshots and stores the kept ones' spans. A kept snapshot keeps its
   * payload, coverage included, so a thinned sample still reads as a sample.
   */
  thinSnapshots(envId: string, options: ThinOptions): Promise<ThinResult> {
    const { bucketMs } = options;
    const end = Math.floor(options.before / bucketMs) * bucketMs;
    return this.write(async (con) => {
      const read = async (sql: string, values: DuckDBValue[]) =>
        (await con.runAndReadAll(sql, values)).getRowObjectsJS();
      const [first] = await read(
        `SELECT min(t) AS t FROM (
           SELECT epoch_ms(taken_at)::DOUBLE AS t, span_ms,
                  count(*) OVER (PARTITION BY floor(epoch_ms(taken_at) / $3)) AS n
           FROM fact.live_snapshot WHERE env_id = $1 AND taken_at < to_timestamp($2))
         WHERE n > 1 OR span_ms IS NULL`,
        [envId, seconds(end), bucketMs],
      );
      const oldest = num(first?.['t']);
      if (oldest === null) return { dropped: 0, done: true };
      const from = Math.floor(oldest / bucketMs) * bucketMs;
      const to = Math.min(from + DAY_MS, end);
      const slice = await read(
        `SELECT epoch_ms(taken_at)::DOUBLE AS t, span_ms FROM fact.live_snapshot
         WHERE env_id = $1 AND taken_at >= to_timestamp($2) AND taken_at < to_timestamp($3) ORDER BY taken_at`,
        [envId, seconds(from), seconds(to)],
      );
      const [next] = await read(
        `SELECT epoch_ms(min(taken_at))::DOUBLE AS t FROM fact.live_snapshot
         WHERE env_id = $1 AND taken_at >= to_timestamp($2)`,
        [envId, seconds(to)],
      );
      const plan = thinSnapshots(
        slice.map((r) => {
          const spanMs = num(r['span_ms']);
          return {
            at: Number(r['t']),
            ...(spanMs === null ? {} : { spanMs }),
          };
        }),
        { before: to, bucketMs, nextAt: num(next?.['t']), fallbackCadenceMs: options.fallbackCadenceMs },
      );
      await con.run('DELETE FROM meta.staging_snapshot_span');
      await append(
        con,
        'staging_snapshot_span',
        [...plan.dropped.map((at) => ({ at, spanMs: null })), ...plan.spans],
        (a, r) => {
          double(a, r.at);
          double(a, r.spanMs);
        },
      );
      const window = `s.env_id = $1 AND s.taken_at >= to_timestamp($2) AND s.taken_at < to_timestamp($3)
                      AND epoch_ms(s.taken_at) = x.at_ms`;
      const bounds = [envId, seconds(from), seconds(to)];
      await con.run(
        `DELETE FROM fact.live_snapshot AS s USING meta.staging_snapshot_span AS x WHERE ${window} AND x.span_ms IS NULL`,
        bounds,
      );
      await con.run(
        `UPDATE fact.live_snapshot AS s SET span_ms = x.span_ms FROM meta.staging_snapshot_span AS x
         WHERE ${window} AND x.span_ms IS NOT NULL`,
        bounds,
      );
      await con.run('DELETE FROM meta.staging_snapshot_span');
      await recordHorizon(con, envId, 'snapshots', { thinnedBefore: to }, this.now());
      return { dropped: plan.dropped.length, done: to >= end };
    });
  }

  async horizon(envId: string, family: RetainedFamily): Promise<RetentionHorizon> {
    const [row] = await this.rows(
      `SELECT epoch_ms(deleted_before)::DOUBLE AS deleted, epoch_ms(thinned_before)::DOUBLE AS thinned
       FROM meta.retention_horizon WHERE env_id = $1 AND family = $2`,
      [envId, family],
    );
    return { deletedBefore: num(row?.['deleted']), thinnedBefore: num(row?.['thinned']) };
  }

  /** Runs between writes, never inside one, so it waits for no transaction of DCAM's own. */
  checkpoint(): Promise<void> {
    return this.writes.run(async () => {
      await this.writer.run('CHECKPOINT');
    });
  }

  /**
   * `PRAGMA database_size` counts the blocks in use; the WAL is read from the file system because the pragma
   * reports its size as formatted text. An in-memory store has no file, so both sizes are zero.
   */
  async storageUsage(): Promise<StorageUsage> {
    const [r] = await this.rows('PRAGMA database_size');
    const size = (path: string) => (existsSync(path) ? statSync(path).size : 0);
    const memory = this.path === ':memory:';
    const file = memory ? 0 : size(this.path);
    const wal = memory ? 0 : size(`${this.path}.wal`);
    const used = Number(r?.['used_blocks'] ?? 0) * Number(r?.['block_size'] ?? 0);
    return { fileBytes: file + wal, usedBytes: used + wal };
  }
}

/** Inserts or replaces one snapshot; a thinned snapshot's span goes to `span_ms`, not into the payload. */
async function insertSnapshot(
  con: DuckDBConnection,
  envId: string,
  snapshot: StoredLiveSnapshot,
): Promise<void> {
  const { spanMs, ...rest } = snapshot;
  await con.run(
    `INSERT OR REPLACE INTO fact.live_snapshot (env_id, taken_at, payload, span_ms)
     VALUES ($1, to_timestamp($2), $3, $4)`,
    [envId, seconds(snapshot.at), JSON.stringify(rest), spanMs ?? null],
  );
}

/** Moves a family's horizon forward (never back) inside the caller's transaction. */
async function recordHorizon(
  con: DuckDBConnection,
  envId: string,
  family: RetainedFamily,
  moved: { readonly deletedBefore?: number; readonly thinnedBefore?: number },
  now: number,
): Promise<void> {
  const later = (column: string) =>
    `${column} = greatest(coalesce(meta.retention_horizon.${column}, excluded.${column}),
                          coalesce(excluded.${column}, meta.retention_horizon.${column}))`;
  await con.run(
    `INSERT INTO meta.retention_horizon VALUES ($1, $2, to_timestamp($3), to_timestamp($4), to_timestamp($5))
     ON CONFLICT (env_id, family) DO UPDATE SET ${later('deleted_before')}, ${later('thinned_before')},
       updated_at = excluded.updated_at`,
    [envId, family, seconds(moved.deletedBefore ?? null), seconds(moved.thinnedBefore ?? null), seconds(now)],
  );
}

/** Opens a store; `:memory:` for demo mode and tests, or a file path (see `openFileStore` for the data directory). */
export function openStore(options: OpenStoreOptions): Promise<DuckDbStore> {
  return DuckDbStore.open(options);
}

async function bootstrap(
  con: DuckDBConnection,
  now: () => number,
  migrations: readonly Migration[],
): Promise<void> {
  await con.run(`SET TimeZone = 'UTC'`);
  await con.run(`CREATE SCHEMA IF NOT EXISTS meta`);
  await con.run(
    `CREATE TABLE IF NOT EXISTS meta.store_info (key VARCHAR PRIMARY KEY, value VARCHAR NOT NULL)`,
  );
  await con.run(
    `CREATE TABLE IF NOT EXISTS meta.schema_migrations (id VARCHAR PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL)`,
  );
  await checkVersion(con);
  await migrate(con, now, migrations);
}

async function checkVersion(con: DuckDBConnection): Promise<void> {
  const rows = (
    await con.runAndReadAll(`SELECT value FROM meta.store_info WHERE key = 'store_major'`)
  ).getRowObjectsJS();
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

async function migrate(
  con: DuckDBConnection,
  now: () => number,
  migrations: readonly Migration[],
): Promise<void> {
  const applied = new Set(
    (await con.runAndReadAll(`SELECT id FROM meta.schema_migrations`))
      .getRowObjectsJS()
      .map((r) => str(r['id'])),
  );
  for (const m of migrations) {
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

function toTry(r: Row): StoredTaskTry {
  return {
    envId: str(r['env_id']),
    dagId: str(r['dag_id']),
    runId: str(r['run_id']),
    taskId: str(r['task_id']),
    mapIndex: Number(r['map_index']),
    tryNumber: Number(r['try_number']),
    state: r['state'] === null ? null : str(r['state']),
    pool: str(r['pool']),
    poolSlots: Number(r['pool_slots']),
    queuedAt: num(r['queued_at']),
    startAt: num(r['start_at']),
    endAt: num(r['end_at']),
    sourceUpdatedAt: num(r['source_updated_at']),
    readyAt: num(r['ready_at']),
    operator: r['operator'] === null ? null : str(r['operator']),
    seenRunningAt: num(r['seen_running_at']),
    endEstimated: bool(r['end_estimated']),
  };
}
