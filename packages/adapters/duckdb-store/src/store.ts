/**
 * DuckDB store (spec §11.7, ADR-0005). One writer process; idempotent upserts on natural keys;
 * a DCAM storage major version guards against opening data written by a newer DCAM (NFR-PORT-04).
 *
 * The store is the live workspace's `CollectionStore` and the demo's task-instance store. Writes run one at a
 * time on a dedicated connection, each in its own transaction, so concurrent collectors never share (or roll
 * back) each other's work (FR-STORE-06). Reads use a second connection and see committed data only.
 *
 * @implements FR-STORE-01, FR-STORE-06, FR-COLL-03, NFR-PORT-04, HM-003 (estimated ends), HM-006
 */
import {
  DuckDBInstance,
  LIST,
  VARCHAR,
  type DuckDBAppender,
  type DuckDBConnection,
  type DuckDBValue,
} from '@duckdb/node-api';
import type { DagMeta, EnvironmentConfig, LiveSnapshot, PlatformHealth, WorkerSample } from '@dcam/domain';
import type { CollectionStore, StoredTaskTry, TaskInstanceStore, TryKey } from '@dcam/ports';
import { MIGRATIONS, type Migration } from './migrations';

/** Bump when a migration cannot be read by older DCAM versions. */
export const STORE_MAJOR = 1;

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

/** The DuckDB store: {@link Store} for every workspace, {@link CollectionStore} for live collection. */
export class DuckDbStore implements Store, CollectionStore {
  private readonly writes = new Serial();

  private constructor(
    private readonly instance: DuckDBInstance,
    private readonly writer: DuckDBConnection,
    private readonly reader: DuckDBConnection,
    private readonly now: () => number,
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
      return new DuckDbStore(instance, writer, reader, now);
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
  private write(work: (con: DuckDBConnection) => Promise<void>): Promise<void> {
    return this.writes.run(async () => {
      const con = this.writer;
      await con.run('BEGIN TRANSACTION');
      try {
        await work(con);
        await con.run('COMMIT');
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
   * - Then every try of the batch's task instances that is still open while a later try exists ends at the
   *   later try's earliest known time (never before it started or was last seen running), estimated: a failed
   *   try rescheduled before `af.facts` read its row is no longer in the task instance list (HM-003).
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
                greatest(any_value(o.start_at), any_value(o.seen_running_at),
                         min(least(n.ready_at, n.queued_at, n.start_at, n.end_at))) AS end_at
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
    const rows = await this.rows(
      `SELECT env_id, dag_id, run_id, task_id, map_index, try_number, state, pool, pool_slots,
              epoch_ms(queued_at)::DOUBLE AS queued_at, epoch_ms(start_at)::DOUBLE AS start_at,
              epoch_ms(end_at)::DOUBLE AS end_at, epoch_ms(source_updated_at)::DOUBLE AS source_updated_at,
              epoch_ms(ready_at)::DOUBLE AS ready_at, operator, coalesce(end_estimated, false) AS end_estimated,
              epoch_ms(seen_running_at)::DOUBLE AS seen_running_at
       FROM fact.task_instance
       WHERE env_id = $1 AND start_at IS NOT NULL AND start_at < to_timestamp($3)
         AND (end_at IS NULL OR end_at > to_timestamp($2))`,
      [envId, seconds(from), seconds(to)],
    );
    return rows.map(toTry);
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
    await this.write(async (con) => {
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
    });
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

  saveSnapshot(envId: string, snapshot: LiveSnapshot): Promise<void> {
    return this.write(async (con) => {
      await con.run(`INSERT OR REPLACE INTO fact.live_snapshot VALUES ($1, to_timestamp($2), $3)`, [
        envId,
        seconds(snapshot.at),
        JSON.stringify(snapshot),
      ]);
    });
  }

  async saveWorkerSamples(envId: string, samples: readonly WorkerSample[]): Promise<void> {
    if (samples.length === 0) return;
    await this.write(async (con) => {
      // One statement per sample: a batch may repeat a minute, and the later sample wins.
      for (const s of samples)
        await con.run(
          `INSERT OR REPLACE INTO fact.worker_sample VALUES ($1, to_timestamp($2), $3, $4, $5, $6, $7, $8)`,
          [envId, seconds(s.at), s.workers, s.target, s.running, s.queued, s.cpu, s.memory],
        );
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

  async snapshots(envId: string, from: number, to: number): Promise<LiveSnapshot[]> {
    const rows = await this.rows(
      `SELECT payload FROM fact.live_snapshot
       WHERE env_id = $1 AND taken_at >= to_timestamp($2) AND taken_at < to_timestamp($3) ORDER BY taken_at`,
      [envId, seconds(from), seconds(to)],
    );
    return rows.map(
      (r) =>
        payload(r['payload'], 'live snapshot', {
          at: 'number',
          scheduled: 'array',
          queued: 'array',
          pools: 'array',
          dagActive: 'object',
          executor: 'object',
          workers: 'object',
        }) as unknown as LiveSnapshot,
    );
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
