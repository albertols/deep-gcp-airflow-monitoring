---
status: proposed
date: 2026-11-07
decision-makers: DCAM maintainers
consulted: Claude Code (documentation subagent)
informed: contributors
---

# Local web security: loopback only, exact Host check, strict CSP; session token and CSRF before the first write

## Context and Problem Statement

DCAM serves its API and UI from the user's laptop while the user browses other sites in the same browser. Those
sites can make the browser send requests to `http://127.0.0.1:8787`, and a DNS rebinding attack can give a
hostile page a hostname that resolves to 127.0.0.1 (spec §18.1, "Spoofing"). The API exposes metadata of
production environments, such as DAG IDs, owners and pool names. Spec §18.5 and NFR-SEC-01 and NFR-SEC-02 list
the full model: loopback bind, a mandatory access token for any other interface, a one-time session token
exchanged for an `HttpOnly`, `SameSite=Strict` cookie, `Host` and `Origin` validation, CSRF tokens, no CORS, a
strict Content Security Policy and rate limiting. Which parts does M1 need, and when do the others arrive?

## Decision Drivers

- No other site can read DCAM's data or make DCAM change anything (NFR-SEC-02)
- No request to DCAM can make it call a monitored system (P-1, P-2)
- Protection in place before the feature that needs it, not after
- Little friction for one user on one laptop: open the printed URL and it works

## Considered Options

- Loopback-only bind, an exact `Host` allowlist, a strict CSP and no CORS now; the session token, `Origin` checks
  and CSRF tokens before the first state-changing endpoint, and the access token before the first non-loopback
  bind
- The full §18.5 model now
- Loopback bind only, without a `Host` check
- A configurable bind address with a mandatory access token now

## Decision Outcome

Chosen option: "Loopback, Host allowlist, CSP and no CORS now; tokens and CSRF before they protect something",
because DCAM's API today has only `GET` routes and cannot listen beyond 127.0.0.1. The controls that exist cover
every way a page could reach it, and each missing one is tied to the change that will need it.

What the code does today:

- **Loopback only.** `dcam start` listens on `127.0.0.1`, a constant in `packages/cli/src/cli.ts` (`HOST`), and
  probes for a free port on the same address (FR-SETUP-01). Nothing can change the address: there is no
  `--allow-remote` flag, and `server` in the configuration file is accepted and ignored (`NOT_USED_YET` in
  `packages/adapters/config-file/src/schema.ts`). The Vite dev server also binds to `127.0.0.1`
  (`apps/web/vite.config.ts`).
- **Exact `Host` allowlist.** An `onRequest` hook in `apps/server/src/app.ts` answers 403 with an RFC 9457
  problem to any request whose `Host` header is not exactly `127.0.0.1:<port>` or `localhost:<port>`. The CLI
  passes these two values (`allowedHosts`). A rebinding page's requests carry its own hostname, so they fail.
- **Response headers** on every answer (`apps/server/src/app.ts`): `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, and this `Content-Security-Policy`:

  ```text
  default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;
  font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'
  ```

- **No CORS.** The server registers no CORS plugin and sends no `Access-Control-Allow-*` headers, so a page on
  another origin cannot read a response.
- **Read-only API.** Every operation in `packages/contracts/openapi.yaml` is a `get`, and the server registers
  only `GET` routes (Fastify adds the matching `HEAD` routes), plus the static UI files. No route starts
  collection or calls Google Cloud or Airflow: only the collection engine does, on its own schedule (ADR-0007).

### Consequences

- Good, because a cross-site page can neither read DCAM's answers (no CORS) nor reach DCAM through a rebound
  hostname (`Host` check), and DCAM has nothing a forged request could change.
- Good, because the user opens one printed URL with no token, and bookmarks keep working across restarts.
- Bad, because any process or OS user on the same machine can read the API: loopback is not per user. The
  session token of §18.5 closes this gap. Until then, DCAM targets single-user laptops (§11.11).
- Bad, because a page can still make the browser send blind `GET` requests to DCAM, for example from an image
  tag. The answer stays unreadable and nothing changes, but the request costs CPU. The 15-second memo of
  aggregated views bounds repeated work (`apps/server/src/cache.ts`); rate limiting (§18.5) is not built.
- Bad, because the CSP allows inline styles (`'unsafe-inline'`): MUI's Emotion runtime injects style elements.
  §18.5 asks for style nonces instead.
- Bad, because the CSP sets no `object-src`, so it falls back to `default-src 'self'`
  ([CSP Level 3](https://www.w3.org/TR/CSP3/)). §18.5 asks for `object-src 'none'`; adding it is a one-line
  follow-up.

Not implemented yet, and what triggers each:

- **Session token, `Origin` checks and CSRF tokens** (§18.5, NFR-SEC-02). They must exist before DCAM's first
  state-changing endpoint, for example `PUT /api/v1/session/focus` (FR-COLL-05, ADR-0008), finding lifecycle
  changes, alert rules and silences, or a `POST` that runs the doctor (§11.9). The plan follows §18.5: on start,
  DCAM prints a URL with a one-time token that the browser exchanges for an `HttpOnly`, `SameSite=Strict`
  session cookie.
- **`--allow-remote` with `DCAM_ACCESS_TOKEN`** (NFR-SEC-01). It must exist before any non-loopback bind, such as
  the Docker image, which must listen inside its container (§11.11, M8).
- **Rate limiting** of the local API (§18.5).
- **The MCP endpoint's own bearer token and `Origin` check** (ADR-0018, M8).

### Confirmation

- `apps/server/test/app.test.ts`: "NFR-SEC-02: rejects requests whose Host header is not DCAM (DNS rebinding)"
  and "NFR-SEC-02: sends a strict Content Security Policy and nosniff" (asserts `default-src 'self'` and no
  `unsafe-eval`).
- Follow-ups: a test that names NFR-SEC-01 and asserts the bind address, and a server test that fails when a
  route other than `GET` is registered while CSRF protection does not exist.

## Pros and Cons of the Options

### Loopback, Host allowlist, CSP and no CORS now; the rest before it protects something

- Good, because each control arrives with a test and a feature that needs it.
- Bad, because the model is incomplete for a while, and a contributor who adds a write endpoint must remember
  the CSRF work. The follow-up test above makes it fail loudly.

### The full §18.5 model now

- Good, because it closes the same-machine gap and is ready for the first write endpoint.
- Bad, because it adds a token exchange, cookie handling and CSRF plumbing that protect no request in M1, and a
  token URL the user must open after each restart.

### Loopback bind only, without a `Host` check

- Good, because it is simplest.
- Bad, because DNS rebinding reaches loopback services through a hostname the attacker controls, so the bind
  address alone does not keep other sites out.

### A configurable bind address with a mandatory access token now

- Good, because it would support Docker and shared machines from the start.
- Bad, because exposing production metadata on a network is a larger risk than M1's single-user scope justifies,
  and nothing in M1 needs it.

## More Information

- Spec §18.1 (threat model), §18.5 (local web application security), §11.11 (deployment targets), NFR-SEC-01,
  NFR-SEC-02.
- ADR-0006 covers outbound requests to monitored systems; this ADR covers inbound requests to DCAM.
- The Vite proxy in `apps/web/vite.config.ts` uses the shorthand `target` form, for which Vite sets
  `changeOrigin`, so `pnpm dev` requests reach the server with an allowed `Host` header.
