# Tasks 006: DAG detail in depth

Test tasks come before the code they cover.

## Domain

- [x] T-600 Test + code: normal CDF, one-sided Mann–Whitney U, Benjamini–Hochberg (HM-016, §8.9)
- [x] T-601 Test + code: duration distribution and regression verdict per DAG and task (HM-016, FR-TASK-01)
- [x] T-602 Test + code: reliability per DAG and task; shared flakiness with the inferred case (HM-015, FR-TASK-02)
- [x] T-603 Test + code: timing-estimated critical path and its frequency per task (HM-007, FR-DAGD-03)

## Contract and application

- [x] T-610 Contract: additive `DagDetail` fields; `pnpm gen`; optional port `dagTaskTries` (FR-DAGD-03/04, HM-016)
- [x] T-611 Test + code: `getDagDetail` reads the 28-day baseline and fills the new fields (HM-016, HM-015, HM-007)
- [x] T-612 Test: 50 tasks × 96 runs a day × 7 days answers in < 1 s (NFR-PERF); grouping without composite keys
      (`triesByRun`, `triesByTaskInstance`) made the 7-day computations about 4 × faster

## Demo

- [x] T-620 Test + code: blueprint `slowdown` and `durationSigma`; demo DAG `search_ranking_refresh` regressed; demo
      stories through the server (FR-EMU-03, HM-016, HM-015); checked at 24 demo start times

## Web

- [x] T-630 Test + code: duration against baseline panel (FR-TASK-01, HM-016, FR-UI-05/07/08)
- [x] T-631 Test + code: failures, retries and flakiness panel (HM-015, FR-UI-05/07/08)
- [x] T-632 Test + code: critical path on the Gantt and its summary (HM-007, FR-DAGD-03)
- [x] T-633 Test + code: league "Flaky" column (FR-DAGX-02, HM-015)

## Done

- [x] T-690 Package tests and typecheck, lint, depcruise, hygiene, prettier
- [ ] T-691 Browser validation against `pnpm dcam --demo` (the demo API was checked with curl; no browser here);
      code review
- [ ] T-692 Follow-up for the `duckdb-store` owner: implement `dagTaskTries` (one DAG, with an index on
      `env_id, dag_id, start_at`). DAG detail time in demo and live is dominated by the existing environment-wide
      read of the range and its previous period, not by the baseline
