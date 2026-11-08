---
status: proposed
date: 2026-11-05
decision-makers: DCAM maintainers
consulted: Claude Code (research subagents, code-reviewer)
informed: contributors
---

# Hexagonal architecture enforced by dependency-cruiser and ESLint

## Context and Problem Statement

DCAM's safety rests on one property: only the guarded client talks to monitored systems, and domain
logic stays pure so it can be tested and reused (spec §11.4). Conventions alone erode, especially with
AI-written code.

## Decision Drivers

- Read-only guarantee (P-1) and testability (P-12)
- Portability of domain logic to another runtime (P-9)
- Violations caught in CI, not in review

## Considered Options

- dependency-cruiser rules plus ESLint `no-restricted-imports` and `no-restricted-globals`
- ESLint boundaries plugin only
- Review discipline only

## Decision Outcome

Chosen option: "dependency-cruiser plus ESLint", because dependency-cruiser checks package-level edges
(domain → nothing, adapters ↛ adapters, web → contracts and ui-kit only) and ESLint bans `fetch`,
`node:http(s)`, `undici` and Google SDKs outside `@dcam/http-guard` at the line level.

### Consequences

- Good, because a planted violation (domain importing `node:fs`, `node:https` and a port) produced four
  errors during M0, proving the rules bite.
- Bad, because two tools must agree; both run in `pnpm check` and CI.

### Confirmation

`pnpm depcruise` and `pnpm lint` are CI gates (`.dependency-cruiser.cjs`, `eslint.config.js`).

## More Information

Spec §11.4 rules 1–8.
