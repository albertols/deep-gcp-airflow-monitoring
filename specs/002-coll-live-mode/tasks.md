# Tasks 002: live mode

Test tasks come before the code they cover. `[P]` = can run in parallel.

## Foundations

- [x] T-100 Ports (`WorkspaceConfig`, `ReadOnlyHttp`, `AccessTokenSource`, `SourceError`, `AirflowApi`,
      `ComposerApi`, `MonitoringApi`, `CollectionStore`, `Sleeper`) and the contract (`/api/v1/collection`,
      `Meta.setup`)

## Adapters

- [x] T-110 [P] Test + code: config-file adapter (FR-SETUP-02, FR-SETUP-05): schema, defaults, precedence,
      `DCAM_DATA_DIR`, issues with path and fix hint, hard budget maxima (§7.11), generated JSON Schema
- [x] T-111 [P] Test + code: http-guard proxy and CA transport, timeouts, response hook (FR-AUTH-07, HM-030)
- [x] T-112 [P] Test + code: gcp adapter: gcloud ADC token source (FR-AUTH-01), quota project header
      (FR-AUTH-04), Composer `environments.get`, Monitoring `timeSeries.list` with paging, error
      classification incl. VPC-SC (FR-AUTH-06)
- [x] T-113 [P] Test + code: airflow-v1 adapter (FR-COLL-08 v1): version, health, DAGs, pools, import errors,
      task instances, privilege probe; basic auth on loopback only
- [x] T-114 [P] Test + code: duckdb-store `CollectionStore`, migration 0004, backup before migration, data
      directory `0700` (FR-STORE-01, FR-STORE-06, FR-COLL-03)
- [x] T-115 [P] Emulator: Airflow 2.11.1 Compose, `acme_*` DAGs, pools, `dcam.config.emulator.yaml`, scripts;
      the airflow-v1 adapter tested against it (FR-EMU-02)

## Collection

- [x] T-120 [P] Test + code: engine: collector manifests (FR-COLL-01), scheduler with jitter and priorities
      (FR-COLL-02), budgets with hard maxima, breaker, backoff, `Retry-After`, reduced fidelity (FR-COLL-06),
      status (FR-COLL-11)
- [x] T-121 [P] Test + code: collectors `composer.config`, `af.inventory`, `af.live`, `af.facts` (watermark
      with overlap, FR-COLL-03), `mon.core` (FR-COLL-07 ingestion delay), mapping to domain types
- [x] T-122 Test + code: status → `Collection` response (FR-SELF-01, HM-030, NFR-OBS-06 series count)

## Surface

- [x] T-130 [P] Test + code: server `/api/v1/collection`, `Meta.setup`; web DCAM health page, setup page,
      live indicator, environment header badge (FR-COLL-11, FR-SETUP-02, FR-SELF-01)
- [x] T-131 Test + code: `createLiveWorkspace`; `dcam start` live mode with `--config` (FR-SETUP-02)
- [x] T-132 Test + code: `dcam doctor` Google checks (FR-AUTH-05, FR-AUTH-07)

## Done

- [x] T-190 Live mode end to end against the emulator; browser validation; code review; `pnpm check`; CI green;
      README "Run against your environment" and CLAUDE.md updated. Live against the emulator since 2026-11-07:
      every collector OK within the request budget; after the emulator's web server was killed for memory, DCAM
      recovered by itself twice; a data folder from an earlier build upgraded in place. Browser check of the
      context bar in live mode and of the M2/M3 pages in demo mode; code review of the merged web work, its
      findings fixed. The 24-hour budget run of the M1 exit criterion was interrupted by the emulator crashes.
