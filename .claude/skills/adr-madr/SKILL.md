---
name: adr-madr
description: Write DCAM architecture decision records in MADR 4.0 format. Use when a decision changes structure, a dependency, a contract or a quality attribute, when /adr runs, or when the spec's ADR backlog (§21.9) names a decision that is due.
---

# Architecture decision records (MADR 4.0)

- Location and name: `docs/adr/NNNN-title-with-dashes.md`, numbered sequentially (next free number).
- Front matter: `status` (proposed | accepted | deprecated | superseded by ADR-NNNN), `date`,
  `decision-makers`, `consulted`, `informed`.
- Sections, in order: Context and Problem Statement · Decision Drivers · Considered Options ·
  Decision Outcome (with Consequences and Confirmation) · Pros and Cons of the Options · More Information.
- Link requirement IDs (`NFR-…`, `FR-…`) and spec sections; cite sources for platform facts.
- "Confirmation" says how the decision is enforced or checked: a test, a lint or boundary rule, a CI gate.
- Accepted ADRs are immutable (the path guard enforces it): change your mind with a new ADR that
  supersedes the old one, then edit only the old one's `status:` line.
- Use `template.md` in this folder.
