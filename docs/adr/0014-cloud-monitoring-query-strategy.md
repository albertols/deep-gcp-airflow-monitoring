---
status: proposed
date: 2026-11-07
decision-makers: DCAM maintainers
consulted: Claude Code (documentation subagent)
informed: contributors
---

# Cloud Monitoring: `timeSeries.list` with server-side alignment and reduction, no MQL

## Context and Problem Statement

Composer exports about 128 metric types on three monitored resource types (spec §7.2, Appendix A). Since
2025-10-02 Cloud Monitoring bills API reads per time series returned: $0.50 per million, with the first million
a month free (§7.2;
[pricing examples](https://cloud.google.com/stackdriver/observability-pricing-examples); whether the free tier
is per billing account is ⚠️ VERIFY, §7.10). The request quota per project is shown only in the console
(⚠️ VERIFY, VC-03). Google ended customer support for MQL in July 2025 and marks `timeSeries.query` as deprecated
([MQL](https://docs.cloud.google.com/monitoring/mql)). Which API and query shape does DCAM use to read Composer
metrics (NFR-OBS-03, NFR-OBS-06, FR-COLL-07)?

## Decision Drivers

- Fewest time series returned, because series, not requests, are what reads cost (NFR-OBS-06)
- Few requests: at most 30 a minute per project by default (NFR-OBS-03, ADR-0007)
- No point shown as final before its ingestion delay has passed (FR-COLL-07)
- One read-only REST path that the guarded client can allow and check (ADR-0006)
- No deprecated query language

## Considered Options

- `projects.timeSeries.list` with server-side alignment and cross-series reduction by default; the
  Prometheus-compatible PromQL API only where it saves calls; no MQL
- The PromQL API as the main path
- MQL through `timeSeries.query`
- Raw points without alignment or reduction, aggregated by DCAM

## Decision Outcome

Chosen option: "`timeSeries.list` with server-side alignment and reduction", because a reducer turns many series
into one before they are billed, and the method is a plain `GET` that the allowlist already admits.

What the code does today:

- **The port.** `MonitoringApi.series(query)` in `packages/ports/src/sources.ts` takes a project, a metric type, a
  resource type, exact-match resource and metric labels, a closed interval, an alignment period, an aligner, and
  an optional reducer with group-by fields.
- **The adapter** (`packages/adapters/gcp/src/monitoring-api.ts`) sends
  `GET https://monitoring.googleapis.com/v3/projects/{project}/timeSeries` with `view=FULL`:
  - The filter always names both `metric.type` and `resource.type`, because every Composer metric is also
    published under an `internal_composer_*` resource type (§7.2). Label values are quoted and escaped, and label
    keys must be identifiers.
  - It refuses an alignment period under 60 s, or one that is not whole seconds, before any request. The
    alignment period "must be at least 60 seconds"
    ([`Aggregation`](https://docs.cloud.google.com/monitoring/api/ref_v3/rest/v3/projects.alertPolicies#Aggregation)).
  - It follows `nextPageToken` for up to 20 pages, then fails with a non-transient error rather than return a
    partial result. Series with the same labels are merged across pages.
  - `executionErrors` in a response, which mean the data may be incomplete, fail the call as a transient error,
    so the circuit breaker backs off (ADR-0007).
  - It sends `x-goog-user-project` for the quota project (`packages/adapters/gcp/src/google-request.ts`,
    FR-AUTH-04).
- **The `mon.core` collector** (`packages/application/src/collection/collectors/mon-core.ts`) reads worker count,
  scale target, executor running and queued tasks, and worker CPU and memory into one sample per minute, plus the
  HM-028 health inputs:
  - Every query reduces across series (`REDUCE_MAX`, `REDUCE_SUM` or `REDUCE_MEAN`), so each returns one series.
    The exception is the first cycle's query grouped by `resource.labels.type`, which finds the Celery worker
    workload type. Google does not document the values of that label (⚠️ VERIFY).
  - Windows end on a minute boundary at now minus 120 s (database metrics: 180 s), each cycle re-reads the
    trailing 10 minutes, and the first window covers an hour (FR-COLL-07).
  - Health inputs are read every 5 minutes: health ratios with `ALIGN_FRACTION_TRUE` at 300 s over 4 hours,
    database maxima at 3,600 s over 12 hours, zombie kills summed over 24 hours, and parse time over 1 hour.
    Worker CPU and memory limits are read hourly. One cycle makes at most 16 requests.
- **Series counting.** Each query reports how many series it returned (`countSeries`). The engine keeps a
  rolling 24-hour sum per environment (`RollingSum` in `packages/application/src/collection/footprint.ts`),
  served as `series_24h` by `GET /api/v1/collection` and shown on the DCAM health page.
- **The allowlist** (`packages/adapters/http-guard/src/allowlist.ts`) admits `GET` on `timeSeries`,
  `metricDescriptors` and `monitoredResourceDescriptors` (`monitoring.read`) and on the PromQL `query`,
  `query_range`, `series` and `labels` paths (`monitoring.promql`). It has no `POST` entry for Monitoring, and its
  path pattern does not match the `timeSeries:query` method.

### Consequences

- Good, because one environment on `standard` costs about 10,700 series a day, or about 321,000 a month.
  Estimate from the query counts in `mon-core.ts`: 6 one-series queries a minute, 7 health queries every
  5 minutes and 2 limit queries an hour. Three environments fit the free tier; the M1 spike measures the real
  number (VC-03).
- Good, because `mon.core` makes about 7.4 requests a minute per environment on `standard` (same estimate), so
  the default per-project budget of 30 a minute covers about four environments in one project.
- Good, because a query that would need more than 20 pages fails visibly instead of storing a partial result.
- Bad, because `mon.core` queries each environment on its own, with an exact `environment_name` filter. §7.2
  batches one request per metric type and project for every monitored environment there
  (`resource.labels.environment_name = one_of(…)`). Several environments in one project therefore cost more
  requests than they need, though not more series.
- Bad, because series are counted, not limited. The monthly series budget, the per-project and per-day count,
  and the month-to-date cost estimate of NFR-OBS-06 are not built. Today every query is reduced to one series,
  so the risk is a future query without a reducer; code review is the only check.

Not implemented yet:

- **The series budget** (NFR-OBS-06): a configurable monthly budget, default 1,000,000 per workspace, with
  reduced fidelity when it is reached (FR-COLL-06).
- **Discovery** with `metricDescriptors.list` and a capability map (§7.2, §7.1 rule 2). The endpoint is
  allowlisted but not called. A metric with no data shows as "no data", never as zero (NFR-DATA-03).
- **`mon.slow`**: workflow (per DAG and per task) metrics, only for DAGs in view or the top N by slot-seconds
  (§7.2, "Cost").
- **PromQL.** Allowlisted, unused. When it is used, every selector must set `monitored_resource` (§7.2).

### Confirmation

- `packages/adapters/gcp/test/monitoring.test.ts`: the documented query parameters, filter escaping, alignment
  periods under 60 s refused before any request, paging and the page cap, and `executionErrors`.
- `packages/application/test/collection/mon-core.test.ts`: "FR-COLL-07: the window ends at now minus the 120 s
  ingestion delay", the trailing re-read, and "NFR-OBS-06: counts every series returned and reduces across series
  wherever detail is not needed".
- `packages/application/test/collection/engine-status.test.ts`: `series_24h` per environment, `null` without
  Monitoring.
- `packages/adapters/http-guard/test/guarded-client.test.ts`: only allowlisted Monitoring reads pass.

## Pros and Cons of the Options

### `timeSeries.list` with alignment and reduction

- Good, because `crossSeriesReducer` with `groupByFields` returns exactly the detail DCAM needs, and nothing it
  would be billed for and then discard.
- Good, because it is a documented, stable `GET` with explicit parameters that tests can assert.
- Bad, because arithmetic across metrics (for example CPU usage divided by reserved cores) happens in DCAM, one
  query per metric.

### The PromQL API as the main path

- Good, because one PromQL expression can combine metrics, which can save requests.
- Bad, because every selector must name `monitored_resource` to avoid the `internal_composer_*` duplicates
  (§7.2), a rule that is easy to miss in hand-written expressions.
- Bad, because DCAM would build and escape query strings in a second language, with a second result format.

### MQL through `timeSeries.query`

- Good, because it once offered joins and arithmetic in one call.
- Bad, because customer support ended in July 2025 and the method is deprecated.

### Raw points aggregated by DCAM

- Good, because DCAM controls every aggregation step.
- Bad, because without a reducer each worker workload is its own series, so cost grows with the number of
  workers, and responses grow with every point.

## More Information

- Spec §7.2 (Cloud Monitoring), §7.7 (`mon.core` and `mon.slow` cadences), §7.10 (quotas and cost), Appendix A
  (metric catalog).
- Method reference: https://docs.cloud.google.com/monitoring/api/ref_v3/rest/v3/projects.timeSeries/list
- Metrics list (Composer section): https://cloud.google.com/monitoring/api/metrics_gcp_c#gcp-composer
- Open question OQ-07 (spec §25) records the same default: `timeSeries.list` first, PromQL where it reduces
  calls.
