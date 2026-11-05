# Tasks 001: demo-mode pages for M2–M7

Test tasks come before the code they cover. `[P]` = can run in parallel.

## Foundations

- [x] T-001 Test + code: History-API router, routes for every page, `?env=` (FR-UI-06)
- [ ] T-002 Test + code: domain model types, percentile with the ≥ 20-sample rule (§8.9)
- [ ] T-003 Test + code: scheduler simulator with ground truth; deterministic per seed (FR-EMU-01/03)
- [ ] T-004 Test + code: migration 0003 (`ready_at`, `operator`); `EnvironmentModelSource` port; demo workspace with
      acme-prod, acme-test, acme-dev
- [ ] T-005 Contract: all six endpoints and schemas in `openapi.yaml`; regenerate; API client methods
- [ ] T-006 Test + code: app shell with enabled navigation, lazy pages, shared panel/KPI/footer components

## Pages

- [ ] T-010 [P] Test + code: DAG league (HM-003, HM-001, HM-015, FR-DAGX-02/03 incl. Gini), use case, route, page with
      virtualised table, presets, treemap (FR-DAGX-04)
- [ ] T-011 [P] Test + code: DAG detail (FR-DAGD-01..04): header limits, runs timeline, run Gantt, per-task table
- [ ] T-020 [P] Test + code: HM-006 classifier on live snapshots; ≥ 90 % agreement with simulator ground truth
      (FR-BOTL-01); attribution series, top contributors, capacity (HM-011/012), sensors (HM-008); route; page
- [ ] T-030 [P] Code + content: wiki pages and runbook RB-01, (i) → wiki links (FR-WIKI-01/05/06/07)
- [ ] T-040 [P] Test + code: advisor rules and priority score (FR-ADV-01/03/04/08); route; page
- [ ] T-050 [P] Test + code: alert rules AL-xx evaluable in demo, state machine, history (FR-ALRT-01/02/06); route; page
- [ ] T-060 Test + code: fleet cards and HM-028 health score (FR-FLEET-01/02); route; page

## Done

- [ ] T-090 Browser validation of every page (UV checklist), code review, `pnpm check`, CI green
