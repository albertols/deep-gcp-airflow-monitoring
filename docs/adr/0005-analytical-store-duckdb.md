---
status: proposed
date: 2026-11-05
decision-makers: DCAM maintainers
consulted: Claude Code (research subagents, code-reviewer)
informed: contributors
---

# DuckDB 2.0 LTS as the embedded analytical store

## Context and Problem Statement

DCAM computes window functions and rollups over millions of task instance tries on a laptop (spec §11.7,
NFR-PERF-*). It needs an embedded, columnar engine whose SQL can also run in Python later (P-9).

## Decision Drivers

- Analytical speed on a laptop; Parquet for the cold tier
- Same SQL in a future Python runtime
- Prebuilt binaries for every supported platform, including Intel macOS 12
- Safe upgrades (NFR-REL-04, NFR-PORT-04)

## Considered Options

- DuckDB through `@duckdb/node-api`, pinned to the 2.0 LTS line
- DuckDB 1.5
- SQLite; ClickHouse; Postgres

## Decision Outcome

Chosen option: "DuckDB 2.0 LTS through @duckdb/node-api (exact pin 2.0.0-r.1)", because it is columnar,
embedded, fast and runs unchanged from Python.

### Consequences

- Good, because the M0 smoke test on Intel macOS 12 / Node.js 22 loaded the darwin-x64 binary, wrote and
  read Parquet, and ran an occupancy-style window query over 400,000 events in 69 ms.
- Good, because ingestion uses an appender into a staging table and one `INSERT OR REPLACE` per batch
  (spec §11.7): 100,000 rows in well under 5 s in tests.
- Bad, because **DuckDB 2.1 drops macOS x64**. DCAM stays on the 2.0 LTS line while Intel Macs are
  supported; 1.5 is the fallback. The end of Intel Mac support needs its own ADR (risk R-18).
- Bad, because files written by DuckDB 2.0 cannot be read by older engines; DCAM also records its own
  storage major version and refuses to open newer data (`StoreVersionError`).
- Neutral: one writer process; the CLI and future MCP bridge go through the HTTP API.

### Confirmation

`packages/adapters/duckdb-store/test/store.test.ts` (migrations, idempotent upserts, version guard, bulk
speed); `dcam doctor` checks that the native binary loads.

## More Information

https://duckdb.org/2026/10/21/announcing-duckdb-200 · spec §11.7, NFR-PORT-04.
