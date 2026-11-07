# Feature 009: environment capacity, load heatmap and 24-hour forecast

- **Epic / milestone:** ENV, DAGX, BOTL · M3 "Capacity and pools" (spec §22.6 L4745)
- **Requirements:** FR-ENV-02, FR-DAGX-06, FR-BOTL-05, HM-010, HM-011, HM-012, HM-032 (reuse), NFR-OBS-06,
  NFR-DATA-03, NFR-PERF
- **Scope:** backend only (domain, application, contract, server). The S-04 panels and the forecast panel are a
  later web task.
- **Status:** implemented; web panels pending

## Requirements extracted from docs/spec/dcam-spec.md

- **FR-ENV-02** (L1648): "Capacity tab: slot capacity versus used (workers × concurrency, parallelism, pools),
  queued tasks, worker count versus min and max, scale events, CPU and memory per workload type (usage versus
  limit), saturation heatmap (hour of day × day). — While workers are at `max_count` and tasks are queued, the
  system shall highlight the period as 'capacity-bound'."
- **S-04** (L2443): route `/env/{env}/capacity`, answers Q-04, requirements FR-ENV-02, FR-BOTL-09.
- **HM-011** (L1104–L1118): capacity = workers × `worker_concurrency`; used = `executor/running_tasks`,
  cross-checked with live running task instances; capacity-bound minutes = workers = `max_count` and queued ≥
  max(10, 20 % of capacity); shown as series, an hour-of-day heatmap and the share of capacity-bound minutes.
- **HM-012** (L1120–L1129): scale-up lag, time at `max_count`, scale-down events.
- **HM-032** (L1187–L1205): inferred values are never shown as configured values; provenance labels.
- **FR-DAGX-06** (L1666): "DAG × hour-of-day load heatmap for the top N DAGs. — The system shall render the
  heatmap from 5-minute rollups."
- **HM-010** (L1250–L1260): for each planned run, add the DAG's historical run occupancy profile (slot demand per
  minute since run start) at its planned start, p50 for the central forecast, p10 and p90 for the band; add an
  hour-of-week baseline for unscheduled demand; compare with capacity at `max_count` and with pool sizes;
  overlay the maintenance window. Requires ≥ 14 days of history per DAG, otherwise its contribution is labelled
  low confidence.
- **FR-BOTL-05** (L1704): "24-hour load forecast (HM-010): expected slot demand from schedules and historical
  duration profiles versus capacity; predicted saturation windows. — The system shall display forecast
  uncertainty bands and the history window used."
- **REC-SCHED-03** (L2898): "Forecast demand exceeds capacity at maximum for ≥ 15 min in the next 24 h (HM-010)
  → Stagger or raise capacity before the window", M4.
- **NFR-OBS-06** (L1890): Cloud Monitoring series budget; every query reduces to one series.
- **§8.9** (L1496), **§12.8** (L2594): p95 needs ≥ 20 samples; gaps are never zero; estimates are labelled.

## User stories and acceptance criteria

1. **Capacity over time (FR-ENV-02, HM-011).** As an operator I see, per bucket, workers (mean, max, target)
   against `min_count` and `max_count`, worker slots, running and queued task instances, running tries from task
   history (the cross-check), utilisation, worker CPU and memory against their limits, and capacity-bound
   minutes. AC: buckets without data are `null`, never zero; the worker figures say where they came from
   (`slots_source`: `monitoring | config | hostnames`); with `worker_concurrency` unknown, slots and
   capacity-bound minutes are `null` with the reason.
2. **Capacity-bound periods.** AC: stretches of minutes with workers at `max_count` and queued ≥ max(10, 20 % of
   slots) are listed with start, end, minutes and peak queued; the demo's 01:30 UTC batch window is one.
3. **Scale events (HM-012).** AC: worker count changes from Cloud Monitoring samples, counted up and down;
   without samples, "not evaluated" with the reason (hostname counts are lower bounds and move with idle workers).
4. **Saturation heatmap.** AC: UTC day × hour cells with observed minutes, utilisation mean, minutes at
   `max_count` and capacity-bound minutes; unobserved cells are `null`.
5. **Limits and pools.** AC: `worker_concurrency` and `parallelism` with their provenance (`limitSources`), worker
   slots at `max_count`, and per pool its slots against running and queued slots from live snapshots.
6. **Workloads.** AC: worker CPU and memory utilisation (p50, p95 only with ≥ 20 samples, max); the other
   workload types are listed as not collected.
7. **DAG × hour-of-day load (FR-DAGX-06).** AC: top 20 DAGs by executor slot-seconds; per UTC hour of day the
   mean slots each held over the hours of history; hours without history are `null`.
8. **24-hour forecast (HM-010, FR-BOTL-05).** AC: p10, p50, p90 demand per 5-minute step, the baseline part,
   capacity at `max_count` and `parallelism`, saturation windows (p50 above capacity ≥ 15 min) and risk windows
   (p90), each with its top DAGs; per-DAG history days and a low-confidence label under 14 days; the history
   window used; per-pool peaks against pool sizes. The demo forecast shows the 01:30 UTC batch window and says
   that it is low confidence (48 h of demo history).
9. **Performance.** Capacity over 7 days and the forecast over 28 days of history each use under 2 s of CPU at
   2,000 DAGs and 20,000 tries a day in the application layer.

## Method decisions (DCAM's, where the spec is silent)

- **Per-minute worker figures.** A minute takes the Cloud Monitoring worker sample when there is one, else the
  last live snapshot in it (its `workers.source`). Minutes with neither are gaps.
- **Scale events** come from Cloud Monitoring samples only.
- **Demand** (forecast) = running plus executor-queued task instances: a try wants a slot from its queued time
  (else its start) to its end, as HM-012 defines demand. Ready (`scheduled`) time is not included: Airflow 2.11
  does not record it.
- **Run profiles.** Scheduled runs only (`run_id` prefix `scheduled__`, Airflow's `DagRunType.SCHEDULED`); a run
  starts at its first try's queued (else start) time; runs that are still running or start before the history read
  are left out; profiles are cut at 24 h. p10, p50 and p90 are taken per minute since run start across runs
  (finished runs count as zero). The band sums per-DAG percentiles, which assumes DAGs move together: it is wider
  than an independent band.
- **Planned runs** are the cron times of unpaused DAGs in UTC (DCAM does not collect DAG time zones), from 24 h
  before now (runs still going) to 24 h ahead. Timedelta, asset and manual schedules are not expanded: their demand
  is in the baseline.
- **Baseline** (unscheduled demand): mean demand per UTC hour of week from non-scheduled runs and from DAGs
  without a cron schedule, over the covered hours; an hour of week never observed falls back to the hour of day.
  Its mean is added to p10, p50 and p90 alike.
- **History days** of a DAG = now − its first try in the 28-day read (never before the environment's history
  start). Under 14 days: low confidence. The forecast is low confidence overall when at least half of its p50
  slot-minutes come from low-confidence DAGs.
- **Pools** forecast from scheduled runs only (pool slots per try), p50.
- **Capacity range.** `1h | 6h | 24h | 7d` (buckets 1 min, 5 min, 15 min, 1 h), aligned to UTC.

## Not wired

- **REC-SCHED-03.** The catalog row is not a complete rule: it does not say whether "≥ 15 min" is one stretch or a
  total (REC-CAP-01 has the same ambiguity, `advisor-rules-capacity.ts`), which forecast (p50 or the band) must
  exceed capacity, nor its severity, impact model or confidence gate (§13.1), and it is M4. The forecast reports
  `saturation.windows` (p50, one stretch ≥ 15 min) so the rule can read them once defined.
- **Maintenance window overlay** (HM-010): DCAM does not collect the maintenance window yet.
- **CPU and memory of other workload types** (scheduler, triggerer, DAG processor, web server): `mon.core` reads the
  Celery worker workload only. Adding them needs a store table and a cadence decision under NFR-OBS-06 (4 types × 2
  metrics at 60 s ≈ 350,000 series a month, a third of the free tier; at 300 s ≈ 70,000). The `type` label values
  of `cloud_composer_workload` are undocumented (⚠️ VERIFY).
- **5-minute rollups** (FR-DAGX-06): the store has none; the heatmap is computed from task tries (plan.md).

## Out of scope

Web panels (later task); FR-BOTL-09 failure correlation after scale-down (HM-018); HM-027 packing quadrants;
HM-032 inference of `parallelism` from executor metrics (not collected); DAG time zones.
