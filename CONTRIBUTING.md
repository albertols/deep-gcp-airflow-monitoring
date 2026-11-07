# Contributing to DCAM

Thanks for helping. DCAM is a read-only tool that people point at production, so safety comes first.

## Before you start

- Read [CLAUDE.md](CLAUDE.md) (non-negotiables and commands) and the parts of the
  [specification](docs/spec/dcam-spec.md) your change touches.
- Discuss larger changes in an issue first. Structural decisions need an ADR (`docs/adr/`, MADR 4.0).

## Development

```bash
corepack enable            # or: npm i -g corepack && corepack enable
pnpm i
pnpm dcam --demo           # http://127.0.0.1:8787, synthetic data, no Google Cloud access
pnpm check                 # format, lint, typecheck, boundaries, tests, hygiene
git config core.hooksPath .githooks   # enables the hygiene pre-commit hook
```

## Rules

- **Read-only.** Outbound calls to monitored systems go only through `packages/adapters/http-guard`.
  Allowlist changes need a security review from a maintainer.
- **Test first.** Name tests after the requirement they cover (`it('HM-003: …')`).
- **Public repository.** Never commit real project IDs, environment or DAG names, hostnames, captured API
  responses, logs or screenshots of real environments. Put your own identifiers in a git-ignored
  `.dcam-denylist` (one literal or `/regex/` per line); the pre-commit hook and CI refuse matches.
- **Facts.** Platform facts cite official documentation; uncertain ones are marked ⚠️ VERIFY.

## Pull requests

- Conventional Commits, small and focused, one requirement slice per pull request.
- Every commit is signed off under the [Developer Certificate of Origin](https://developercertificate.org/):
  `git commit -s` adds `Signed-off-by: Your Name <you@example.com>`.
- Fill in the pull request template, including how you verified the change.

By contributing, you agree that your contributions are licensed under the Apache License 2.0.
