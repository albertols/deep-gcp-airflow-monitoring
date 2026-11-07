# Tasks 008: DAG concurrency, impact and comparisons

Test tasks come before the code they cover.

## Domain

- [ ] T-800 Test + code: shared HM-005 per DAG; the advisor uses it; REC-DAG-01 predicate exported (HM-005,
      REC-DAG-01)
- [ ] T-801 Test + code: concurrency profile per bucket and pool, gaps as null (FR-DAGD-05, HM-011)
- [ ] T-802 Test + code: HM-017 for one DAG equals the environment-wide item; statuses (FR-DAGD-06, HM-017)
- [ ] T-803 Test + code: share of executor load and slots per bucket; environment load totals (FR-DAGD-06, HM-003)
- [ ] T-804 Test + code: run comparison with critical-path contributions (FR-DAGD-09, HM-007)
- [ ] T-805 Test + code: hourly UTC load profile and shared duration bins (FR-DAGD-08)

## Contract, application, store

- [ ] T-810 Contract: additive DagDetail fields, comparison schemas and paths; `pnpm gen`
- [ ] T-811 Test + code: `getDagDetail` concurrency and impact; one HM-005 number; finding link (FR-DAGD-05/06)
- [ ] T-812 Test + code: `getDagComparison` (FR-DAGD-08) and `getRunComparison` (FR-DAGD-09)
- [ ] T-813 Test + code: optional port `environmentLoad`; DuckDB aggregate equals the domain function (NFR-PERF)
- [ ] T-814 Test: DAG detail 7-day computations < 1 s; 4-DAG compare over 7 days < 2 s (NFR-PERF)

## Server

- [ ] T-820 Test + code: routes, conformance on demo data, demo stories, problems (FR-DAGD-05/06/08/09)

## Done

- [ ] T-890 Package tests and typecheck, lint, depcruise, hygiene, prettier
- [ ] T-891 Web panels (later task); browser validation; code review
