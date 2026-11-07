# Tasks 006: DAG detail in depth

Test tasks come before the code they cover.

## Domain

- [ ] T-600 Test + code: normal CDF, one-sided Mann–Whitney U, Benjamini–Hochberg (HM-016, §8.9)
- [ ] T-601 Test + code: duration distribution and regression verdict per DAG and task (HM-016, FR-TASK-01)
- [ ] T-602 Test + code: reliability per DAG and task; shared flakiness with the inferred case (HM-015, FR-TASK-02)
- [ ] T-603 Test + code: timing-estimated critical path and its frequency per task (HM-007, FR-DAGD-03)

## Contract and application

- [ ] T-610 Contract: additive `DagDetail` fields; `pnpm gen`; optional port `dagTaskTries` (FR-DAGD-03/04, HM-016)
- [ ] T-611 Test + code: `getDagDetail` reads the 28-day baseline and fills the new fields (HM-016, HM-015, HM-007)
- [ ] T-612 Test: 50 tasks × 96 runs a day × 7 days answers in < 1 s (NFR-PERF)

## Demo

- [ ] T-620 Test + code: blueprint `slowdown`; demo DAG `search_ranking_refresh` regressed; demo stories through the
      server (FR-EMU-03, HM-016, HM-015)

## Web

- [ ] T-630 Test + code: duration against baseline panel (FR-TASK-01, HM-016, FR-UI-05/07/08)
- [ ] T-631 Test + code: failures, retries and flakiness panel (HM-015, FR-UI-05/07/08)
- [ ] T-632 Test + code: critical path on the Gantt and its summary (HM-007, FR-DAGD-03)
- [ ] T-633 Test + code: league "Flaky" column (FR-DAGX-02, HM-015)

## Done

- [ ] T-690 Package tests and typecheck, lint, depcruise, hygiene, prettier
- [ ] T-691 Browser validation against `pnpm dcam --demo`; code review
