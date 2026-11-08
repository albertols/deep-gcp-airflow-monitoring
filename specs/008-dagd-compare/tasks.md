# Tasks 008: DAG concurrency, impact and comparisons

Test tasks come before the code they cover.

## Domain

- [x] T-800 Test + code: shared HM-005 per DAG; the advisor uses it; REC-DAG-01 predicate exported (HM-005,
      REC-DAG-01)
- [x] T-801 Test + code: concurrency profile per bucket and pool, gaps as null (FR-DAGD-05, HM-011)
- [x] T-802 Test + code: HM-017 for one DAG equals the environment-wide item; statuses (FR-DAGD-06, HM-017)
- [x] T-803 Test + code: share of executor load and slots per bucket; environment load totals (FR-DAGD-06, HM-003)
- [x] T-804 Test + code: run comparison with critical-path contributions (FR-DAGD-09, HM-007)
- [x] T-805 Test + code: hourly UTC load profile and shared duration bins (FR-DAGD-08)

## Contract, application, store

- [x] T-810 Contract: additive DagDetail fields, comparison schemas and paths; `pnpm gen`
- [x] T-811 Test + code: `getDagDetail` concurrency and impact; one HM-005 number; finding link (FR-DAGD-05/06)
- [x] T-812 Test + code: `getDagComparison` (FR-DAGD-08) and `getRunComparison` (FR-DAGD-09)
- [x] T-813 Test + code: optional port `environmentLoad`; DuckDB aggregate equals the domain function (NFR-PERF)
- [x] T-814 Test: DAG detail 7-day computations < 1 s; 4-DAG compare over 7 days < 2 s (NFR-PERF)

## Server

- [x] T-820 Test + code: routes, conformance on demo data, demo stories, problems (FR-DAGD-05/06/08/09)

## Web

- [x] T-830 Test + code: API client for both comparisons; route `/compare/dags`; links that carry page parameters;
      the compare selection (2 to 4, `env:dag`) parsed and written back to the URL (FR-DAGD-08, FR-UI-02)
- [x] T-831 Test + code: concurrency panel: running, in flight and ready against `max_active_tasks` (default or
      set), pool lines, time at the limit, self-throttling against the 10 % threshold, REC-DAG-01 link; gaps as gaps;
      table view (FR-DAGD-05, HM-005, HM-011, REC-DAG-01)
- [x] T-832 Test + code: impact panel: share of the environment's load and of its slots over time; the noisy-neighbour
      score with its interval and confidence, or the reason and minimums, never a zero (FR-DAGD-06, HM-003, HM-017)
- [x] T-833 Test + code: the DAG's findings on DAG detail, linked to the advisor, which opens the linked finding
      (FR-DAGD-01 findings, FR-ADV-02)
- [x] T-834 Test + code: compare runs on DAG detail: the selected run against another (default the previous
      successful one), per-task deltas ranked by contribution, method stated (FR-DAGD-09, HM-007)
- [x] T-835 Test + code: compare DAGs page: 2 to 4 DAGs from any environment, aligned KPIs, overlaid duration
      distributions on shared bins, hourly profile in UTC, resource shares, capacity context (FR-DAGD-08)
- [x] T-836 Test + code: reach it from the league (select rows, then "Compare") and from DAG detail ("Compare with")
- [ ] T-837 Test + code: series palette for both themes (contrast ≥ 3:1, distinct under colour-vision deficiencies);
      every new panel, KPI and column has an explanation; provenance on every panel (FR-UI-05, FR-UI-08, NFR-A11Y-01)

## Done

- [x] T-890 Package tests and typecheck, lint, depcruise, hygiene, prettier
- [x] T-892 Rebased on feature 003 (range presets, sliced reads): the concurrency profile and environment load take
      batches, HM-017 reads the compact tries of the range, the comparisons use the global `Range`
- [ ] T-891 Browser validation; code review
