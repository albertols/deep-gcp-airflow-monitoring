---
status: proposed
date: 2026-11-07
decision-makers: DCAM maintainers
consulted: Claude Code (documentation subagent)
informed: contributors
---

# Live updates: poll the local API now, Server-Sent Events when the server publishes changes

## Context and Problem Statement

In live mode, collectors commit new data every few seconds to minutes (ADR-0007). The pages must show it without
a reload, and the DCAM health page must update every 10 seconds while it is visible (FR-SELF-01). Spec §11.10
designs a Server-Sent Events (SSE) channel, `GET /api/v1/events?topics=…`, whose events carry query-key hints so
that the UI invalidates its TanStack Query caches. The same section has the UI report visibility and focus with
`PUT /api/v1/session/focus`, which drives adaptive cadences (FR-COLL-05, M4). How does the browser learn about
new data in M1, and what replaces that later?

## Decision Drivers

- Freshness the user can see: the health page within 10 s; other pages within one collection cycle
- UI traffic must never reach a monitored system or spend an observer budget (P-2, §7.11)
- Same origin only, inside the existing Content Security Policy (ADR-0017)
- Few moving parts until the server has change events to publish
- Testable without timers that depend on the network

## Considered Options

- Poll the local API with TanStack Query intervals now; add SSE invalidation events when the server publishes
  changes
- SSE now, in M1
- WebSocket
- Long polling

## Decision Outcome

Chosen option: "Poll now; SSE when the server publishes changes", because in M1 the server has no change events
to push: nothing records which windows a commit made dirty (`meta.dirty_windows`, §11.7, is not built), and
FR-COLL-05 is planned for M4. Polling meets FR-SELF-01 today, and SSE stays the target transport of §11.10.

What the code does today:

- **Every query** refetches every 30 s, and data counts as fresh for 15 s (`createQueryClient` in
  `apps/web/src/api.ts`).
- **The collection status** (`GET /api/v1/collection`) refetches every 10 s in live mode and not at all in demo
  mode, whose data never changes (`COLLECTION_POLL_MS` in `apps/web/src/components/collection.tsx`). The shell's
  live indicator, the environment badges and the DCAM health page share this one query.
- **Hidden tabs** do not poll: TanStack Query stops interval refetches while the tab is in the background unless
  `refetchIntervalInBackground` is set, and DCAM does not set it
  ([`useQuery` reference](https://tanstack.com/query/latest/docs/framework/react/reference/useQuery)).
- **The server** memoises aggregated views for 15 s in live mode (10 minutes in demo mode), so concurrent and
  repeated requests share one computation (`createMemo` in `apps/server/src/cache.ts`, used in
  `apps/server/src/app.ts`).
- **No SSE.** The server has no `/api/v1/events` route, and `packages/contracts/openapi.yaml` does not declare
  one.
- **Polling stays local.** Every route reads the local store or the engine's status. Only the collection engine
  calls Google Cloud or Airflow, on its own schedule and budgets, so a page that polls faster never adds load to
  an environment.

### Consequences

- Good, because the UI needs no connection state, works through the Vite dev proxy, and tests can assert the
  intervals (`apps/web/test/health-page.test.tsx`, `apps/web/test/live-shell.test.tsx`).
- Good, because polling costs only local CPU, and the memo bounds it.
- Bad, because new data can take up to 30 s to appear on pages other than the health page, plus up to 15 s of
  memo age.
- Bad, because every open, visible tab re-requests its views every 30 s, even when nothing changed.
- Neutral: when SSE arrives, it carries hints, not data. Queries keep their REST endpoints, and the 30 s interval
  becomes a fallback for a dropped stream.

When SSE is built (with dirty-window tracking, or FR-COLL-05 in M4, whichever comes first):

- `GET /api/v1/events` follows §11.10: scoped topics (`env:<env_id>`, `findings`, `alerts`, `collectors`,
  `self`), a heartbeat comment every 15 s, `Last-Event-ID` resumption, and event types such as
  `collector.cycle_completed` and `signal.updated`. It is declared in `openapi.yaml` first (ADR-0003).
- `PUT /api/v1/session/focus` is DCAM's first state-changing endpoint, so ADR-0017's CSRF and `Origin` checks
  must exist before it.
- The existing `connect-src 'self'` directive already allows a same-origin `EventSource`.

### Confirmation

- `apps/web/test/health-page.test.tsx` asserts the 10 s interval in live mode and no interval in demo mode;
  `apps/web/test/live-shell.test.tsx` asserts that every page shares the 10 s collection poll.
- When SSE is added, a failing test that names FR-COLL-05 or FR-SELF-01 comes first, and the route is declared
  in `openapi.yaml` before it is built (ADR-0003).

## Pros and Cons of the Options

### Poll now; SSE when the server publishes changes

- Good, because each step ships only what has a producer: intervals now, events once commits produce them.
- Bad, because DCAM lives with polling's delay and repeated requests until then.

### SSE now, in M1

- Good, because changes would appear within one collection cycle, over one connection per tab.
- Good, because `EventSource` reconnects by itself and resends the last event ID
  ([HTML Standard, server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html)).
- Bad, because nothing in M1 would emit events except "a cycle finished", so the UI would still have to refetch
  every view on every cycle.
- Bad, because DCAM serves plain HTTP/1.1 on loopback. Without HTTP/2, each stream holds one of the few
  connections a browser opens per domain (six), shared by all tabs, which can starve the page's own requests
  ([MDN, `EventSource`](https://developer.mozilla.org/en-US/docs/Web/API/EventSource)).

### WebSocket

- Good, because one connection carries messages both ways, so it could also carry the focus signal.
- Bad, because DCAM needs only server-to-client hints, and the focus signal is a rare request.
- Bad, because the WebSocket handshake is not covered by the same-origin rules that protect `fetch`, so the
  server must check `Origin` itself (ADR-0017).

### Long polling

- Good, because it works everywhere plain HTTP does.
- Bad, because it reinvents what SSE standardises (reconnection, event IDs), with more server code.

## More Information

- Spec §11.10 (live updates and caching), §11.9 (`/events` in the resource map), §11.6 (technology stack:
  "Server-Sent Events, WebSocket considered").
- FR-COLL-05 (adaptive cadence, M4) and FR-SELF-01 (health page every 10 s).
- ADR-0009 chose TanStack Query, whose cache the SSE hints invalidate.
