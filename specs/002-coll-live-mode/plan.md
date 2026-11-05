# Plan 002: live mode

## Shape

```text
dcam.config.yaml ─▶ @dcam/config-file ─▶ WorkspaceConfig (ports)
                                              │
apps/server (composition root) ───────────────┼─▶ per environment:
  http-guard client (proxy, CA, timeouts, footprint hook)
    ├─▶ @dcam/gcp: gcloud ADC token source, ComposerApi, MonitoringApi
    └─▶ @dcam/airflow-v1: AirflowApi (bearer token, or basic auth on loopback for the emulator)
  @dcam/application collection engine
    ├─ scheduler: cadence per profile with jitter, priorities, single flight
    ├─ budgets: token bucket per (environment, API), hard maxima; circuit breaker; backoff with full jitter
    ├─ collectors: composer.config, af.inventory, af.live, af.facts, mon.core
    └─ status: per collector and API (FR-COLL-11, HM-030)  ─▶ GET /api/v1/collection
  @dcam/duckdb-store: CollectionStore (task tries, snapshots, samples, config, DAGs, health, watermarks)
    └─ is the live workspace's TaskInstanceStore and EnvironmentModelSource: every page works unchanged
```

## Packages touched

| Package                               | Change                                                                                                                                                                                                                                                                            |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/ports`                      | `WorkspaceConfig`, `ReadOnlyHttp`, `AccessTokenSource`, `SourceError`, `AirflowApi`, `ComposerApi`, `MonitoringApi`, `CollectionStore`, `Sleeper`                                                                                                                                 |
| `packages/contracts`                  | `GET /api/v1/collection` (`Collection`, `CollectorStatus`, `ApiFootprint`); `Meta.setup` (setup mode)                                                                                                                                                                             |
| `packages/adapters/config-file` (new) | Zod schema of the M1 subset of §17.2, YAML loading, precedence, `~` expansion, issues with path and fix hint, generated JSON Schema                                                                                                                                               |
| `packages/adapters/http-guard`        | Proxy and CA transport (undici `EnvHttpProxyAgent`), per-request timeout, response hook for the footprint. The allowlist is unchanged                                                                                                                                             |
| `packages/adapters/gcp` (new)         | ADC token source over `gcloud auth application-default print-access-token` (fixed arguments, no shell, memory only); Composer `environments.get`; Monitoring `timeSeries.list` with paging; Google error classification (401, 403, quota project, VPC-SC, API disabled, 429, 5xx) |
| `packages/adapters/airflow-v1` (new)  | Airflow REST API v1 client: version, health, DAGs, pools, import errors, task instances, privilege probe; Zod at the boundary                                                                                                                                                     |
| `packages/adapters/duckdb-store`      | Migration 0004 (snapshots, worker samples, environment state, ready times, watermarks); `CollectionStore`; backup before migrating a file store; data directory `0700`                                                                                                            |
| `packages/application`                | `collection/`: engine, budgets, breaker, collectors, mapping to domain types, status → `Collection`                                                                                                                                                                               |
| `apps/server`                         | `createLiveWorkspace`, setup-mode workspace, `/api/v1/collection`, `Meta.setup`                                                                                                                                                                                                   |
| `apps/web`                            | DCAM health page, setup page, live indicator, environment header badge when a collector fails                                                                                                                                                                                     |
| `packages/cli`                        | `dcam start [--config]` live mode; `dcam doctor [--config] [--env] [--json]`                                                                                                                                                                                                      |
| `tools/emulator` (new)                | Airflow 2.11.1 Docker Compose, `acme_*` DAGs, pools, `dcam.config.emulator.yaml`, scripts                                                                                                                                                                                         |

## Constitution check

- **Read-only.** No new allowlist entries. Tokens come from `gcloud` with fixed arguments and no shell, so DCAM
  never handles refresh tokens and needs no `oauth2.googleapis.com` POST. Basic authentication is refused for
  non-loopback Airflow URLs.
- **No network outside adapters.** Adapters receive `ReadOnlyHttp` and `AccessTokenSource` through ports
  (dependency rule 3: adapters never import each other); only `apps/server` and the CLI wire them.
- **Test first.** Every task below starts with a failing test that names its requirement ID.
- **Public repository.** Fixtures are hand-written from the official REST references with `acme-*` names, or
  recorded from the local emulator (fictitious DAGs). Nothing is recorded from a real environment.
- **Facts.** Platform facts the code relies on cite their source; unverified ones are marked ⚠️ VERIFY and listed
  for the user's spike (§22.5).

## ADRs

- ADR-0013 (proposed): credentials through `gcloud` instead of a Google auth library (no refresh-token handling,
  no token endpoint on the allowlist; costs a child process per refresh).
- ADR-0014 already names `timeSeries.list` as the default Monitoring path.

## Testing

- Adapters: fixture responses through a fake transport; error classification table tests.
- http-guard: a loopback HTTP proxy in the test proves requests go through it; `NO_PROXY` bypass.
- Engine: fake clock and sleeper; budgets never exceeded (NFR-OBS-05); breaker opens on 429/5xx and honours
  `Retry-After`; watermarks survive a restart without duplicates (FR-COLL-03).
- Emulator: `pnpm emulator:test` runs the Airflow collectors against Airflow 2.11.1 (opt-in, needs Docker).
- Server and web: contract conformance for `/api/v1/collection` and `Meta.setup`; page tests for health and setup.
