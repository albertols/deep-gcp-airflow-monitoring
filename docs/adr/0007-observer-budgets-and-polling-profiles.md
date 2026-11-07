---
status: proposed
date: 2026-11-07
decision-makers: DCAM maintainers
consulted: Claude Code (documentation subagent)
informed: contributors
---

# Observer budgets: sliding-window request budgets, collection profiles and hard maxima

## Context and Problem Statement

DCAM polls production environments. Every Airflow REST API call costs the environment web server CPU and
metadata database time (spec §7.5, "Load model"), Cloud Monitoring bills reads per time series returned, and the
Composer API has per-project quotas (§7.10, ⚠️ VERIFY the values). Principle `P-2` says DCAM must never be the
reason an environment is slow or a quota is exhausted (§7.11). How does DCAM decide how often it calls each API,
how many requests it may make, and what happens when it runs out (FR-COLL-02, FR-COLL-06, FR-SETUP-05,
NFR-OBS-01, NFR-OBS-03, NFR-OBS-04, NFR-OBS-05)?

## Decision Drivers

- A budget is never exceeded in any 60-second window, and a test with a fake clock can prove it (NFR-OBS-05)
- Configuration can lower a budget but never raise it above a hard maximum (§7.11 item 1)
- Higher-priority work goes first, and background work always yields (FR-COLL-02, §7.11 item 2)
- An exhausted budget lowers fidelity; it never fails the collector or exceeds the budget (FR-COLL-06)
- One setting per environment for users: a profile (FR-SETUP-05)

## Considered Options

- Sliding-window request budgets per (environment, API) and per (project, API), a priority gate, collection
  profiles, and hard maxima enforced by the configuration schema and the engine
- A classic refilling token bucket with a burst capacity
- Rate limiting inside the guarded HTTP client (`@dcam/http-guard`)
- Cadences only, without request budgets

## Decision Outcome

Chosen option: "Sliding-window request budgets with a priority gate and profiles", because it is the only option
that bounds requests in every 60-second window while the engine still orders work by priority and ends a cycle
early with reduced fidelity.

What the code does today (feature 002):

- **Profiles.** `live`, `standard`, `eco` and `off` per environment (`Profile` in `packages/ports/src/config.ts`).
  The default is `standard` for the `prod` tier and `eco` for every other tier
  (`packages/adapters/config-file/src/load.ts`). `off` lists the environment and collects nothing. Cadences, in
  seconds (`DEFAULT_PROFILES` in `packages/adapters/config-file/src/schema.ts`):

  | Profile    | `airflowLive` | `airflowFacts` | `airflowInventory` | `monitoring` | `composer` |
  | ---------- | ------------- | -------------- | ------------------ | ------------ | ---------- |
  | `live`     | 10            | 30             | 900                | 60           | 300        |
  | `standard` | 30            | 60             | 3,600              | 60           | 600        |
  | `eco`      | 120           | 300            | 3,600              | 300          | 1,800      |

- **Budgets and hard maxima** (`DEFAULT_BUDGETS` and `HARD_MAXIMA` in `schema.ts`; `HARD_MAXIMA` and
  `effectiveBudgets` in `packages/application/src/collection/budget.ts`). The schema rejects a value above a hard
  maximum, and the engine clamps to the same maxima again. Requests per minute, unless stated:

  | API                        | Scope       | `live` | `standard` | `eco` | `background` | Hard maximum           |
  | -------------------------- | ----------- | ------ | ---------- | ----- | ------------ | ---------------------- |
  | Airflow REST API           | Environment | 60     | 12         | 4     | 2            | 120                    |
  | Airflow requests in flight | Environment | 2      | 2          | 2     | 2            | 4                      |
  | Cloud Monitoring           | Project     | 30     | 30         | 30    | ―            | 120 (⚠️ VERIFY, §7.10) |
  | Composer API               | Environment | 6      | 6          | 6     | ―            | 30                     |

- **Budget classes.** `background` is a budget class, not a profile: background-priority work (the DAG inventory)
  takes a token from the profile's Airflow budget and from the 2-per-minute `background` budget
  (`BudgetClass` in `packages/ports/src/config.ts`).
- **Sliding window.** `TokenBucket` admits at most the per-minute budget in any 60-second window. A budget below
  one request per minute spaces single requests out (0.5 per minute admits one request every 120 s). It reads its
  rate on every call, so a lower rate applies at once.
- **Priority gate.** `BudgetGate` queues requests `live` > `standard` > `background`, first come first served
  within a class. Background requests start only while the bucket is at least half full. The Airflow gate also
  limits requests in flight to `maxConcurrent`.
- **Cycles** (`packages/application/src/collection/engine.ts`). Each source call takes one token. A call may wait
  for a token until the cycle's deadline, its start plus its cadence. Each collector declares
  `maxRequestsPerCycle` in its manifest: `composer.config` 1, `af.live` 5, `af.facts` 6, `af.inventory` 10 and
  `mon.core` 16. A call that would pass that maximum, or that gets no token in time, throws
  `BudgetExhaustedError`. The cycle then ends with reduced fidelity, not as a failure, and the next cycle starts a
  full interval after it ended. Cadences carry ±10 % jitter, and a cycle never overlaps itself.
- **Circuit breakers** (`packages/application/src/collection/breaker.ts`). One per (environment, API). A 429, a
  5xx, a timeout or a network error opens it for the longer of `Retry-After` and a full-jitter backoff,
  `random() × min(15 min, 10 s × 2^(n−1))`. Then exactly one probe call goes ahead. After an error the user must
  fix, the collector waits 5 minutes or one cadence, whichever is longer. A VPC Service Controls denial stops
  calls to that API until `recheck(envId)` or a restart (FR-AUTH-06); no route calls `recheck` yet.
- **Visibility.** `GET /api/v1/collection` reports each API's effective budget, requests in the last hour and
  24 hours, and a "reduced fidelity" flag for 15 minutes after a cycle ran out of budget
  (`packages/application/src/collection/status.ts`). The DCAM health page shows them.

### Consequences

- Good, because a greedy collector cannot exceed its budget: the gate caps the total, so the per-cycle maxima
  may add up to more than the budget (`af.live` alone may ask for 10 requests a minute on `standard`), and
  priorities decide who waits.
- Good, because UI requests never reach a monitored system. Pages read only the local store, and only the
  engine's collectors call out. That makes §7.11 item 7 (several panels, one call) true by construction in M1.
- Good, because the budgets are visible on the DCAM health page next to the requests DCAM actually made (HM-030).
- Bad, because the hard maxima are declared twice, in `@dcam/config-file` and in `@dcam/application`. The
  application may not import an adapter (ADR-0004). Each copy has its own test, and no test compares them.
- Bad, because `dcam doctor` runs in its own process with its own guarded client
  (`packages/cli/src/doctor/adapters.ts`), outside the server's budgets. §7.11 item 8 wants one global budget. The
  doctor makes a fixed, small set of checks per environment, and the user starts it.
- Neutral: the Cloud Monitoring and Composer budgets are one value for every profile. §7.11 lowers them on
  `eco` (10 and 2 requests a minute) and `background` (5 and 1). On `eco` the longer cadences keep one
  environment's use below those values (`mon.core` makes at most 16 requests every 5 minutes, `composer.config`
  one every 30 minutes), but the budget does not enforce them.
- Neutral: `airflowInventory` is DCAM's own cadence key (900, 3,600 and 3,600 s). §7.7 derives the inventory
  cadence as `airflowFacts` × 10, and §17.2 has no such key. The inventory changes slowly and costs about 20 pages
  at 2,000 DAGs, so it runs less often than §7.7 suggests.

Not implemented yet:

- **Patient mode** (§7.11 item 4). `budgets.patientMode` is accepted and ignored (`NOT_USED_YET` in `schema.ts`).
  Only the circuit breakers react to distress.
- **The `background` profile and adaptive cadence** (FR-COLL-05, M4). `profiles.background` is accepted and
  ignored.
- **Cloud Logging and Cloud Storage budgets.** `budgets.logging` and `budgets.gcs` are ignored, because no
  collector reads those APIs yet (ADR-0015).
- **The series budget** (NFR-OBS-06). Series are counted, not limited (ADR-0014).
- **The `interactive` priority class** (§7.11 item 2). M1 has no user-initiated outbound call, apart from the
  doctor.

### Confirmation

- `packages/application/test/collection/engine-budget.test.ts`: "NFR-OBS-01: never admits more than the
  per-minute budget in any 60 s window", priority order, background yielding, deadlines, concurrency, and the
  hard maxima clamp.
- `packages/application/test/collection/engine.test.ts`: "NFR-OBS-05: greedy collectors never exceed a budget in
  any 60 s window", the per-cycle maximum, `Retry-After`, full-jitter backoff and VPC Service Controls parking.
- `packages/adapters/config-file/test/`: FR-SETUP-05 defaults, tier profiles, and budgets above a hard maximum
  rejected with a message that names the maximum.

## Pros and Cons of the Options

### Sliding-window budgets, priority gate and profiles

- Good, because "at most N in any 60 s" is the exact property NFR-OBS-01 states, and a fake clock can check it.
- Good, because a deadline per request turns "no budget left" into reduced fidelity instead of a growing queue.
- Bad, because the engine keeps one timestamp per token taken in the last minute (at most the budget: 120 at
  the hard maximum).

### Classic refilling token bucket with a burst capacity

- Good, because it is the textbook algorithm and needs only a counter and a timestamp.
- Bad, because a full bucket plus the refill admits up to twice the rate within one minute, which breaks
  NFR-OBS-01.

### Rate limiting inside `@dcam/http-guard`

- Good, because every request already passes through the guard, so nothing could bypass the limit.
- Bad, because the guard does not know collectors, priorities, cycle deadlines or profiles. It would have to
  delay or refuse requests blindly, and it could not report reduced fidelity.
- Bad, because the guard is the security choke point (ADR-0006). Mixing scheduling policy into it makes it harder
  to review.

### Cadences only

- Good, because it is the simplest: one request per cycle and the cadence sets the rate.
- Bad, because paging and window splitting make the number of requests per cycle depend on the data (`af.facts`
  splits a window until each part fits in one page). A cadence alone does not bound the rate.

## More Information

- Spec §7.7 (cadences), §7.10 (quotas), §7.11 (observer budget), §17.2 (`profiles`, `budgets`).
- Feature 002: `specs/002-coll-live-mode/spec.md` lists patient mode and FR-COLL-05 as follow-ups.
- The M1 spike (§22.5) measures real request counts with the health page and may lower the defaults (VC-03,
  VC-08).
