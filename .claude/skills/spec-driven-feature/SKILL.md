---
name: spec-driven-feature
description: The lightweight spec-driven feature flow for DCAM (spec §21.0, §21.8) - feature folders under specs/ with spec.md, plan.md and tasks.md, requirement IDs, test-first tasks and the Definition of Done. Use when starting a feature, when /spec runs, or when checking whether a feature is complete.
---

# Spec-driven features (lightweight flow until Spec Kit is adopted)

## Flow

1. **Specify.** `/spec <IDs>` creates `specs/NNN-<epic>-<name>/spec.md` from `templates/spec.md`:
   user stories, requirement IDs and EARS acceptance criteria copied from `docs/spec/dcam-spec.md`.
2. **Clarify.** Resolve open questions with the user; platform facts with the gcp-airflow-expert subagent.
   No `[NEEDS CLARIFICATION]` marker may remain.
3. **Plan.** `plan.md` from `templates/plan.md`: packages touched, contract changes (`openapi.yaml`
   first), data model, constitution check, ADRs needed.
4. **Tasks.** `tasks.md` from `templates/tasks.md`: ordered, small, test tasks before code tasks, each
   tagged with requirement IDs; `[P]` marks tasks that can run in parallel.
5. **Implement.** `/tdd <task>` per task.
6. **Verify.** `pnpm check` green; code-reviewer clean; `/validate-ui` for UI work; tasks ticked.

## Naming

`NNN-<epic>-<name>`, for example `010-dagx-league-table`. Epics are the codes in spec §9 (`DAGX`, `BOTL`, …).

## Definition of Done

- Every acceptance criterion has a passing test named after its requirement ID.
- `pnpm check` green (format, lint, typecheck, boundaries, tests, hygiene).
- API changes made in `openapi.yaml` and regenerated; contract tests pass.
- Every new panel has an (i) explanation; missing data shows as a gap; estimates are labelled.
- Spec, README and CLAUDE.md updated when behaviour or commands changed; ADR written for structural decisions.
