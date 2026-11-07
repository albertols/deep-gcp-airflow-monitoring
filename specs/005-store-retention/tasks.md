# Tasks 005: store retention and disk budget

Test tasks come before the code they cover.

- [x] T-500 Domain: retention classes, defaults and limits; `thinSnapshots`; `snapshotSpans` and the observed
      cadence honour `spanMs` (FR-STORE-02, FR-STORE-07)
- [x] T-501 Config: `retention` with defaults and hard limits, `environments[].retention`, unused classes
      warned, JSON Schema and example regenerated (FR-STORE-02)
- [x] T-502 Ports and store: migration 0007, `deleteExpired` in batches with the horizon, `thinSnapshots`,
      `storageUsage`, `checkpoint`, `snapshotHorizon`, `spanMs` round trip (FR-STORE-02, FR-STORE-06, FR-STORE-07)
- [x] T-503 Application: maintenance job: on start, hourly usage check, 24 h retention, never concurrent,
      budget (warn, thin, delete oldest first, floor), status (FR-STORE-02, FR-STORE-06, FR-STORE-07)
- [x] T-504 Contract and bottlenecks: `Collection.storage`, `CollectionEnvironment.retention`,
      `Bottlenecks.snapshot_retention` (FR-STORE-02, FR-STORE-07)
- [x] T-505 Server: wire the job, stop before the store closes; golden tests (retention exact, thinning within
      tolerance, crash and resume) (FR-STORE-02, FR-STORE-06, FR-STORE-07)
- [x] T-506 Web: DCAM health page local store panel and retention per environment (FR-STORE-07, FR-UI-05,
      FR-UI-07, FR-UI-08)
