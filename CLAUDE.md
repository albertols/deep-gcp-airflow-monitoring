# DCAM (deep-gcp-airflow-monitoring)

DCAM is a local-first, read-only monitoring and advisory tool for Google Cloud's Managed Service for
Apache Airflow (formerly Cloud Composer). It shows which DAGs consume capacity and why work waits,
with evidence, and recommends copy-paste fixes that humans review and apply.

- Product specification: `docs/spec/dcam-spec.md`. Read only the sections a task needs (it is ~6,000 lines).
  Start with "Changes in v2", §22.2 (roadmap) and the section of the epic you work on.
- Engineering constitution: `docs/spec/constitution.md`. Decisions: `docs/adr/`.
- Current milestone: **M0 foundations done → M1 connect and collect** (spec §22.2).

## Commands
- `pnpm i`: install (Node.js ≥ 22.12, pnpm 11 via Corepack)
- `pnpm dcam --demo`: run DCAM on the synthetic demo workspace at http://127.0.0.1:8787 (no Google Cloud access)
- `pnpm dev`: server (tsx watch) and UI (Vite, http://127.0.0.1:5173, proxies /api)
- `pnpm test` · `pnpm typecheck` · `pnpm lint` · `pnpm depcruise` · `pnpm hygiene`
- `pnpm check`: every gate above plus format check (run before asking for review)
- `pnpm --filter @dcam/<package> test`: one package
- `pnpm gen`: regenerate `packages/contracts/src/generated/` from `openapi.yaml`
- `pnpm diagrams`: export changed draw.io diagrams (local draw.io, else Docker)

## Non-negotiables
1. Read-only by construction. Never add a code path that changes Google Cloud or Airflow.
   Outbound HTTP to monitored systems goes only through `packages/adapters/http-guard`; never
   widen its allowlist without security review (spec §18.2).
2. No network I/O outside adapters. `packages/domain` is pure. ESLint and dependency-cruiser enforce it.
3. Test first. A failing test that names a requirement ID (`FR-…`, `NFR-…`, `HM-…`) comes before code.
4. Requirement IDs in specs, tasks, test names and code (`@implements HM-003`).
5. The repository is public. Never commit real project IDs, environment names, DAG IDs, hostnames,
   captured API responses or screenshots of real environments. Never read `dcam.config.yaml` or
   `.dcam-denylist`. Use demo mode, the emulator and sanitised fixtures (spec §18.12).
6. Never invent Composer or Airflow facts. Check official documentation, cite it, and mark anything
   uncertain with ⚠️ VERIFY.

## Architecture (spec §11.4, §11.5)
- `packages/domain`: pure computations (occupancy sweep: slot-seconds, concurrency).
- `packages/ports`: interfaces (Clock, TaskInstanceStore). `packages/application`: use cases.
- `packages/adapters/*`: http-guard (only network path), duckdb-store (DuckDB 2.0 LTS), fakes (demo data).
- `packages/contracts`: `openapi.yaml` is the API source of truth; types and client are generated.
- `apps/server`: Fastify composition root on 127.0.0.1 (Host check, CSP). `apps/web`: React + MUI SPA.
- `packages/ui-kit`: tokens, theme, the (i) explanation popover. `packages/cli`: `dcam` command.
- Internal packages export TypeScript source (`exports: ./src/index.ts`); tsx, Vite and Vitest run it directly.

## Workflow
- New capability: `/spec <requirement IDs>` → review → `/tdd <task>` per task → `code-reviewer` subagent.
- UI change: `/validate-ui` (Claude in Chrome against `pnpm dcam --demo`; Playwright MCP as fallback).
- Lasting decision: `/adr`. Diagram: `/diagram`. Domain fact: ask the `gcp-airflow-expert` subagent.
- Commits: Conventional Commits, signed off (`git commit -s`), one green step per commit.
- Harness files (`.claude/settings*.json`, `.claude/hooks/`, `.mcp.json`) change only in maintenance
  mode, set by a human (spec §21.4).

## Style
- TypeScript strict, no `any`, named exports, Zod or explicit checks at adapter boundaries.
- Every number has a unit and a source; estimates are labelled with their method (spec §8.1).
- UI text: sentence case, plain words, say what to do next (spec §12.12).
- MUI 9: layout props go in `sx` (no `alignItems=` shorthand on `Stack`).
