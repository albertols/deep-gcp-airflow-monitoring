---
status: proposed
date: 2026-11-05
decision-makers: DCAM maintainers
consulted: Claude Code (gcp-airflow-expert research subagent)
informed: contributors
---

# Authentication: Application Default Credentials through the Google Cloud CLI

## Context and Problem Statement

Live mode (feature 002) calls the Composer API, Cloud Monitoring and each environment's Airflow web server
with the user's own identity (spec §18.3, FR-AUTH-01). The first target user runs DCAM on a corporate laptop,
behind a proxy, with Application Default Credentials (ADC) created by
`gcloud auth application-default login`. DCAM must hold tokens in memory only, never persist them, and keep
every outbound request on the guarded read-only client (ADR-0006).

## Decision Drivers

- No credential material stored or logged by DCAM; tokens in memory only (FR-AUTH-01)
- No new endpoint on the guarded client's allowlist, which needs security review (spec §18.2 rule 6)
- Works behind corporate proxies and TLS inspection (FR-AUTH-07)
- Testable without Google Cloud

## Considered Options

- Ask the Google Cloud CLI for an access token
  (`gcloud auth application-default print-access-token`, fixed arguments, no shell) and cache it in memory
- Read the ADC file and refresh tokens with a `POST` to `oauth2.googleapis.com/token`
- A Google auth client library

## Decision Outcome

Chosen option: "Ask the Google Cloud CLI", because DCAM never handles refresh tokens or private keys, and no
token endpoint has to join the allowlist.

### Consequences

- Good, because the CLI already works on the user's machine with their proxy and CA settings, honours
  `GOOGLE_APPLICATION_CREDENTIALS`, and the sign-in path (FR-AUTH-02) uses the same CLI.
- Good, because the adapter (`@dcam/gcp`) only sees a bare access token on stdout; it keeps it for 30 minutes
  (tokens last 3600 s; the CLI documents neither caching nor an expiry field) and asks again after a 401.
- Good, because tests inject the command runner and never run the real CLI.
- Bad, because the Google Cloud CLI becomes a prerequisite of live mode; the doctor checks for it and shows how
  to install it.
- Bad, because each refresh starts a child process (about once every 30 minutes).
- Neutral: the CLI honours the lowercase `https_proxy` variables; DCAM's own calls use undici's
  `EnvHttpProxyAgent` (Node 22.12–22.20's built-in `fetch` ignores proxy variables).

### Confirmation

`packages/adapters/gcp/test`: token caching, concurrent callers sharing one refresh, invalidation, a missing
CLI, and that the token never appears in errors. The doctor's "ADC token obtainable" check exercises it
against the real CLI on the user's machine.

## More Information

- Command reference: https://docs.cloud.google.com/sdk/gcloud/reference/auth/application-default/print-access-token
- Proxy settings of the CLI: https://docs.cloud.google.com/sdk/docs/proxy-settings
- Quota project (FR-AUTH-04): Google API calls carry `x-goog-user-project` set to `auth.quotaProjectId` or the
  environment's project; Airflow calls do not.
- Impersonation (FR-AUTH-03, M4) may reuse the same CLI command with service account impersonation; the command
  reference mentions `--lifetime` only for impersonated tokens (⚠️ VERIFY when M4 starts).
