# DCAM engineering constitution

Derived from the guiding principles (spec §3.3) and the engineering articles (spec §21.8). Every
feature spec, plan and review checks against these articles. Changing an article needs an ADR.

| Article | Rule |
|---|---|
| I. Read-only | No code path may issue a mutating request to a monitored system. Allowlist changes need security review (spec §18.2). |
| II. Do no harm | Every collector declares a request and series budget; budgets are tested; DCAM degrades its own fidelity before adding load or cost (spec §7.11, `NFR-OBS-*`). |
| III. Test-first | No production code without a failing test that names a requirement ID. |
| IV. Contract-first | `packages/contracts/openapi.yaml` is the source of truth; generated types only; breaking changes need an ADR and a new API version. |
| V. Boundaries | Hexagonal architecture enforced by dependency-cruiser; network I/O only in `@dcam/http-guard`. |
| VI. Evidence | Every finding is reproducible from stored evidence; every number has a unit, a source and a freshness. |
| VII. Honest precision | Estimates are labelled with their method and confidence; unknown is shown as unknown, never as zero. |
| VIII. Accessible by default | WCAG 2.2 AA; state is never shown by colour alone; every panel has an (i) explanation. |
| IX. Simplicity | No new runtime dependency or service without justification; prefer data (packs) over code. |
| X. Traceability | Requirement → spec → task → test → code → documentation is kept current. |
| XI. Public by default | The repository is public: no real identifiers, captured responses or screenshots of real environments (spec §18.12). |
