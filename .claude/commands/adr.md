---
description: Create the next architecture decision record (MADR 4.0)
argument-hint: <title, or an ADR number from the backlog in spec §21.9>
---

Create an ADR for $ARGUMENTS using the `adr-madr` skill.

1. If $ARGUMENTS is a backlog number (spec §21.9), use its title and proposed decision as the starting point.
2. Number it with the next free `NNNN` in `docs/adr/`; file name `NNNN-title-with-dashes.md`.
3. Fill every MADR section with real drivers, options and consequences; link the requirement IDs and
   spec sections it affects; add a "Confirmation" that says how the decision is checked (a test, a gate).
4. Leave `status: proposed` unless a human has accepted it. Accepted ADRs are never edited, only superseded.
