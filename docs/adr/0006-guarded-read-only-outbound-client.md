---
status: proposed
date: 2026-11-05
decision-makers: DCAM maintainers
consulted: Claude Code (research subagents, code-reviewer)
informed: contributors
---

# One guarded, read-only outbound HTTP client

## Context and Problem Statement

DCAM uses identities that often have write permissions on production environments. It must be
incapable of changing them, and of being tricked into it (spec §18.2, P-1, NFR-SEC-04).

## Decision Drivers

- Default deny; every allowed call is a declared read
- No bypass through redirects, encoded paths, method overrides or request bodies
- Works with corporate proxies; testable without the network

## Considered Options

- One REST client (`@dcam/http-guard`) with a method + host + path allowlist, used by every adapter
- Official Google gRPC client libraries
- Per-adapter HTTP code

## Decision Outcome

Chosen option: "One guarded REST client", because a single choke point can be proven read-only.

### Consequences

- Good, because the allowlist covers Airflow REST API v1/v2 GET reads (never config, connections,
  variables or XCom), Cloud Monitoring and Composer reads, Storage object reads and Cloud Logging
  `entries:list` with strict body validation.
- Good, because an M0 review found and fixed real bypasses: followed redirects (now
  `redirect: 'manual'` and 3xx rejected) and encoded separators (`%2F`, `%5C`) in segments. URLs with
  credentials, method-override headers and GET bodies are rejected; the allowlist can only be narrowed.
- Good, because `DCAM_NETWORK=loopback-only` keeps Claude Code sessions and tests off the network and
  fails closed on unrecognised values.
- Bad, because every new endpoint needs an allowlist change with security review.

### Confirmation

`packages/adapters/http-guard/test/guarded-client.test.ts`: unit and property tests plus a real loopback
server proving redirects are not followed. ESLint and dependency-cruiser forbid network modules elsewhere.

## More Information

Follow-ups for M1, when real configuration exists: bind the Airflow host to the configured `airflowUri`
hosts instead of any `*.composer.googleusercontent.com`; restrict Storage reads to the environment
bucket; accept host overrides only for loopback; proxy support (FR-AUTH-07); the opt-in
`executeAirflowCommand` entry with its subcommand validator.
