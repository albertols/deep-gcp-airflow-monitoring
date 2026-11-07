# Tasks 007: why is work waiting, in depth

Test tasks come before the code they cover.

## Domain

- [x] T-700 Test + code: top pools per HM-006 reason with shares (FR-BOTL-01, HM-006)
- [x] T-701 Test + code: pool activity per pool and bucket (FR-ENV-08)
- [x] T-702 Test + code: HM-017 noisy neighbours, golden and property tests (HM-017, FR-BOTL-06)
- [x] T-703 Test + code: HM-023 priority bands with observed waits (HM-023)
- [ ] T-704 Test + code: planned and actual start heatmaps, top colliding minutes and schedules (HM-009,
      FR-BOTL-03)

## Application, contract, server

- [ ] T-710 Test + code: additive bottleneck fields and window-based core (FR-BOTL-01, FR-BOTL-06, FR-ENV-08,
      HM-023)
- [ ] T-711 Test: 7 days × 2,000 DAGs × 60 s snapshots under 2 s (NFR-PERF)
- [ ] T-712 Test + code: schedule intelligence use case, `GET …/schedule`, contract (FR-BOTL-03)
- [ ] T-713 Test: the demo shows a noisy neighbour, pool starvation and the minute-0 collision (FR-EMU-01)

## Web

- [ ] T-720 Test + code: top contributors, noisy neighbours, pools and priority panels with states, (i) and
      provenance (FR-BOTL-01, FR-BOTL-06, FR-ENV-08, HM-023, FR-UI-05, FR-UI-07, FR-UI-08)
- [ ] T-721 Test + code: schedule intelligence page, route and navigation (FR-BOTL-03, S-17)

## Blocked

- [ ] T-790 HM-024 catchup and backfill storm risk: blocked on `catchup`, next data interval and DAG runs
      (spec.md "Blocked")
- [ ] T-791 HM-023 starvation ratio: blocked on weights of running tries and a 28-day baseline

## Done

- [ ] T-799 Browser validation against `pnpm dcam --demo`; code review
