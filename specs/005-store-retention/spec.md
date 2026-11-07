# Feature 005: store retention and disk budget

- **Epic / milestone:** STORE · M2 requirements pulled forward for long unattended live runs (spec §22.2)
- **Requirements:** FR-STORE-02, FR-STORE-07, FR-STORE-06 (resumable maintenance)
- **Status:** done

## Intent

The maintainer leaves DCAM running for days against about 2,000 DAGs: tens of thousands of task tries a day,
a live snapshot every 30 to 60 s and a worker sample a minute. Until now nothing was ever deleted, so
`<dataDir>/dcam.duckdb` only grew. This feature deletes expired data by retention class, keeps the store within
a disk budget (thin first, then delete the oldest data), and says so in the API and on the DCAM health page.

## Requirements extracted from docs/spec/dcam-spec.md (line numbers refer to that file)

- **FR-STORE-02** (§9.4 L1613): tiered retention, defaults: raw runs and task instances 90 days; raw metric
  points 14 days; 5-minute rollups 90 days; 1-hour rollups 400 days; log signatures 30 days with bounded
  samples; findings and alert history 400 days. All configurable per environment. *When retention runs, the
  system shall delete or compact expired data and keep rollups consistent with raw data (golden tests).*
- **FR-STORE-06** (§9.4 L1617): crash safety through transactional writes. *If the process crashes, then on
  restart the store shall be consistent* (here: a maintenance run cut short resumes on the next run).
- **FR-STORE-07** (§9.4 L1618): disk budget. *If usage exceeds 90 % of the configured budget, then the system
  shall warn and downsample before deleting by age.*
- **§11.7 Retention and tiering** (L2219): a nightly (and on-start) maintenance job applies FR-STORE-02, runs
  `CHECKPOINT` and enforces the disk budget. (The Parquet cold tier, FR-STORE-03, is M8.)
- **§17.2** (L3478–3485): `retention.rawTaskInstancesDays: 90`, `rawMetricPointsDays: 14`, `rollup5mDays: 90`,
  `rollup1hDays: 400`, `logSignaturesDays: 30`, `findingsDays: 400`, `diskBudgetGb: 5`.
- **NFR-RES-03** (L1861): disk ≤ 2 GB for 90 days at reference scale with default retention.

## Tables and their retention class

| Table (migration)                                  | Holds                            | Class (default)               | Age of a row                                                             |
| -------------------------------------------------- | -------------------------------- | ----------------------------- | ------------------------------------------------------------------------ |
| `fact.task_instance` (0001)                        | task instance tries              | raw task instances (90 days)  | its end; a try that never started: queued, ready or ingested time; open tries are never deleted |
| `fact.ready_time` (0004)                           | first-seen ready times           | raw metric points (14 days)   | `ready_at` (copied into the try when it is stored)                       |
| `fact.live_snapshot` (0004)                        | `af.live` snapshots              | raw metric points (14 days)   | `taken_at`; thinned by the disk budget                                   |
| `fact.worker_sample` (0004)                        | one worker sample a minute       | raw metric points (14 days)   | `sampled_at`; not thinned (about 1 MB per environment per 14 days)       |
| `dim.environment_config`, `fact.platform_health`   | latest value per environment     | none (one row per environment)| replaced on every save                                                   |
| `dim.dag` (0004)                                   | latest DAG inventory             | none (one row per DAG)        | replaced by every complete inventory pass; not versioned                 |
| `meta.watermarks`, `meta.retention_horizon` (0006) | DCAM's own state                 | none                          |                                                                          |
| `meta.staging_*`                                   | per-batch staging                | none (emptied by every write) |                                                                          |

Rollups, log signatures, findings and alert history are not stored yet, so their settings are validated and
reported as not used. Data of environments no longer in the configuration expires with the workspace defaults.

## User stories

- As the maintainer, I want DCAM to run for weeks without its data directory growing past a budget I set.
- As a user of the bottlenecks page, I want to be told when snapshots in my range were deleted or thinned, so
  I never read missing history as "no waiting".
- As the maintainer, I want the DCAM health page to show the store's size, its budget and what maintenance did.

## Acceptance criteria

1. FR-STORE-02: on start and every 24 h, rows older than their class's retention are deleted per environment,
   in batches of at most 5,000 rows, each batch its own transaction touching one table, then `CHECKPOINT`.
   Golden test: exactly the expired rows go; the league and bottlenecks for the retained period are unchanged.
2. FR-STORE-02: retention is configurable per class, with hard minimum and maximum days, and per environment.
3. FR-STORE-07: usage (database blocks in use plus the WAL) is measured every hour. At ≥ 90 % of
   `retention.diskBudgetGb` the API and the health page warn; DCAM thins snapshots older than 24 h to one per
   5 minutes, then deletes whole days of the oldest data, oldest first, until usage is below 90 %, never data
   younger than 8 days. Thinning keeps slot-seconds exact and waiting task-time within 5 % (golden test).
4. FR-STORE-06: the job never runs twice at once, is idempotent, and a run cut short (crash between batches)
   is completed by the next run with the same result as one uninterrupted run.
5. Bottlenecks responses carry `snapshot_retention` (deleted before, thinned before) for the requested range.

## Out of scope

- Rollup pipeline (5-minute and 1-hour rollups) and the rollup-consistency half of FR-STORE-02's golden test:
  no rollup exists yet. A range longer than raw snapshot retention (14 days) needs 5-minute rollups of waiting
  time; until then such a range reports the deleted period instead.
- Parquet cold tier (FR-STORE-03), shrinking the database file (DuckDB reuses freed blocks; a compacting copy
  is a later step), persisted maintenance history across restarts.
