---
description: Draft a feature folder (spec, plan, tasks) from requirement IDs in the DCAM specification
argument-hint: <requirement IDs or an epic slice, for example FR-DAGX-01..03 HM-003>
---

Create a feature folder for $ARGUMENTS using the `spec-driven-feature` skill.

1. Read the cited requirements, signals and acceptance criteria in `docs/spec/dcam-spec.md` (§8, §9, §10)
   and the milestone they belong to (§22.2). Check `docs/spec/constitution.md`.
2. Pick the next free number in `specs/` and create `specs/NNN-<epic>-<name>/` with `spec.md`, `plan.md`
   and `tasks.md` from the skill's templates. Copy requirement IDs and EARS criteria verbatim.
3. List open questions and ⚠️ VERIFY items that block the feature; do not guess platform facts.
4. Every acceptance criterion gets at least one test task, and test tasks come before code tasks.
5. Stop and ask for human review before any implementation.
