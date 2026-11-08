/** Versioned schema migrations (FR-STORE-01). Never edit an applied migration; add a new one. */
export interface Migration {
  readonly id: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: '0001_initial',
    sql: `
      CREATE SCHEMA IF NOT EXISTS fact;
      CREATE TABLE fact.task_instance (
        env_id            VARCHAR NOT NULL,
        dag_id            VARCHAR NOT NULL,
        run_id            VARCHAR NOT NULL,
        task_id           VARCHAR NOT NULL,
        map_index         INTEGER NOT NULL DEFAULT -1,
        try_number        INTEGER NOT NULL,
        state             VARCHAR,
        pool              VARCHAR NOT NULL,
        pool_slots        INTEGER NOT NULL DEFAULT 1,
        queued_at         TIMESTAMPTZ,
        start_at          TIMESTAMPTZ,
        end_at            TIMESTAMPTZ,
        source_updated_at TIMESTAMPTZ,
        ingested_at       TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (env_id, dag_id, run_id, task_id, map_index, try_number)
      );
    `,
  },
  {
    // Per-batch staging table (spec §11.7 "Ingestion"): collectors bulk-append here, then one
    // INSERT OR REPLACE moves the batch into fact tables in a single transaction.
    id: '0002_staging',
    sql: `
      CREATE TABLE meta.staging_task_instance (
        env_id VARCHAR, dag_id VARCHAR, run_id VARCHAR, task_id VARCHAR, map_index INTEGER, try_number INTEGER,
        state VARCHAR, pool VARCHAR, pool_slots INTEGER,
        queued_s DOUBLE, start_s DOUBLE, end_s DOUBLE, updated_s DOUBLE
      );
    `,
  },
  {
    // When a try became ready (from live snapshots, HM-006) and its operator (sensor detection, HM-008).
    id: '0003_ready_operator',
    sql: `
      ALTER TABLE fact.task_instance ADD COLUMN ready_at TIMESTAMPTZ;
      ALTER TABLE fact.task_instance ADD COLUMN operator VARCHAR;
      ALTER TABLE meta.staging_task_instance ADD COLUMN ready_s DOUBLE;
      ALTER TABLE meta.staging_task_instance ADD COLUMN operator VARCHAR;
    `,
  },
  {
    // Live collection (feature 002, FR-COLL-03, FR-STORE-06). Latest-only tables are keyed by environment;
    // time series by (environment, time). Snapshots and configuration are nested model values written and read
    // whole, so they are stored as JSON text; worker samples, health and DAGs are columns for SQL use.
    id: '0004_collection',
    sql: `
      CREATE SCHEMA IF NOT EXISTS dim;
      CREATE TABLE dim.environment_config (
        env_id   VARCHAR PRIMARY KEY,
        payload  VARCHAR NOT NULL,      -- EnvironmentConfig as JSON
        saved_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE dim.dag (
        env_id          VARCHAR NOT NULL,
        dag_id          VARCHAR NOT NULL,
        fileloc         VARCHAR NOT NULL,
        owners          VARCHAR[] NOT NULL,
        tags            VARCHAR[] NOT NULL,
        team            VARCHAR NOT NULL,
        schedule        VARCHAR NOT NULL,
        max_active_tasks INTEGER NOT NULL,
        max_active_runs INTEGER NOT NULL,
        catchup         BOOLEAN NOT NULL,
        paused          BOOLEAN NOT NULL,
        saved_at        TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (env_id, dag_id)
      );
      CREATE TABLE meta.staging_dag (
        env_id VARCHAR, dag_id VARCHAR, fileloc VARCHAR, owners VARCHAR[], tags VARCHAR[], team VARCHAR,
        schedule VARCHAR, max_active_tasks INTEGER, max_active_runs INTEGER, catchup BOOLEAN, paused BOOLEAN
      );
      CREATE TABLE fact.platform_health (
        env_id                   VARCHAR PRIMARY KEY,
        env_healthy_ratio        DOUBLE,
        db_healthy_ratio         DOUBLE,
        heartbeat_completeness   DOUBLE,
        web_server_healthy_ratio DOUBLE,
        db_cpu_memory_max        DOUBLE,
        zombies_24h              DOUBLE,
        worker_restarts_24h      DOUBLE,
        import_errors            DOUBLE,
        parse_loop_p95_s         DOUBLE,
        saved_at                 TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE fact.live_snapshot (
        env_id  VARCHAR NOT NULL,
        taken_at TIMESTAMPTZ NOT NULL,
        payload VARCHAR NOT NULL,       -- LiveSnapshot as JSON
        PRIMARY KEY (env_id, taken_at)
      );
      CREATE TABLE fact.worker_sample (
        env_id  VARCHAR NOT NULL,
        sampled_at TIMESTAMPTZ NOT NULL,
        workers DOUBLE NOT NULL,
        target  DOUBLE NOT NULL,
        running DOUBLE NOT NULL,
        queued  DOUBLE NOT NULL,
        cpu     DOUBLE NOT NULL,
        memory  DOUBLE NOT NULL,
        PRIMARY KEY (env_id, sampled_at)
      );
      -- When a try was first seen ready (scheduled); Airflow 2.11 records no such timestamp (HM-006).
      CREATE TABLE fact.ready_time (
        env_id     VARCHAR NOT NULL,
        dag_id     VARCHAR NOT NULL,
        run_id     VARCHAR NOT NULL,
        task_id    VARCHAR NOT NULL,
        map_index  INTEGER NOT NULL,
        try_number INTEGER NOT NULL,
        ready_at   TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (env_id, dag_id, run_id, task_id, map_index, try_number)
      );
      CREATE TABLE meta.staging_ready_time (
        dag_id VARCHAR, run_id VARCHAR, task_id VARCHAR, map_index INTEGER, try_number INTEGER
      );
      CREATE TABLE meta.watermarks (
        env_id       VARCHAR NOT NULL,
        collector_id VARCHAR NOT NULL,
        value_ms     DOUBLE NOT NULL,   -- epoch milliseconds, as the collector defines it
        committed_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (env_id, collector_id)
      );
    `,
  },
  {
    // Estimated ends of tries that stopped showing as running before their finished row was read (HM-003,
    // FR-COLL-03), and when DCAM last saw a try running: the earliest its end can be.
    id: '0005_estimated_end',
    sql: `
      ALTER TABLE fact.task_instance ADD COLUMN end_estimated BOOLEAN DEFAULT false;
      ALTER TABLE fact.task_instance ADD COLUMN seen_running_at TIMESTAMPTZ;
      ALTER TABLE meta.staging_task_instance ADD COLUMN end_estimated BOOLEAN;
      ALTER TABLE meta.staging_task_instance ADD COLUMN seen_running_s DOUBLE;
      CREATE TABLE meta.staging_try_key (
        dag_id VARCHAR, run_id VARCHAR, task_id VARCHAR, map_index INTEGER, try_number INTEGER
      );
    `,
  },
  {
    // Backfill on first add (feature 004, FR-COLL-04): the plan and progress of each backfill, committed with
    // its rows so that a restart resumes where it stopped (FR-COLL-03, FR-STORE-06). Epoch milliseconds, as in
    // meta.watermarks.
    id: '0006_backfill',
    sql: `
      CREATE TABLE meta.backfill (
        env_id           VARCHAR NOT NULL,
        collector_id     VARCHAR NOT NULL,
        from_ms          DOUBLE NOT NULL,
        to_ms            DOUBLE NOT NULL,
        covered_from_ms  DOUBLE NOT NULL,
        items_read       BIGINT NOT NULL,
        requests_used    BIGINT NOT NULL,
        started_at_ms    DOUBLE NOT NULL,
        completed_at_ms  DOUBLE,
        saved_at         TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (env_id, collector_id)
      );
    `,
  },
  {
    // Retention and the disk budget (feature 005, FR-STORE-02, FR-STORE-07). 0006 is the backfill feature's.
    // `span_ms`: the time a thinned snapshot stands for (null on a raw snapshot). `retention_horizon`: how far
    // back each environment's data of a family is kept and unthinned, so pages can say what was deleted.
    // `meta.backfill` (0006) is progress state: it is kept, never expired.
    id: '0007_retention',
    sql: `
      ALTER TABLE fact.live_snapshot ADD COLUMN span_ms DOUBLE;
      CREATE TABLE meta.retention_horizon (
        env_id         VARCHAR NOT NULL,
        family         VARCHAR NOT NULL,   -- task-tries, ready-times, snapshots, worker-samples
        deleted_before TIMESTAMPTZ,
        thinned_before TIMESTAMPTZ,
        updated_at     TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (env_id, family)
      );
      CREATE TABLE meta.staging_snapshot_span (at_ms DOUBLE, span_ms DOUBLE);
    `,
  },
];
