# Plan 003: global context bar and URL as state

## Shape

```text
URL  #/dags?env=acme-prod&range=30d&tz=local&paused=1&team=finance-data&sort=runs.asc
 │        └─ context bar (router ViewState) ─┘ └─ page params (usePageParam) ─┘
 ▼
apps/web App ── ContextBar: environment · time range · UTC/local · pause/resume · data as of
 │   ViewContext { range, tz, paused, time formatters }   PageParamsContext { params, set }
 ▼
pages: useView().range in every query key · useRefresh() (no polling while paused) · useTimeFormat()
 │
GET …/overview|dags|dags/{dag}|bottlenecks|schedule?range=15m…90d   (contract: Range enum, additive)
 ▼
application: RANGE_MS, CHART_BUCKET_MS (≤ 360 buckets) · slicesOf(): the store read a day at a time
             (bottlenecks: a week at a time, so 7 days are one read)
 ▼
domain: createLeagueAccumulator · createCapacityAccumulator · createAttribution · createPoolActivity ·
        createPriorityFairness · createSlotsPerMinute · createSelfThrottle · createActualRunStarts
        (equal to the one-query functions; property tests check every slicing)
```

## Packages touched

| Package                | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts`   | `Range` enum gains `15m`, `7d`, `30d`, `90d` (one shared parameter, the overview now uses it too); optional `coverage` on `EnvironmentOverview` and `DagLeague`; `bucket_seconds` described; `Range` type derived from the generated parameter                                                                                                                                                                                                                         |
| `packages/domain`      | Slice accumulators for the league (HM-015 flakiness observed and inferred, never-ran tries, unfinished runs), slot-seconds and peak, waiting attribution with top pools and thinned spans, pool activity, priority bands, executor slots and their source, HM-005 and actual run starts; `createSpanStream`; `rankLeague` shared by `dagLeague`; `ownsTry` (each try counts once, in the slice it started in); `NeighbourTry` narrowed to the four fields HM-017 reads |
| `packages/application` | `range.ts` (presets, lengths, chart buckets); `slices.ts` (one-day slices, read 1 ms early; history coverage); overview, league, detail (with its HM-016 baseline: per-DAG read or day slices) and schedule read day slices; bottlenecks week slices (HM-017 keeps four fields per try beyond a week); benchmark `test:perf`; a test that any bottleneck slice length gives the same analysis                                                                          |
| `apps/server`          | `parseRange` accepts every preset and lists them in the 400 fix hint                                                                                                                                                                                                                                                                                                                                                                                                   |
| `apps/web`             | Router with view state and page params; `ContextBar`; view and page-param contexts; time formatters (UTC or local) used by every rendered time; pages lose their own range state; DAG league filters, sort, the selected run, table views and alert filters in the URL; chart axes show dates for ranges over a day and name the bucket                                                                                                                                |

No port changes: the application reads slices through the existing `TaskInstanceStore.taskTries`,
`dagTaskTries` and `historyStart` and `EnvironmentModelSource.snapshots`; `packages/adapters/duckdb-store` and
the collectors are untouched. `bottlenecksInWindow` takes an optional slice length (tests only).

## Constitution check

- **Read-only.** No new network path; the server only accepts more values of an existing parameter.
- **Domain pure.** The accumulators are pure; the application does the reading.
- **Test first.** Each task starts with a failing test named after its requirement.
- **Public repository.** The benchmark uses a synthetic `acme_dag_*` environment generated in memory.
- **Facts.** No new Composer or Airflow facts. Bucket sizes and the one-day slice are DCAM's own choices.

## Testing

- Domain: property tests (fast-check) that any slicing equals the one-query result for the league,
  slot-seconds and peak, and waiting attribution.
- Application: every preset's length and bucket; overview, league, detail and bottlenecks over 15 m, 7, 30 and
  90 days; each store read spans at most a day; `test:perf` benchmark at 2,000 DAGs and 20,000 tries a day.
- Server: every preset conforms to the contract; bucket sizes and counts; the 400 problem lists the presets.
- Web: router round trip; the context bar refetches every panel with the new range; paused stops polling;
  the time zone toggle changes rendered times; opening a link restores range, zone, paused, filters and run.

## Measured (NFR-PERF-01)

`pnpm --filter @dcam/application test:perf` (add `DCAM_PERF_LONG=1` for 30 and 90 days): synthetic store in
memory, 2,000 DAGs, about 20,000 tries a day, the maintainer's Intel Mac with other work running (load 3 to
11). First call, no memo. After the merge with features 004 to 007 (the bottleneck analysis now includes
HM-017 noisy neighbours with a block bootstrap, HM-023 priority bands and pool activity).

| Range   | Tries generated (both windows) | DAG league | Bottlenecks |
| ------- | ------------------------------ | ---------- | ----------- |
| 7 days  | 288,000                        | 1.5 s      | 1.0 s       |
| 30 days | 1.24 million                   | 4.3 s      | 5.8 s       |
| 90 days | 3.7 million                    | 26 s       | 49 s        |

Feature 007's own test (`bottlenecks-perf.test.ts`, 7 days, CPU time) gives 1.7 to 2.0 s, as before the
merge (1.65 to 1.95 s for the one-read version on the same machine).

7 days meets the 2 s target. 30 days works and holds one day (league) or one week (bottlenecks) of tries at a
time, but takes seconds: the page says so while it loads. HM-017 needs every try of the range at once and,
beyond a week, keeps four fields per try. 90 days is slow and needs a large heap in this benchmark, where the
whole synthetic history (1.25 GB) sits in the same heap as the analysis: with the default heap the run ran out
of memory, with `NODE_OPTIONS=--max-old-space-size=8192` it ended at 2.3 GB. Not profiled yet; the likely
costs are the per-run and per-task-instance totals of the league (about 600,000 runs and 1.8 million task
instances here) and HM-017 over 129,600 minutes. Rollups (FR-STORE-02, M2) or aggregation in the store are the
fix; both need the DuckDB adapter, which this feature does not change. Demo mode (48 h of data, in-memory
DuckDB): 90-day league 1.7 s, mostly the cost of 180 one-day queries.
