# Feature 008: DAG concurrency, impact and comparisons

- **Epic / milestone:** DAGD · M3 (`FR-DAGD-05/06/09`, spec §22.2 L4627) and M2 (`FR-DAGD-08`)
- **Requirements:** FR-DAGD-05, FR-DAGD-06, FR-DAGD-08, FR-DAGD-09, HM-003, HM-005, HM-007, HM-011, HM-017,
  REC-DAG-01, NFR-DATA-03, NFR-DATA-04, NFR-PERF
- **Scope:** backend only (domain, application, contract, server, store read). The web panels for S-12
  "concurrency", S-13 run comparison and S-14 compare DAGs come in a later task.
- **Status:** implemented (backend); web panels, browser validation and code review pending

## Requirements extracted from docs/spec/dcam-spec.md

- **FR-DAGD-05** (L1678): "Concurrency profile: concurrent running task instances over time versus
  `max_active_tasks` and pool limits. — When the DAG hits its `max_active_tasks` limit for more than 10 % of its
  active time, the system shall raise `REC-DAG-01`."
- **REC-DAG-01** (L2867): "DAG is at its `max_active_tasks` limit for ≥ 10 % of its active time with its own tasks
  waiting (`HM-005`)."
- **HM-005** (L1023–1034): minutes where the DAG's running and queued task instances reach `max_active_tasks` while
  it has ready but unqueued work ÷ minutes the DAG was active. On Airflow 2 the limit counts running and queued
  task instances across all active runs of the DAG.
- **FR-DAGD-06** (L1679): "Impact on the environment: share of load over time and noisy-neighbour score. — The
  system shall show the DAG's noisy-neighbour score with confidence."
- **HM-017** (L1133–1145): the DAG's activity (≥ 10 % of slots) against other DAGs' queue waits (HM-001), matched
  by hour of week; effect = difference in median wait, bootstrap 95 % CI; "associated with", not caused.
- **FR-DAGD-08** (L1681): "Compare 2 to 4 DAGs (same or different environments): aligned KPIs, overlaid duration
  distributions, hourly load profiles, resource shares. — When DAGs from different environments are compared, the
  system shall normalise time zones and show each environment's capacity context."
- **FR-DAGD-09** (L1682): "Compare two runs of a DAG: per-task deltas of duration and queue wait. — The system shall
  rank tasks by their contribution to the run duration difference."
- **HM-007** (L1223–1235): "Mapped tasks are collapsed to their longest map index. Skipped branches are excluded.
  Retries add their wait and run time."
- **Screens** (L2451–2453): S-12 tab "concurrency"; S-13 run detail and run comparison; S-14 compare DAGs.
- **§8.1, §8.9, §12.8**: units and sources; p95 needs ≥ 20 samples; gaps are never zero; estimates are labelled.

## Decisions (where the spec leaves room)

1. **One HM-005.** The concurrency profile's self-throttling is the advisor's REC-DAG-01 computation, moved into a
   shared domain function (`dagLimitSignalOf`): each snapshot stands for the time to the next one, capped at two
   cadences; at the limit means running + queued ≥ `max_active_tasks` with own ready task instances. The rule's
   predicate (`raisesRecDag01`, ≥ 10 %) is the one the advisor evaluates; FR-DAGD-05 says "more than", REC-DAG-01
   "≥", and the rule wins. `stats.self_throttled_ratio` now uses the same function, so the page shows one HM-005
   number (it used minutes before; the demo story and tests are unchanged). The finding itself is the advisor's
   (last 24 h); DAG detail links it when it is open.
2. **Profile series.** Running task instances per bucket from tries (HM-011 sweep: mean and peak, exact),
   running + queued and ready from live snapshots (peak per bucket; `null` in buckets without snapshots), time at
   the limit per bucket, and per pool the DAG's slots in use (from tries) against the pool's occupied slots (from
   snapshots). Buckets as on the bottlenecks page: 1 min, 5 min, 15 min for 1 h, 6 h, 24 h.
3. **Share of load.** Per bucket: the DAG's executor slot-seconds ÷ the environment's (HM-003), and ÷ the executor
   slots (workers × `worker_concurrency`, HM-011) where they are known. Buckets before the environment's history
   start, or without load, are `null`.
4. **Noisy-neighbour score.** HM-017 exactly as the bottlenecks page computes it (same window, inputs, minimums and
   seeded minute-block bootstrap), evaluated for this one DAG; the status says why there is no score
   (not evaluated, inactive, below the minimums, not associated). The interval is computed for any qualified DAG.
5. **Compare DAGs.** Range 1 h, 6 h, 24 h or 7 d (default 24 h). KPIs are the league's (`dagWindowStats`); duration
   distributions are successful run durations with shared log-spaced bins; hourly load profiles are mean running
   slots per UTC hour of day over the hours DCAM has history for; resource shares are executor and pool
   slot-seconds against each environment's totals. The API is UTC (`time_zone: UTC`): DCAM collects neither
   environment display time zones nor DAG time zones, so normalising means comparing in UTC.
6. **Capacity context.** Per environment: worker slots, `worker_concurrency`, workers min and max, parallelism
   (`null` when unknown, HM-032), the default `max_active_tasks_per_dag`, pools, the environment's executor
   slot-seconds, and its utilisation of the maximum worker slots over the covered time.
7. **Compare runs.** Per task, the longest map index (wait plus running time over its tries, as HM-007 weighs
   them); retries add. Duration = running time, queue wait = HM-001. Contribution = the task's time on the
   timing-estimated critical path (HM-007/timing) of run b − run a; contributions sum to the run duration
   difference. Tasks are ranked by contribution in the direction of the difference; with a run still in progress
   (no critical path) by the duration delta, and the response says so.
8. **Reads.** DAG detail keeps its environment-wide read (HM-017 needs other DAGs' queue waits). Compare reads each
   DAG through `dagTaskTries` and each environment's totals through a new, optional store aggregate
   (`environmentLoad`); run comparison reads one DAG.

## User stories and acceptance criteria

1. **Concurrency (FR-DAGD-05).** As a DAG author I see how many of my tasks ran at once against
   `max_active_tasks` and my pools, and how often my own limit held my ready tasks back. AC: the share is the
   advisor's; REC-DAG-01 is flagged at ≥ 10 % and links the open finding; buckets without snapshots are `null`.
2. **Impact (FR-DAGD-06).** As an operator I see the DAG's share of the environment's load over time and its
   noisy-neighbour score with its confidence, or why it has none. AC: the score equals the bottlenecks page's item
   for the DAG; shares are `null`, not 0, before history.
3. **Compare DAGs (FR-DAGD-08).** As a platform engineer I compare 2 to 4 DAGs from any environments side by side.
   AC: 1 or 5 DAGs, duplicates and unknown ones are rejected with a problem; histograms share bins; profiles are UTC
   with 24 entries; each environment's capacity context is shown.
4. **Compare runs (FR-DAGD-09).** As a DAG author I see which tasks made run b slower or faster than run a.
   AC: per-task deltas of duration and queue wait; contributions sum to the duration difference; mapped tasks
   collapse to the longest map index.
5. **Performance.** DAG detail computations over 7 days < 1 s; a 4-DAG compare over 7 days < 2 s (application).

## Out of scope

- Web panels and explanations (later task); browser validation.
- Per-run `max_active_tasks` scope (Airflow 3, `af.maxActiveTasksScope`); task-level limits.
- Hour-of-week matching over 28 days for HM-017 (as feature 007: the selected range).
- Run comparison across DAGs; graph-based critical path and slack (needs `downstream_task_ids`).
