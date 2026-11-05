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
];
