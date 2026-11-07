---
status: proposed
date: 2026-11-05
decision-makers: DCAM maintainers
consulted: Claude Code (research subagents, code-reviewer)
informed: contributors
---

# Apache-2.0 licence, DCO sign-off, public from the first commit

## Context and Problem Statement

DCAM is meant for any Managed Airflow (Composer) user and should be adoptable by companies and, later,
by Google or the Airflow community (spec §G.4, OQ-02).

## Decision Drivers

- Permissive licence with a patent grant
- Low-friction contributions without a CLA
- A public repository from day one, while maintainers test against private environments

## Considered Options

- Apache-2.0 + Developer Certificate of Origin
- MIT
- A copyleft licence

## Decision Outcome

Chosen option: "Apache-2.0 + DCO", matching the Apache Airflow ecosystem.

### Consequences

- Good, because companies can adopt it; contributors sign off commits (`git commit -s`).
- Bad, because a public repository needs hygiene controls: git-ignored local configuration, sanitised
  fixtures, a personal denylist and a scan in pre-commit, the stop hook and CI (spec §18.12).

### Confirmation

`LICENSE`, `NOTICE` (trademark notice), `CONTRIBUTING.md`; `pnpm hygiene` in pre-commit and CI.

## More Information

"Google Cloud", "GCP", "Managed Service for Apache Airflow" and "Cloud Composer" are Google trademarks;
"Apache Airflow" is an ASF trademark; the project uses them nominatively. Trademark check of the name
before 1.0 (OQ-01).
