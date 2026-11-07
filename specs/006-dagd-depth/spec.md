# Feature 006: DAG detail in depth

- **Epic / milestone:** DAGD, TASK · M2 demo step 6 (spec §22.6 L4736): "DAG detail. Gantt with queue wait and run
  time per task instance; self-throttling share (`HM-005`); failures, retries and flakiness (`HM-015`); duration
  regression against the 28-day baseline (`HM-016`)."
- **Requirements:** HM-016, FR-TASK-01, HM-015, FR-TASK-02 (part), HM-007, FR-DAGD-03 (critical path), FR-DAGD-04
  (baseline delta), FR-DAGX-02 (retries and flakiness column), FR-UI-05, FR-UI-07, FR-UI-08, NFR-DATA-03,
  NFR-DATA-04, NFR-PERF
- **Status:** implemented (browser validation and code review pending)

## Requirements extracted from docs/spec/dcam-spec.md

- **HM-016 Duration regression** (L1262): baseline = "the previous 28 days excluding the current window. Only
  successful tries are used, and maintenance windows are excluded". Flagged when current p95 ≥ 1.3 × baseline p95,
  ≥ 10 current samples, and a one-sided Mann–Whitney U test gives p < 0.01; Benjamini–Hochberg at q = 0.05 across
  tasks; PELT dates the shift.
- **FR-TASK-01** (L1689): "Duration distribution per task with a baseline band and regression flags. — When the p95
  duration over the selected window exceeds the baseline p95 by the configured margin with sufficient samples, the
  system shall flag a regression."
- **HM-015** (L1330): try failure rate = failed tries ÷ tries; run failure rate = failed runs ÷ runs; retry rate =
  task instances with try number > 1 ÷ task instances; flaky rate = task instances that succeeded after ≥ 1 failed
  try ÷ task instances; MTTR = time from the first failure to the next success. "Rates need ≥ 20 task instances."
  Error signatures need Cloud Logging.
- **FR-TASK-02** (L1690): failure rate, retry rate, flakiness, MTTR per DAG and task; "flakiness only for tasks
  with at least the configured minimum number of tries".
- **HM-007 Critical path** (L1223): longest path through the run's task graph from `downstream_task_ids`, weighted
  by each try's wait plus run time; slack per task; critical-path frequency per task across runs. Mapped tasks
  collapse to the longest map index; skipped branches are excluded; retries add their wait and run time.
- **FR-DAGD-03** (L1676): run Gantt "and the critical path highlighted" (critical path M3).
- **FR-DAGD-04** (L1677): task statistics include the baseline delta.
- **FR-DAGX-02** (L1662): the league lists retries; preset "Flaky" (FR-DAGX-07).
- **§8.9** (L1496): p95 needs ≥ 20 samples, otherwise the max and "low sample"; robust statistics, Mann–Whitney;
  Benjamini–Hochberg for many tests; every aggregate states its coverage.

## Decisions (where the spec leaves room)

1. **Windows.** The current window is the selected range (FR-TASK-01). The baseline is the 28 days before it
   (HM-016). HM-016's own defaults (24 h; 7 days for tasks that run less than daily) apply when DCAM raises
   `REC-DAG-08` on its own (M3).
2. **Thresholds.** Margin 1.3 ×, ≥ 10 current successful samples, one-sided Mann–Whitney p < 0.01 (normal
   approximation with tie and continuity correction), Benjamini–Hochberg q ≤ 0.05 across the tasks of the DAG (the
   family the page tests; environment-wide control comes with `REC-DAG-08`). The baseline p95 needs ≥ 20 samples
   (§8.9); otherwise "baseline not available yet", with the reason.
3. **Coverage.** The baseline states how many of its 28 days DCAM has history for (from the earliest stored try).
   A baseline shorter than 28 days is labelled partial, never padded.
4. **Flakiness in live history.** The backfill and `af.facts` store the latest try of a task instance and may never
   see an earlier failed try (spec 004, "earlier tries … are not backfilled"). A task instance whose only stored try
   succeeded with try number > 1 counts as flaky, inferred (method `HM-015/B`); the count of inferred ones is
   returned. ⚠️ VERIFY: in Airflow 2.10+ clearing a task instance also raises `try_number`, so the inference is an
   upper bound.
5. **Critical path without the graph.** DCAM does not collect `GET /dags/{dag_id}/tasks` yet, so it has no
   `downstream_task_ids`. The path is estimated from timing (method `HM-007/timing`): from the try that ended last,
   step back to the earlier try of the same task instance (a retry), else to the try that ended last before this
   one became ready (ready, else queued, else start). Waiting = gap to the previous step, so the path sums to the
   run duration. Labelled an estimate. No slack (needs the graph).

## User stories

- As a DAG author, I see whether my DAG and each task got slower than their own baseline, with the samples
  behind it, and an honest "not available yet" when DCAM lacks history.
- As an on-call engineer, I see which tasks fail, retry and are flaky, and how long recovery takes.
- As a DAG author, I see the chain of tasks that set a run's duration on the Gantt.

## Acceptance criteria

1. HM-016: given 24 baseline and 18 current successful samples doubled in duration, the task is flagged; with 9
   current samples it is "low sample"; with 19 baseline samples "no baseline"; with p ≥ 0.01 or ratio < 1.3 it is
   "within baseline". The DAG's successful run durations get the same verdict.
2. FR-TASK-01: each task has min, p25, p50, p75, p95 (max when low sample) and max now and in the baseline.
3. HM-015: per DAG and task, counts and rates as defined, rates null below 20; MTTR mean over recoveries.
4. HM-007: the selected finished run has a timing-estimated critical path whose steps sum to its duration; each
   task's critical-path frequency across finished runs in the range.
5. The league shows a "Flaky" column (flaky rate, retries in the tooltip).
6. Every new panel has an (i) entry, empty, partial and stale states, a provenance footer, units and labelled
   estimates. Loading and error come from the page query.
7. Demo: one task of `search_ranking_refresh` got 3 × slower 20 h ago (flagged at any demo start time over 24 h,
   "low sample" over 6 h); `fraud_scoring_hourly` is flaky.
8. Performance: DAG detail for a DAG of 50 tasks × 96 runs a day with 7 days stored answers in < 1 s in the
   application layer.

## Out of scope

- Error signatures (HM-015, FR-TASK-03): need Cloud Logging (`SRC-LOG`, M4/M7). The panel says "unavailable".
- PELT change-point dating and links to change events (HM-016, FR-CHG-*); maintenance-window exclusion (no source).
- Failure analytics by operator type and hour (FR-TASK-02), operator analytics (FR-TASK-04).
- Slack per task and the graph view (HM-007, FR-DAGD-07): need `downstream_task_ids`.
- A per-DAG store read (`dagTaskTries`) in `duckdb-store`: the port member is added, optional; DuckDB keeps the
  fallback (environment-wide read, filtered) until its owner implements it.
