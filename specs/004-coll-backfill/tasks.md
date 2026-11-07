# Tasks 004: backfill on first add

Test tasks come before the code they cover.

## Budgets

- [ ] T-400 Test + code: background work gets a guaranteed share and spare capacity; live and standard first
      (FR-COLL-02, FR-COLL-06)
- [ ] T-401 Test + code: Monitoring and Composer budgets per profile (§7.11); hard maxima of the config schema and
      the engine agree (FR-COLL-06)

## Configuration and storage

- [ ] T-410 Test + code: `environments[].backfill` in the config schema, loader, JSON Schema and example
      (FR-COLL-04, FR-SETUP-02)
- [ ] T-411 Test + code: `CollectionStore.backfill` / `commitBackfill`; store contract; DuckDB migration 0006
      (FR-COLL-03, FR-STORE-06)

## Collectors

- [ ] T-420 Refactor (green): window reader extracted from `af.facts`, forward and backward (FR-COLL-06)
- [ ] T-421 Test + code: `af.backfill` newest first, waiting for `af.facts`, resume, boundary, days changed
      (FR-COLL-04, FR-COLL-03)
- [ ] T-422 Test + code: `mon.backfill` one-day chunks at 60 s, partial chunks, series counted (FR-COLL-04,
      NFR-OBS-06)

## Status and surface

- [ ] T-430 Test + code: progress and ETA in the engine status and the contract (FR-COLL-04, FR-SELF-01)
- [ ] T-431 Test: 7 days at 20,000 tries a day complete on the standard profile within budget, ETA believable
      (FR-COLL-04, NFR-OBS-05)
- [ ] T-432 Test + code: health page backfill panel; history note on the DAG league and bottlenecks pages
      (FR-COLL-04, FR-UI-05, FR-UI-08, NFR-DATA-03)

## Done

- [ ] T-490 Package tests and typecheck, lint, depcruise, hygiene, prettier
