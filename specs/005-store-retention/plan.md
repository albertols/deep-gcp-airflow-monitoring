# Plan 005: store retention and disk budget

## Shape

```text
dcam.config.yaml retention.* ─▶ @dcam/config-file ─▶ WorkspaceConfig.retention, EnvironmentEntry.retention
apps/server live workspace
  ├─ collection engine (unchanged)
  └─ maintenance job (@dcam/application maintenance/): on start, every hour a usage check, every 24 h retention
       ├─ per environment and family: RetentionStore.deleteExpired(…, 5,000 rows) until done, then CHECKPOINT
       ├─ usage ≥ 90 % of the budget: thinSnapshots (older than 24 h, one per 5 min), CHECKPOINT
       └─ still ≥ 90 %: delete whole days of the oldest data, oldest first (never the last 8 days)
  @dcam/duckdb-store: RetentionStore (migration 0006: live_snapshot.span_ms, meta.retention_horizon)
  GET /api/v1/collection ─▶ storage (size, budget, state, last run) + per-environment retention
  GET /bottlenecks ─▶ snapshot_retention (deleted before, thinned before)
```

## Packages touched

| Package                          | Change                                                                                                     |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `packages/domain`                | `retention.ts`: classes, defaults, limits, `thinSnapshots`; `LiveSnapshot.spanMs?`; spans honour it         |
| `packages/ports`                 | `RetentionStore`, `RetentionSettings`; optional `WorkspaceConfig.retention`, `EnvironmentEntry.retention`, `EnvironmentModelSource.snapshotHorizon` |
| `packages/adapters/config-file`  | `retention` section and `environments[].retention`, JSON Schema, example file                              |
| `packages/adapters/duckdb-store` | migration `0006_retention`; `RetentionStore` implementation                                                 |
| `packages/application`           | `maintenance/` job and status; `bottlenecks.ts` adds `snapshot_retention` (three lines)                     |
| `packages/contracts`             | additive: `Collection.storage`, `CollectionEnvironment.retention`, `Bottlenecks.snapshot_retention`        |
| `apps/server`                    | wires the job in the live workspace, stops it before the store closes                                       |
| `apps/web`                       | DCAM health page: local store panel, retention per environment                                              |

## Thinning and why counts stay right

A thinned snapshot keeps the first snapshot of each 5-minute bucket and stores, in `span_ms`, the time the
bucket's snapshots stood for (each the gap to the next, capped at two cadences, `snapshot-time.ts`). Reads give
it back as `LiveSnapshot.spanMs`; `snapshotSpans` uses it instead of the gap rule, and the observed cadence is
taken from raw snapshots only. So covered time is exact and waiting task-time is the kept snapshot's waiting
times the time it stands for: an estimate whose error is the variation within 5 minutes (golden test: ≤ 5 %).
Task tries are never thinned, so slot-seconds stay exact. Worker samples are not thinned: one a minute is
about 20,000 rows per environment per 14 days, and `capacityStats` counts each sample as one minute.

## Constitution check

- Read-only: no network, no new allowlist entry; the job only deletes DCAM's own local rows.
- Domain stays pure (thinning takes times as input). Application imports only ports, domain, contracts.
- Test first: every task starts with a failing test named after its requirement.
- No real data: the golden tests use the demo simulator (`acme-*`).
- Facts: DuckDB reuses freed blocks and does not shrink the file (observed on 2.0.0, ⚠️ VERIFY against
  https://duckdb.org/docs/stable/operations_manual/footprint_of_duckdb/reclaiming_space).

## Testing

Domain unit tests; store tests on in-memory and file DuckDB; job tests with a fake store, clock and sleeper;
server golden tests over 16 simulated hours (retention, thinning, crash and resume); web page tests.
