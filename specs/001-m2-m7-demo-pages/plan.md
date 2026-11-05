# Plan 001: demo-mode pages for M2–M7

## Shape of every slice

`packages/domain` pure computation → `packages/application` use case (reads ports) → `packages/contracts/openapi.yaml`
endpoint (regenerate with `pnpm gen`) → `apps/server/src/routes/<slice>.ts` thin handler → `apps/web/src/pages/<Slice>Page.tsx`
(lazy-loaded route) with an (i) explanation on every panel and a provenance footer.

## Demo world: a scheduler simulator (FR-EMU-01, FR-EMU-03)

`packages/adapters/fakes/src/simulator.ts` replaces the naive synthesiser for the demo workspace. It is a discrete-time
simulation (5 s ticks, seeded, anchored to a fake "now") of one Airflow 2.11 environment:

- DAG runs at their schedule; tasks in layers (fan-out for heavy DAGs); a task is ready when its layer's upstream is done.
- Scheduler loop per tick, mirroring `_executable_task_instances_to_queued`: candidates ordered by `priority_weight` desc,
  then logical date; batch capped by `min(max_tis_per_query, parallelism − running − queued)`; per candidate: pool open
  slots ≥ `pool_slots`, DAG running + queued < `max_active_tasks`.
- Executor: queued tries start after a short pickup delay when a worker slot is free (`workers × worker_concurrency`).
- Autoscaler: target = clamp(⌈(running + queued) ÷ concurrency⌉, min, max) every 30 s; new workers ready after a
  2–3 min start-up; scale-down after 10 idle minutes.
- Outputs: task tries (with `readyAt`, `queuedAt`, `startAt`, `endAt`, operator), a `LiveSnapshot` every 30 s (what
  M1's `af.live` collector will capture), a `WorkerSample` per minute, platform-health inputs, and **ground truth**: the
  binding reason for every waiting task instance at every snapshot (tests only).
- Scenarios (§20.6): `acme-prod` (200 DAGs; workers at max at round hours, a 4-slot `external_api` pool that starves,
  a fan-out DAG capped by `max_active_tasks`, a poke-mode sensor, low CPU per slot); `acme-test` (80 DAGs; parallelism
  below worker capacity); `acme-dev` (40 DAGs; quiet).

## Data model (`packages/domain/src/model.ts`)

`EnvironmentConfig`, `PoolConfig`, `DagMeta`, `LiveSnapshot` (scheduled and queued task instances with `since`, pool
states, per-DAG active counts, executor running/queued, workers current/target), `WorkerSample`, `PlatformHealth`.
`StoredTaskTry` gains `readyAt` and `operator` (DuckDB migration 0003). New port `EnvironmentModelSource` in
`packages/ports` serves config, DAG metadata, snapshots, worker samples and platform health; the demo implements it in
memory; M1 fills it from collectors.

## Contract (all `GET`, read-only)

| Endpoint                                      | Schema        | Page             |
| --------------------------------------------- | ------------- | ---------------- |
| `/api/v1/environments/{env_id}/dags`          | `DagLeague`   | DAG league table |
| `/api/v1/environments/{env_id}/dags/{dag_id}` | `DagDetail`   | DAG detail       |
| `/api/v1/environments/{env_id}/bottlenecks`   | `Bottlenecks` | Bottlenecks      |
| `/api/v1/environments/{env_id}/findings`      | `Findings`    | Advisor          |
| `/api/v1/alerts`                              | `Alerts`      | Alerts           |
| `/api/v1/fleet`                               | `Fleet`       | Fleet            |

The wiki is static content bundled with the UI (no API until search, FR-WIKI-08).

## UI decisions

- Routing: a dependency-free History-API router (`apps/web/src/router.ts`), `?env=` carries the environment; pages are
  `React.lazy` chunks (NFR-PERF-05).
- Charts: small hand-written SVG components on the design tokens (stacked bars, treemap, Gantt, sparkline), each with
  an accessible description and a table view. No chart library: keeps the shell within the 350 KB gzip budget.
- League table: client-side sort and filter over all rows, virtualised with `@tanstack/react-virtual`; TanStack Table is
  not needed yet.

## Constitution check

Read-only (no new outbound calls; all endpoints are `GET` on DCAM's own data) · domain stays pure · test first with
requirement IDs · no real identifiers (fictitious `acme-*` only) · facts from the spec, ⚠️ where it is open.

## Work split

1. Foundations (sequential): model, ports, migration, simulator, demo workspace, full contract, router, shell, shared UI.
2. In parallel: league table + DAG detail · bottlenecks (HM-006 classifier validated against simulator ground truth) · wiki.
3. In parallel: advisor rules · alert evaluation (both read shared environment signals).
4. Fleet (needs findings and alerts), cross-links, browser validation, review.
