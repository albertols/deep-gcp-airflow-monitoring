---
status: proposed
date: 2026-11-05
decision-makers: DCAM maintainers
consulted: Claude Code (research subagents, code-reviewer)
informed: contributors
---

# Contract-first HTTP API with OpenAPI 3.1, Fastify 5 and generated types

## Context and Problem Statement

The web UI, the CLI, a future MCP server and a possible Python twin inside Airflow all use DCAM's API
(spec §11.9, §11.12). How do we keep them in sync?

## Decision Drivers

- One source of truth usable from TypeScript and Python (P-9)
- Typed client in the UI without hand-written types
- Testable conformance (ARCH-EMB-03)

## Considered Options

- OpenAPI 3.1 document + openapi-typescript types + openapi-fetch client; Fastify server
- tRPC
- Hand-written types shared through a package

## Decision Outcome

Chosen option: "OpenAPI 3.1 + generated types + Fastify", because the contract is language-neutral and
JSON Schema 2020-12 is also used for configuration and plugin manifests.

### Consequences

- Good, because `pnpm gen` regenerates types; the web app imports only `@dcam/contracts`.
- Good, because errors follow RFC 9457 problem details with `fix_hint` and `docs_url`.
- Bad, because openapi-typescript 7 declares a TypeScript 5 peer range (allowed via pnpm peerDependencyRules).

### Confirmation

`apps/server/test/app.test.ts` validates every response against `packages/contracts/openapi.yaml` with
Ajv (2020-12 dialect). Breaking changes need a new `/api/vN` and an ADR.

## More Information

Spec §11.9. Fastify 5 (v6 is alpha), Ajv 8, Zod 4 at adapter boundaries.
