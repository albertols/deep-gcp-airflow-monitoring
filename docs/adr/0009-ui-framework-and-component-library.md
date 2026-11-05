---
status: proposed
date: 2026-11-05
decision-makers: DCAM maintainers
consulted: Claude Code (research subagents, code-reviewer)
informed: contributors
---

# React 19 + Vite 8 + MUI 9, TanStack Query and Table for data

## Context and Problem Statement

DCAM's UI should feel familiar to Google Cloud console users, stay accessible, and handle dense tables of
thousands of DAGs (spec §12, NFR-PERF-03, NFR-A11Y-01).

## Decision Drivers

- Material conventions close to the Cloud console; accessible primitives
- Dense, virtualised tables without paid licences
- Bundle budget ≤ 350 KB gzip (NFR-PERF-05)

## Considered Options

- MUI 9 for components, TanStack Table 9 + Virtual for the league table, TanStack Query for data
- MUI X Data Grid (column pinning and grouping need Pro or Premium)
- Chakra UI (used by the Airflow 3 UI); Mantine

## Decision Outcome

Chosen option: "MUI 9 + TanStack Query, Table and Virtual", because MUI gives console-like components and
TanStack covers dense grids for free.

### Consequences

- Good, because the M0 bundle is 163 KB gzip.
- Good, because the dark blue-grey theme comes from the spec's tokens (`@dcam/ui-kit`).
- Bad, because MUI 9 removed layout shorthand props on `Stack`; layout goes in `sx` (noted in CLAUDE.md).
- Neutral: TanStack Router arrives with the second route (M2); M0 has one page.
- Neutral: fonts come from the system stack (Roboto Flex if installed), with no external font requests
  (local-first, strict CSP).

### Confirmation

Component tests (Testing Library) and browser validation with Claude in Chrome (`/validate-ui`).

## More Information

Spec §12.5 (tokens), §12.9 (the (i) pattern). ECharts 6 and uPlot are decided in ADR-0010 (M2).
