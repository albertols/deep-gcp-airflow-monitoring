---
description: Implement one task test-first (red, green, refactor), then review it
argument-hint: <task ID from specs/*/tasks.md, or a requirement ID>
---

Implement $ARGUMENTS test-first.

1. Find $ARGUMENTS in `specs/*/tasks.md` or in `docs/spec/dcam-spec.md`. Restate its acceptance criteria
   and requirement IDs. If anything is ambiguous, stop and ask.
2. Use the test-first-implementer subagent. For each acceptance criterion: red (smallest failing test
   named after the requirement ID, shown failing), green (least code), refactor (tests stay green).
3. Run `pnpm check` (format, lint, typecheck, boundaries, tests, hygiene).
4. Use the code-reviewer subagent on the diff and fix every actionable finding.
5. If the UI changed, run /validate-ui for the affected screen.
6. Mark the task done in tasks.md and commit (`git commit -s`, Conventional Commits).
   Summarise the tests added, the files changed and any open questions.
