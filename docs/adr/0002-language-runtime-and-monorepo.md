---
status: proposed
date: 2026-11-05
decision-makers: DCAM maintainers
consulted: Claude Code (research subagents, code-reviewer)
informed: contributors
---

# TypeScript 6 on Node.js 22.12+, in a pnpm 11 + Turborepo 2 monorepo

## Context and Problem Statement

DCAM is one TypeScript code base: server, web UI, CLI and shared packages (spec §11.6). It must run on
maintainers' laptops, including the first maintainer's Intel Mac on macOS 12, and on Linux CI.

## Decision Drivers

- One language end to end; mature Google auth libraries (`google-auth-library` 11 needs Node.js 22)
- Tooling support: typescript-eslint accepts TypeScript < 6.1; openapi-typescript and dependency-cruiser
  do not support TypeScript 7.0, which ships without a compiler API
- Oldest supported machine: Intel macOS 12 with Node.js 22.23 (checked 2026-11-05)
- Fast, cache-friendly workspace

## Considered Options

- Node.js 22.12+ minimum, TypeScript 6.0, pnpm 11, Turborepo 2
- Node.js 26 (Active LTS since 2026-10-28) as the minimum, TypeScript 7.0
- Bun or Deno

## Decision Outcome

Chosen option: "Node.js 22.12+ minimum, TypeScript 6.0, pnpm 11, Turborepo 2", because it runs on every
target machine and every tool in the chain supports it. CI tests Node.js 22, 24 and 26.

### Consequences

- Good, because the M0 smoke test passed on Intel macOS 12 (Node.js 22.23, pnpm 11.28 through Corepack).
- Good, because `tsconfig.base.json` already follows TypeScript 7 rules (no `baseUrl`, strict), so moving
  to TypeScript 7 is a version bump once its compiler API ships (expected in 7.1).
- Bad, because Node.js 22 reaches end of life on 2027-04-30; revisit before then.
- Neutral: internal packages export TypeScript source (`exports: ./src/index.ts`); tsx, Vite and Vitest run
  it directly, so there is no build step for libraries.
- Neutral: Homebrew-style Node builds may lack Corepack; the README documents `npm i -g corepack`.

### Confirmation

`engines` and `packageManager` in package.json; CI matrix on 22, 24 and 26; `pnpm typecheck` gate.

## More Information

⚠️ VERIFY whether newer Node.js majors run on macOS 12 before raising the minimum. pnpm 12 (a Rust
rewrite with breaking configuration changes) is revisited after M2. Sources: spec §11.6 and §H.6.
