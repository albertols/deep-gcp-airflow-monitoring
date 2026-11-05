---
status: proposed
date: 2026-11-05
decision-makers: DCAM maintainers
consulted: Claude Code (research subagents, code-reviewer)
informed: contributors
---

# Test strategy and Claude Code harness versions (M0)

## Context and Problem Statement

DCAM is test-first (P-12) and largely written by Claude Code. Which tools, and which harness formats,
does M0 rely on (spec §19, §21, VC-25)?

## Decision Drivers

- Fast unit tests with property-based testing for analytics and security invariants
- Contract tests against the OpenAPI document
- Hooks and settings formats that match the current Claude Code release

## Considered Options

- Vitest 5 + fast-check 4 + Testing Library + Ajv contract tests; Playwright 1.64 and MSW 3 later
- Jest

## Decision Outcome

Chosen option: "Vitest 5 + fast-check 4 + Testing Library + Ajv contract tests".

### Consequences

- Good, because property tests already caught real issues (occupancy edge cases) and prove read-only
  invariants (no non-GET Airflow request passes the guard).
- Good, because the hook scripts are tested like product code: 28 cases run each hook as Claude Code
  does (JSON on stdin, exit code 2 = blocked).
- Bad, because Vitest runs without globals, so Testing Library cleanup is registered explicitly.

### Confirmation

`pnpm test` (all packages and `tools/scripts`) in `pnpm check` and CI.

## More Information

Harness formats checked on 2026-11-05 against https://code.claude.com/docs: hooks (`PreToolUse`, `Stop`;
exit code 2 blocks), skills (`.claude/skills/<name>/SKILL.md`), subagents (`.claude/agents/*.md`, `name`
and `description` required), `.mcp.json`. The spec's `"onFailure": "block"` hook setting is not used
until verified for the installed Claude Code version; the guard scripts fail closed on unreadable input
themselves. Playwright MCP pinned at 0.0.84. Spec Kit (`specify-cli` 1.3.0) is deferred to M2 (§21.0).
