---
status: proposed
date: 2026-11-05
decision-makers: DCAM maintainers
consulted: Claude Code (research subagents, code-reviewer)
informed: contributors
---

# Record architecture decisions with MADR 4.0

## Context and Problem Statement

DCAM is built mostly by Claude Code under human review, in a public repository. Structural decisions
must survive sessions, contributors and context resets, and be cheap to read (spec §21.9, NFR-MAINT-04).

## Decision Drivers

- Durable, reviewable rationale next to the code
- A format agents and humans already know
- Immutability of accepted decisions

## Considered Options

- MADR 4.0 in `docs/adr/`
- Free-form design notes in the wiki
- Decisions only in pull request descriptions

## Decision Outcome

Chosen option: "MADR 4.0 in docs/adr/", because it is a widely used template with explicit drivers,
options and consequences, and it fits plain Markdown review.

### Consequences

- Good, because every structural choice has a findable record with alternatives.
- Bad, because writing ADRs costs time; the `/adr` command and the `adr-madr` skill reduce it.

### Confirmation

The path guard hook refuses body edits to accepted ADRs (only the `status:` line may change); the hook
corpus test covers it. MADR 4.0.0 is still the latest release (checked 2026-11-05).

## More Information

Spec §21.9 (ADR backlog). https://adr.github.io/madr/
