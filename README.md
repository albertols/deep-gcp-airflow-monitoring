# deep-gcp-airflow-monitoring (DCAM)

**A local-first, read-only observability and advisory cockpit for Google Cloud's Managed Service for
Apache Airflow (formerly Cloud Composer).**

DCAM answers the questions the default dashboards leave open, for environments with thousands of DAGs:

- **Which DAGs consume the environment?** A DAG league table ranked by executor slot-seconds, with the
  Pareto view ("23 of 2,000 DAGs use 80 % of capacity").
- **Why is work waiting?** Waiting time attributed to the limit that actually binds: pools,
  `parallelism`, `max_active_tasks`, worker slots at `max_count`, autoscaling lag, the triggerer.
- **What should we tune next?** Evidence-backed findings with copy-paste snippets that you review and apply.

It runs on your laptop, reads only public Google Cloud and Airflow APIs with your own identity, never
changes anything, and keeps all data on your machine.

> **Status: milestone M0 (foundations).** Demo mode works today: the app shell, the capacity overview,
> the read-only client, the analytics core and the development harness. Connecting to real environments
> arrives in M1, the full DAG league table in M2 (first release) and bottleneck analysis in M3.
> See the [roadmap](docs/spec/dcam-spec.md#222-milestone-overview).

## Quickstart (demo mode)

Requirements: Node.js 22.12 or later, and pnpm 11 through Corepack.

```bash
git clone https://github.com/albertols/deep-gcp-airflow-monitoring.git
cd deep-gcp-airflow-monitoring
corepack enable          # if "corepack" is missing: npm i -g corepack && corepack enable
pnpm i
pnpm dcam --demo         # opens http://127.0.0.1:8787 with synthetic data for the fictitious "acme" org
```

`pnpm dcam doctor` checks the prerequisites.

## Run against your environment

_Arrives in M1._ The path will be (full guide in [spec §17.6](docs/spec/dcam-spec.md#176-run-against-your-environment)):

1. Sign in with your own credentials: `gcloud auth application-default login`, and set a quota project.
2. Make sure your identity has `roles/composer.viewer` and `roles/monitoring.viewer`, and the Airflow
   `Viewer` role (Composer 3 registers new API users as `Op` by default; `Viewer` is enough).
3. Behind a corporate proxy, export `HTTPS_PROXY` (and `NODE_EXTRA_CA_CERTS` if TLS is inspected).
4. `cp dcam.config.example.yaml dcam.config.yaml`, set your project, location and environment. This file
   is git-ignored; never commit it.
5. `pnpm dcam doctor`, then `pnpm dcam`.

Everything DCAM collects stays in `~/.dcam/data/` on your machine.

## Safety by design

- **Read-only by construction.** Every call to a monitored system goes through one guarded client with a
  default-deny allowlist: Airflow is `GET`-only and never reads configuration, connections, variables or
  XCom; redirects are never followed; encoded path tricks are rejected ([ADR-0006](docs/adr/0006-guarded-read-only-outbound-client.md)).
- **Do no harm.** Request and time-series budgets per API; DCAM lowers its own fidelity before it adds load
  or Cloud Monitoring cost.
- **Local and private.** Binds to 127.0.0.1 with Host-header checks and a strict Content Security Policy.
  No telemetry.

## Development

```bash
pnpm check               # format, lint, typecheck, architecture boundaries, tests, hygiene scan
pnpm dev                 # server + UI with hot reload (UI on http://127.0.0.1:5173)
pnpm --filter @dcam/domain test
git config core.hooksPath .githooks   # hygiene pre-commit hook
```

| Path                             | What it is                                                       |
| -------------------------------- | ---------------------------------------------------------------- |
| `packages/domain`                | Pure analytics core (occupancy sweep: slot-seconds, concurrency) |
| `packages/adapters/http-guard`   | The only network path to monitored systems                       |
| `packages/adapters/duckdb-store` | Embedded DuckDB store (2.0 LTS)                                  |
| `packages/contracts`             | OpenAPI 3.1 contract, generated types and client                 |
| `apps/server`, `apps/web`        | Fastify API on loopback, React + MUI UI                          |
| `docs/spec/dcam-spec.md`         | Product and technical specification (v2)                         |
| `docs/adr/`                      | Architecture decision records (MADR 4.0)                         |
| `.claude/`                       | Claude Code harness: guard hooks, subagents, commands, skills    |

DCAM is built spec-first and test-first, largely with Claude Code under human review. Read
[CONTRIBUTING.md](CONTRIBUTING.md) and [CLAUDE.md](CLAUDE.md) before your first change.

![DCAM system context](docs/diagrams/dcam-context.drawio.svg)

## Licence and trademarks

Apache License 2.0. DCAM is an independent project, not affiliated with Google LLC or the Apache Software
Foundation; see [NOTICE](NOTICE).
