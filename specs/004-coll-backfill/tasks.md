# Tasks 004: backfill on first add

Test tasks come before the code they cover.

## Budgets

- [x] T-400 Test + code: background work gets a guaranteed share and spare capacity; live and standard first
      (FR-COLL-02, FR-COLL-06)
- [x] T-401 Test + code: Monitoring and Composer budgets per profile (§7.11); hard maxima of the config schema and
      the engine agree (FR-COLL-06)

## Configuration and storage

- [x] T-410 Test + code: `environments[].backfill` in the config schema, loader, JSON Schema and example
      (FR-COLL-04, FR-SETUP-02)
- [x] T-411 Test + code: `CollectionStore.backfill` / `commitBackfill`; store contract; DuckDB migration 0006
      (FR-COLL-03, FR-STORE-06)

## Collectors

- [x] T-420 Test + code: a window reader with `af.facts`' rules, forward and backward, with the corrected page-cap
      rule (FR-COLL-06); `af.facts` moves onto it after its own cap fix lands
- [x] T-423 Follow-up: `af.facts` reads through `fact-windows.ts` once the parallel cap fix is merged
- [x] T-421 Test + code: `af.backfill` newest first, waiting for `af.facts`, resume, boundary, days changed
      (FR-COLL-04, FR-COLL-03)
- [x] T-422 Test + code: `mon.backfill` one-day chunks at 60 s, partial chunks, series counted (FR-COLL-04,
      NFR-OBS-06)

## Status and surface

- [x] T-430 Test + code: progress and ETA in the engine status and the contract (FR-COLL-04, FR-SELF-01)
- [x] T-431 Test: 7 days at 20,000 tries a day complete on the standard profile within budget, ETA believable
      (FR-COLL-04, NFR-OBS-05)
- [x] T-432 Test + code: health page backfill panel; history note on the DAG league and bottlenecks pages
      (FR-COLL-04, FR-UI-05, FR-UI-08, NFR-DATA-03)

## Done

- [ ] T-491 Browser validation of the health page panel and the history note against a live workspace (demo mode
      has no collectors); code review
- [x] T-490 Package tests and typecheck, lint, depcruise, hygiene, prettier
