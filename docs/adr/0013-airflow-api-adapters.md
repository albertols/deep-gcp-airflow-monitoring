---
status: proposed
date: 2026-11-07
decision-makers: DCAM maintainers
consulted: Claude Code (documentation subagent)
informed: contributors
---

# Airflow API adapters: one adapter per REST API generation behind one port, chosen by the detected version

## Context and Problem Statement

Airflow 2 serves the REST API v1 at `{airflowUri}/api/v1`, and Airflow 3 serves the API v2 at
`{airflowUri}/api/v2` (spec §7.5, Appendix B.1). The generations differ in paths (`/health` in v1,
`/monitor/health` in v2), fields (v2 adds `run_after` and `scheduled_when`), paging (no `order_by` on v1 task
instance lists; `order_by` and `cursor` in v2) and semantics (`max_active_tasks` applies per DAG on Airflow 2 and
per DAG run on Airflow 3). The full table is in §7.5, "Version differences handled by the adapters". The first target runs Airflow 2.11.1 (M1); Airflow 3 follows in M4 (FR-COLL-08). How does DCAM read
both without spreading version checks through collectors and analytics?

## Decision Drivers

- Collectors and analytics read one port and capability flags, never raw version strings (§7.1 rule 2)
- An Airflow 3 environment never gets API v1 calls it cannot answer, and the user is told why (FR-COLL-08)
- `GET` only, page size at most 100, sensitive fields dropped at the boundary (§7.1 rule 4, §18.2, Appendix B.1)
- Each adapter is testable against fixtures and the local Airflow 2.11.1 emulator (FR-EMU-02)

## Considered Options

- One adapter package per API generation behind one `AirflowApi` port, selected by the detected version, with
  capability flags for the differences the port cannot hide
- One adapter with version branches inside
- One adapter generated from each Airflow OpenAPI document, used directly by collectors

## Decision Outcome

Chosen option: "One adapter per API generation behind one port", because each adapter stays a plain mapping of
one documented API, and the port is where the generations meet.

What the code does today (M1, Airflow 2 only):

- **The port.** `AirflowApi` in `packages/ports/src/sources.ts` has `version`, `health`, `dags`, `pools`,
  `importErrorCount`, `taskInstances` and the doctor's `canReadProviders`. Times are epoch milliseconds, pages
  carry the API's total count (`total_entries`), and failures are `SourceError`s.
- **The v1 adapter.** `@dcam/airflow-v1` (`packages/adapters/airflow-v1/src/client.ts`) sends `GET` requests
  under `{baseUrl}/api/v1` through the guarded client (ADR-0006). It uses a Google bearer token for Composer
  environments, and basic authentication only for loopback URLs such as the emulator (FR-EMU-02). It refuses a
  page size above 100 before sending anything and has a 20 s timeout per request. It drops a rejected token so
  the next call fetches a new one (ADR-0016).
- **Boundary schemas.** `packages/adapters/airflow-v1/src/wire.ts` holds Zod schemas of the responses DCAM
  reads, written from `airflow/api_connexion/openapi/v1.yaml` at tag 2.11.1. They drop `rendered_fields`,
  `sla_miss`, `trigger`, `triggerer_job` and `note` from task instances (§7.1 rule 4). The schemas are written
  by hand, not generated (see Consequences).
- **Wiring.** `apps/server/src/live/environment-clients.ts` builds the v1 adapter for every environment, at the
  base URL that `composer.config` reads from `config.airflowUri` or that a self-managed source configures.
- **Version detection.** For Composer, `composer.config` reads the image version from `environments.get`
  (for example `composer-3-airflow-2.11.1-build.22`) and parses the Composer generation and Airflow version
  (`parseImageVersion` in `packages/application/src/collection/collectors/mapping.ts`). Airflow collectors wait
  for the base URL that the same cycle sets, so the image version is known before any of them runs. Then
  `af.inventory` reads `GET /api/v1/version` at connect and daily, and that value wins. `assertAirflow2` (in
  `mapping.ts`) makes the collectors fail with an `unsupported` error and a fix hint once the version is 3 or
  later. `af.live` and `af.facts` check before they send anything; `af.inventory` checks after its
  `GET /version`. Composer 1 is refused too. The doctor fails the "Composer generation and Airflow version" check
  for Airflow 3 and warns below 2.10 (`packages/application/src/doctor/environment-checks.ts`).
- **The allowlist** in `packages/adapters/http-guard/src/allowlist.ts` already has the v2 read entries, including
  `/api/v2/monitor/health`, so the v2 adapter needs no allowlist change for the same endpoints.

### Consequences

- Good, because collectors depend only on the port. `af.live` and `af.facts` do not know which API generation
  they read, and the v2 adapter adds a package rather than branches.
- Good, because an Airflow 3 Composer environment is reported as unsupported, with a fix hint, from the image
  version alone: `af.live` and `af.facts` send it nothing.
- Good, because the schemas keep only what the port needs, and recorded emulator responses check them against
  real 2.11.1 output (`packages/adapters/airflow-v1/test/recorded.test.ts`).
- Bad, because `af.inventory` still sends `GET /api/v1/version` once a day even when the image already names
  Airflow 3, and on every retry if that call fails. What Airflow 3 answers there is ⚠️ VERIFY. Skipping that call
  when the image names Airflow 3 is a follow-up.
- Bad, because hand-written schemas can drift from the OpenAPI document. Appendix B.1 and §11.5 say "generated
  clients". The recorded fixtures and the emulator test are the guard against drift; a generated client stays an
  option for v2.
- Bad, because the port is shaped by API v1 today (for example `importErrorCount`, offset paging). The v2 adapter
  may need port changes, such as an optional cursor.
- Neutral: the image version is parsed twice, with different patterns. The collector's `parseImageVersion` needs
  a full `x.y.z` Airflow version. The doctor's pattern also accepts aliases such as `composer-3-airflow-2`. One
  shared parser is a follow-up.

Not implemented yet:

- **The v2 adapter** (`@dcam/airflow-v2`, M4) and adapter selection by version. Today every environment gets the
  v1 adapter, and Airflow 3 is refused.
- **The capability map** (§7.1 rule 2). Only `airflowVersion` and `imageVersion` are shared between collectors
  (`SharedEnvironmentState` in `packages/application/src/collection/types.ts`). Flags such as `scheduled_when`
  availability, `cursor` paging and `max_active_tasks` scope are designed in §7.5 but not built.
- **Selection for a self-managed Airflow 3.** It has no image version. The proposal is to read
  `GET /api/v2/version` and fall back to `/api/v1/version`. ⚠️ VERIFY what Composer's and upstream Airflow 3
  builds answer on `/api/v1` before relying on the fallback order
  ([Upgrading to Airflow 3](https://airflow.apache.org/docs/apache-airflow/stable/installation/upgrading_to_airflow3.html)).
- **The other v1 endpoints** of Appendix B.2 (DAG runs, details, tasks, tries, event logs, DAG warnings). They
  arrive with the signals that need them.

### Confirmation

- `packages/adapters/airflow-v1/test/airflow-v1.test.ts`: FR-COLL-08 cases for every method (`GET` under
  `/api/v1`, page limits, dropped fields, error classification) and FR-EMU-02 basic authentication on loopback
  only.
- `packages/adapters/airflow-v1/test/emulator.integration.test.ts`: the adapter against Airflow 2.11.1
  (`pnpm emulator:test`, opt-in, needs Docker).
- `packages/application/test/collection/`: collectors refuse Airflow 3 once the version is known.
- dependency-cruiser rule `adapters-do-not-use-application-or-each-other` (`.dependency-cruiser.cjs`): a v2
  adapter cannot reuse v1 code by importing it.

## Pros and Cons of the Options

### One adapter per API generation behind one port

- Good, because each adapter maps one OpenAPI document, so a reviewer checks it against one source.
- Good, because the v1 adapter keeps working unchanged while v2 is built and tested.
- Bad, because the shared parts (authentication, error mapping, time parsing) are duplicated: one adapter may
  not import another (dependency rule 3), so sharing them needs a package outside `packages/adapters/`.

### One adapter with version branches

- Good, because shared code lives in one place.
- Bad, because every method grows `if v2` branches, and a change for one generation risks the other.
- Bad, because tests must cover each method twice in one package, and the boundary schemas mix two documents.

### Generated clients used directly by collectors

- Good, because types follow the OpenAPI documents exactly.
- Bad, because collectors would see two different wire shapes and need version checks, which is what the port
  exists to prevent.
- Bad, because generated types keep every field, including the ones DCAM must drop at the boundary.

## More Information

- Spec §7.1 (rules 2 and 4), §7.5 (Airflow REST API), Appendix B (endpoints and paging), §22.5 (VC-10, VC-11,
  VC-12 and VC-13 affect the v2 adapter).
- Composer image versions: https://docs.cloud.google.com/composer/docs/composer-versions
- Airflow 2.11.1 REST API v1: `airflow/api_connexion/openapi/v1.yaml` at
  https://github.com/apache/airflow/tree/2.11.1
