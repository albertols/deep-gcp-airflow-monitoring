# Feature 002: live mode (connect and collect)

- **Epic / milestone:** SETUP, AUTH, COLL, STORE, SELF, EMU · the core of M1 (spec §22.2)
- **Requirements:** FR-SETUP-02, FR-SETUP-05, FR-AUTH-01, FR-AUTH-02 (terminal path), FR-AUTH-04, FR-AUTH-05,
  FR-AUTH-06 (classification), FR-AUTH-07, FR-COLL-01, FR-COLL-02, FR-COLL-03, FR-COLL-06, FR-COLL-07,
  FR-COLL-08 (v1), FR-COLL-09, FR-COLL-11, FR-STORE-01, FR-STORE-06, FR-SELF-01, FR-EMU-02, NFR-OBS-06 (series
  budget, counted), HM-030 (observer footprint)
- **Status:** in progress

## Intent

`pnpm dcam` (without `--demo`) runs DCAM against the user's own environments, listed in `dcam.config.yaml`.
Collectors read the Airflow REST API v1, the Composer API and Cloud Monitoring through the guarded read-only
client. They fill the same ports the demo fills (`TaskInstanceStore`, `EnvironmentModelSource`), so every page
that works in demo mode works on real data without changes. Collected data persists in DuckDB under the data
directory. A DCAM health page shows every collector's state and DCAM's own footprint. `pnpm dcam doctor` checks
credentials, quota project, proxy, Composer and Airflow access, and the Airflow role, before anything runs.

The first target is the user's Composer 3 environment with Airflow 2.11.1 and about 2,000 DAGs, behind a
corporate proxy, with the user's own Application Default Credentials. A local Airflow 2.11.1 (the emulator)
is the test target for the Airflow side; Google APIs are tested against fixtures shaped from the official REST
references, because this repository never calls a real project.

## User stories

- As a platform engineer, I want to point DCAM at my environment with one file and see the league table and
  bottlenecks fill as data arrives (FR-SETUP-02, FR-COLL-01..03).
- As a platform engineer behind a corporate proxy, I want every Google and Airflow call to go through the proxy
  and the doctor to prove it works (FR-AUTH-07, FR-AUTH-05).
- As the owner of a production environment, I want DCAM to stay inside a small request budget and back off when
  the environment is in trouble, so it is never the cause of an incident (FR-COLL-06, §7.11).
- As a user, I want to see what DCAM collects, how fresh it is, what fails and how many requests it makes
  (FR-COLL-11, FR-SELF-01, HM-030).
- As a contributor, I want a local Airflow 2.11.1 to run the collectors against, without any Google Cloud access
  (FR-EMU-02).

## Requirements extracted from docs/spec/dcam-spec.md (line numbers refer to that file)

### Setup and configuration (§9.1 L1565, §17 L3396)

- **FR-SETUP-02**: load `dcam.config.yaml` (override with `--config` or `DCAM_CONFIG`), validated by a schema.
  If it is invalid, then collectors do not start, each error is listed with its path and a fix hint, and the UI
  stays available in setup mode. Precedence (§17.1): defaults < file < environment variables < flags.
- **FR-SETUP-05**: profiles `live`, `standard`, `eco`, `off` per environment; tier defaults (prod `standard`,
  others `eco`). Cadences in seconds (§17.2 `profiles`).
- **§17.3**: `DCAM_CONFIG`, `DCAM_DATA_DIR`, `DCAM_PORT`, `DCAM_DEMO`, `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY`,
  `NODE_EXTRA_CA_CERTS`, `GOOGLE_APPLICATION_CREDENTIALS`.
- **§17.5**: the data directory holds `dcam.duckdb` and `backups/`; it is created owner-only (`0700`).

### Authentication and network (§9.2 L1578, §18.3)

- **FR-AUTH-01**: Application Default Credentials; tokens in memory only, refreshed before expiry.
- **FR-AUTH-02** (terminal path only in this feature): without valid ADC, the doctor and the setup page show
  `gcloud auth application-default login`. The GUI button is a follow-up.
- **FR-AUTH-04**: `x-goog-user-project` is the environment's project unless `auth.quotaProjectId` is set; a
  missing or unusable quota project is explained with `gcloud auth application-default set-quota-project`.
- **FR-AUTH-05**: doctor checks with pass, warn or fail, evidence, a copyable fix and a docs link, within 30 s
  per environment (subset below).
- **FR-AUTH-06**: a VPC Service Controls denial is classified, shows the unique identifier, and is not retried
  until the user re-runs the check.
- **FR-AUTH-07**: `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` and custom CA bundles (`NODE_EXTRA_CA_CERTS` or
  `network.caBundlePath`) apply to Google API and Airflow calls; the doctor verifies connectivity through it.
- **§18.3**: Airflow calls go to `airflowUri` with a Google OAuth 2.0 access token; `Viewer` is sufficient; the
  doctor's privilege probe `GET /providers?limit=1` warns when the identity is `Op` or higher.

### Collection (§9.3 L1591, §7.10, §7.11, Appendix A, Appendix B)

- **FR-COLL-01**: each collector declares source, cadence per profile, budget cost and output; registration
  fails without a budget or an output.
- **FR-COLL-02**: one scheduler with jitter and priorities (interactive > live > standard > background).
- **FR-COLL-03**: watermarks persisted, an overlap window for late updates, idempotent upserts; a restart resumes
  without duplicates.
- **FR-COLL-06**: token buckets per (environment, API) with the hard maxima of §7.11, circuit breakers on 429,
  5xx and timeouts, exponential backoff with full jitter, `Retry-After`; an exhausted budget lowers fidelity and
  shows "reduced fidelity" instead of exceeding the budget.
- **FR-COLL-07**: Monitoring windows end at `now − ingestion delay`; trailing windows are re-read.
- **FR-COLL-08 (v1)** / **FR-COLL-09**: detect the Airflow version (`GET /version`) and the Composer generation
  from the image version; Airflow 3 environments are reported as unsupported until the v2 adapter (M4).
- **FR-COLL-11**: last success, lag, error rate and budget use per collector and environment; three consecutive
  failures surface in the environment header and on the health page.
- **Collectors in this feature** (§11.6, §7.11 budget arithmetic):
  - `composer.config`: Composer `environments.get` (image, `airflowUri`, overrides, worker min/max, schedulers).
  - `af.inventory`: `/version`, `/dags` (paged), `/importErrors`; trickled.
  - `af.live`: `/pools` and non-terminal task instances (`scheduled`, `queued`, `running`) every live cycle →
    `LiveSnapshot` and first-seen ready times (Airflow 2.11 records no "scheduled" timestamp, HM-001/HM-006).
  - `af.facts`: finished task instances by `updated_at` window with overlap (Appendix B.3) → task tries.
  - `mon.core`: worker count, scale target, executor running and queued, worker CPU and memory → one
    `WorkerSample` per minute; platform-health inputs (HM-028).
- **NFR-OBS-06**: count time series returned per environment per day and show it; enforcement and the monthly
  budget are a follow-up once the spike measures real volumes (VC-03).

### Storage and self-observability (§9.4 L1608, §9.22 L1820)

- **FR-STORE-01**: DuckDB in the data directory with versioned migrations; an older schema is backed up
  (last 3 kept) and migrated automatically.
- **FR-STORE-06**: transactional writes; after a crash the store is consistent and collectors resume from the
  last committed watermark.
- **FR-SELF-01** / **HM-030**: a DCAM health page: per environment and collector the state, last success, lag,
  error rate, requests and budget use; per API the requests, bytes and p95 latency over 1 h and 24 h.

### Emulator (§9.23 L1828, §20)

- **FR-EMU-02**: `tools/emulator/`: the official Airflow 2.11.1 Docker Compose setup (Celery, Postgres, Redis)
  with fictitious `acme_*` DAGs that reproduce a fan-out, a small pool and a poke sensor, and a committed
  `dcam.config.emulator.yaml` on loopback. Basic authentication is accepted only for loopback Airflow URLs,
  with the credentials taken from environment variables named in the file.

### Doctor checks in this feature (FR-AUTH-05 subset)

Node.js version · DuckDB binary · configuration valid · data directory writable, owner-only, free disk ·
`gcloud` present · ADC token obtainable · quota project · proxy variables and CA bundle · per environment:
Composer `environments.get` (IAM, quota project, VPC-SC), Composer generation and Airflow version supported,
Airflow web server `/health` reachable (through the proxy when set), Airflow role probe, Monitoring read probe,
clock skew from the `Date` header. Not in this feature: `testIamPermissions`, API-enabled checks through Service
Usage (not on the allowlist), GUI sign-in.

## Out of scope (follow-ups)

- FR-COLL-04 backfill beyond the first facts window, FR-COLL-05 adaptive cadence, FR-COLL-10 sleep and resume,
  FR-SETUP-03/07 editing environments from the UI, FR-AUTH-03 impersonation (M4), FR-AUTH-08 principal switch.
- Patient mode (§7.11 item 4) beyond halving on breaker trips; Cloud Logging and bucket collectors.
- The reality-check spike (§22.5) itself: it needs the user's environment and is run by the user with the doctor
  and the health page. VC-02, VC-04 and VC-11 stay ⚠️.

## Decisions (calls made where the spec is open)

Recorded as they are made; each is marked ⚠️ in code where it rests on an unverified fact.
