## What and why

<!-- Requirement IDs (FR-…, NFR-…, HM-…, REC-…), feature folder, related ADRs -->

## How it was verified

- [ ] Tests written first and passing (`pnpm check`)
- [ ] UI validated with /validate-ui (demo mode); report: specs/<feature>/validation/report.md
- [ ] Accessibility: keyboard path checked, every new panel has an (i) explanation

## Safety

- [ ] No new outbound endpoint, or the allowlist change was reviewed by a maintainer
- [ ] No credentials, real project IDs or customer data in code, fixtures, screenshots or logs (`pnpm hygiene`)
- [ ] Observer budget unchanged, or the budget test updated with a reason

## Documentation

- [ ] Specification, README and CLAUDE.md updated if behaviour or commands changed
