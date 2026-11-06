---
status: proposed
date: 2026-11-07
decision-makers: DCAM maintainers
consulted: Claude Code (documentation subagent)
informed: contributors
---

# Cloud Logging: metrics first, bounded and budgeted `entries.list` polling, no tailing

## Context and Problem Statement

Composer writes its logs to Cloud Logging under the `cloud_composer_environment` resource type, and on Composer 3
task logs are stored only there, not in the environment bucket (spec §7.3, confirmed). Signals such as `HM-018`
(OOM kills, evictions, zombies) and the incident workspace (FR-INC-03) want log samples and attribution: which
DAG, task or worker. The binding constraint is the read quota. `entries.list` allows 60 requests a minute per
project, the quota cannot be increased, and every reader of that project's logs shares it. A request names at
most 100 resources, and live tailing is limited to 10 sessions per project (§7.3, confirmed 2026-11;
[Logging quotas](https://docs.cloud.google.com/logging/quotas)). How does DCAM read logs without starving the
other readers of that quota (NFR-OBS-02)?

## Decision Drivers

- Use a small, fixed share of a quota DCAM cannot raise: 20 % by default, never more than 50 % (NFR-OBS-02)
- Counts come from metrics where they exist; logs give samples and attribution only (NFR-OBS-02)
- Every query is bounded: resource, log names, closed time window, severity floor, indexed labels (§7.3)
- Log content is redacted at ingest, and only bounded samples are stored (§18.6, FR-INC-03)
- Read-only: `entries:list` is a `POST` read, admitted only with body validation (§18.2)

## Considered Options

- Metrics first; bounded, budgeted `entries.list` polling with watermarks; no tailing; user-managed sinks as an
  option for heavy log analysis
- Live tailing with `entries.tail`
- Logs as the main source of event counts
- Require a user-managed log sink (BigQuery or Log Analytics) and read only that

## Decision Outcome

Chosen option: "Metrics first; bounded, budgeted `entries.list` polling; no tailing", because it keeps DCAM's
share of an unadjustable, shared quota small and predictable, and Composer metrics already count the events
that matter.

**Not implemented yet.** M1 has no Cloud Logging reader. Logging is a core source from M4 (§7.1, `SRC-LOG`). What
exists today:

- **No adapter, port or collector.** `packages/adapters/gcp/src/` has the Composer and Monitoring clients only,
  `packages/ports/src/sources.ts` has no Logging port, and `CollectorId` in
  `packages/application/src/collection/types.ts` has no `log.signals`. The contract's `SourceId` and
  `ApiFootprint.api` enums in `packages/contracts/openapi.yaml` have no Logging value.
- **Configuration.** `budgets.logging` is accepted and ignored (`NOT_USED_YET` in
  `packages/adapters/config-file/src/schema.ts`).
- **The allowlist is ready.** `packages/adapters/http-guard/src/allowlist.ts` admits `POST /v2/entries:list` on
  `logging.googleapis.com` only when the body has nothing but `resourceNames`, `filter`, `orderBy`, `pageSize`
  and `pageToken`, with at least one resource name (`isLoggingListBody`). It also admits
  `GET /v2/projects/{project}/logs` for log-name discovery. It has no tail entry.
- **Metrics first already holds.** `mon.core` reads zombie kills from `environment/zombie_task_killed_count`
  (HM-028), and `af.inventory` reads import errors from the Airflow API, not from logs.

What DCAM builds when the Logging reader arrives (§7.3, §7.7, §7.11):

- **Budget.** One budget per (project, Logging API), shared fairly by the project's environments. Defaults:
  12 requests a minute on `live` and `standard`, 6 on `eco`, 3 on `background`; hard maximum 30 (50 % of the
  quota). It joins the engine's gates (ADR-0007).
- **Counts from metrics** (§7.3 table): OOM kills from `environment/health/container_restart_count` by `reason`,
  evictions from the pod event and eviction metrics, zombies and externally killed tasks from their scheduler
  metrics, and import errors from the Airflow API.
- **Narrow queries.** Each filter names `resource.type`, the environment name, explicit log names, a closed time
  window, a severity floor and indexed label filters. Full-text matching happens only inside these bounds
  (Appendix C).
- **Log names discovered** with `logs.list`, apart from the confirmed `airflow-scheduler`, `airflow-worker`,
  `airflow-webserver` and `dag-processor-manager`. Other names, such as the Composer 3 OOM-event and start-up
  failure logs, are ⚠️ VERIFY (VC-06).
- **Polling, not tailing.** A `log.signals` collector (2-minute cadence on `standard`, §7.7) reads from a
  timestamp watermark with a 10-minute overlap and drops duplicates by `insertId`. Backfills resume from
  watermarks, because page tokens expire after 24 hours.
- **Redaction and samples.** Entries are redacted at ingest, and only bounded samples are kept, for 30 days by
  default (§18.6).
- **User-managed sinks.** For log-heavy analysis, the documentation recommends that the user route logs to
  BigQuery or Log Analytics with their own sink (OQ-09). DCAM never creates or changes a sink; the allowlist
  forbids it.
- **One task's log** comes from the Airflow API (`GET …/logs/{try_number}`) on demand only (FR-TASK-06), not from
  Cloud Logging.

### Consequences

- Good, because DCAM leaves at least half of the project's quota to other readers, and 80 % by default.
- Good, because event counts come from metrics, which are cheaper and complete. The 20 % share is spent on
  samples and attribution.
- Bad, because log-based attribution (which DAG or worker an OOM kill hit) waits for M4, and its delay is at least
  one `log.signals` cycle.
- Bad, because the guard's body check covers keys only. The narrow-query rules (closed window, log names,
  severity) and limiting `resourceNames` to the configured projects must be enforced and tested in the adapter.
  Narrowing `isLoggingListBody` to the configured projects is a candidate guard change that needs security
  review (§18.2 rule 6).
- Neutral: Composer 3 task-log retention depends on the log bucket, 30 days by default for `_Default` (§7.3).
  DCAM's samples cannot outlive the source by much.

### Confirmation

- Today: `packages/adapters/http-guard/test/guarded-client.test.ts`. "Allows Cloud Logging entries:list only
  with a valid read body" also proves that `entries:write` is refused, and "rejects 3xx responses instead of
  following them" proves that a redirect from `entries:list` is not followed.
- When the reader is built: a fake-clock test that the Logging budget never exceeds its share in any 60 s window
  (NFR-OBS-02, NFR-OBS-05), and adapter tests that every filter names a closed window, explicit log names and a
  severity floor. Each test names its requirement ID.

## Pros and Cons of the Options

### Metrics first; bounded, budgeted `entries.list` polling

- Good, because the request rate is fixed by the budget, whatever the log volume.
- Good, because watermarks and `insertId` make polling restartable and idempotent.
- Bad, because polling adds up to one cycle of delay, and tight filters can miss entries whose text changes
  between Airflow versions (VC-06 checks the message texts).

### Live tailing with `entries.tail`

- Good, because new entries arrive within seconds.
- Bad, because the project has at most 10 tailing sessions, shared with every other reader.
- Bad, because a long-lived stream per environment cannot be metered by DCAM's request budgets, and the
  allowlist has no entry for it.

### Logs as the main source of event counts

- Good, because one source would explain both the count and the cause.
- Bad, because counting from logs needs many more `entries.list` calls than reading one metric, on a quota that
  cannot grow.
- Bad, because a count from paged, sampled logs can be incomplete without saying so.

### Read only a user-managed log sink

- Good, because SQL over BigQuery or Log Analytics avoids the `entries.list` quota and keeps logs longer.
- Bad, because a sink must be created in the customer's project, which is a write DCAM never makes (P-1), and it
  adds storage and query costs.
- Bad, because many users cannot create sinks, so DCAM would have no log signals for them.

## More Information

- Spec §7.3 (Cloud Logging), §7.7 (`log.signals`), §7.10 and §7.11 (quotas and budgets), §18.2 (allowlist),
  §18.6 (retention of samples), Appendix C (query library).
- M1 spike items VC-06 (log names and message texts) and VC-07 (task log labels such as `task-id` and
  `map-index`, ⚠️ VERIFY).
