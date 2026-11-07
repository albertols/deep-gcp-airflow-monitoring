# Feature 007: why is work waiting, in depth

- **Epic / milestone:** BOTL, ENV · M3 "Why is work waiting?" demo steps 2–4 (spec §22.2 L4627, §22.6 L4743–4746)
- **Requirements:** FR-BOTL-01 (top contributors), FR-BOTL-03, FR-BOTL-06, FR-ENV-08, HM-006, HM-009, HM-017,
  HM-023, HM-024 (blocked), FR-UI-05, FR-UI-07, FR-UI-08, NFR-PERF
- **Status:** implemented (browser validation and code review pending); HM-024 blocked

## Intent

The bottlenecks page (S-16) already answers which HM-006 reason held most waiting. This feature adds the
evidence behind the answer: who contributed to each reason (DAGs and pools), which DAGs are associated with
longer queue waits for others (HM-017), how each pool ran and starved (FR-ENV-08), whether low-priority work
waits longer than high-priority work in the same pool (HM-023, observable part), and a new schedule
intelligence page (S-17) with the planned and actual start heatmap (HM-009, FR-BOTL-03).

## Requirements extracted from docs/spec/dcam-spec.md

- **HM-006 output** (L1086–L1089): "Stacked waiting task-minutes per reason, per environment, pool, DAG and
  hour. Top contributors per reason."
- **FR-BOTL-01** (L1700): "… stacked chart and top contributors."
- **HM-017** (L1133–L1145): for each candidate DAG D, compare other DAGs' queue wait (HM-001) in minutes when D
  occupies ≥ 10 % of slots with matched minutes when D is inactive, matched by hour of week, over 28 days.
  Effect = difference in median wait; bootstrap 95 % CI with 1,000 resamples; rank D by effect × affected
  task-minutes; only DAGs with ≥ 60 active minutes and ≥ 200 affected tries qualify. Association, not
  causation: the UI says "associated with"; the evidence shows overlap windows and the CI.
- **FR-BOTL-06** (L1705): rank DAGs by association with increased queue wait of other DAGs; show overlap
  windows, effect size, confidence.
- **FR-ENV-08** (L1654): "Pools tab: slots, occupied, running, queued, scheduled, open, deferred; starvation over
  time; top DAGs per pool. — When a pool has zero open slots and queued work for longer than the threshold, the
  system shall flag starvation."
- **HM-023** (L1158–L1166): group tries by effective `priority_weight` band (quantiles within the pool); compare
  each band's p95 queue and pre-queue wait with its own 28-day median during periods when higher bands ran;
  starvation ratio = current p95 ÷ baseline median. ⚠️ VERIFY (VC-14, L4691) that the API's weight is the
  effective one.
- **HM-009** (L1237–L1248) and **FR-BOTL-03** (L1702): minute-of-hour × hour-of-day density of planned and actual
  run starts; most colliding schedules; REC-SCHED-01 (L2896) when ≥ 20 % of daily starts fall in one minute.
- **S-17** (L2456): route `/env/{env}/schedule`; this SPA's hash routes drop the `/env/{env}` prefix and carry
  the environment as `?env=` (as S-16 does), so the page is `#/schedule?env=…`.
- **HM-024** (L1278–L1285): for `catchup=True` DAGs count the intervals between the next data interval start and
  now; detect storms (≥ 10 runs created within 10 minutes with past logical dates); backfill runs separately.
- **§8.1, §8.9, §12.7, §12.10**: units, estimates labelled, gaps never zero, p95 needs ≥ 20 samples, states.

## User stories and acceptance criteria

1. **Top contributors.** As an operator I see, for each reason, the DAGs and the pools that waited most, with
   their share of that reason. AC: shares per reason sum to ≤ 1; pools are listed for every reason.
2. **Noisy neighbours (HM-017).** As an operator I see DAGs whose heavy running coincides with longer queue
   waits of other DAGs, with effect, 95 % CI, confidence, affected tries and overlap windows, worded as
   "associated with". AC: DAGs below 60 active minutes or 200 affected tries never appear; the panel says why
   nothing qualified; without worker slots (unknown `worker_concurrency`) it says "not evaluated".
3. **Pools (FR-ENV-08).** Per pool: slots, running slots (mean and peak), queued slots (mean), ready and queued
   waiting task-time, starved minutes over time, top DAGs. AC: buckets without snapshots are gaps, not zero.
4. **Priority fairness (HM-023, observable part).** Per pool with more than one priority weight: bands with
   tries, observed wait p50 and p95 (max and "low sample" under 20). AC: pools with one weight say so; the
   starvation ratio is shown as not evaluated with its reason.
5. **Schedule intelligence (S-17).** Planned and actual start heatmaps (UTC), collision index against the
   REC-SCHED-01 threshold, most colliding minutes and schedules, REC-SCHED-01 findings linked. AC: a table view
   for each heatmap; navigation entry; demo shows the minute-0 collision.
6. **Performance.** The bottleneck analysis over 7 days at 2,000 DAGs with snapshots every 60 s answers in
   under 2 s in the application layer.

## Method decisions (DCAM's, where the spec is silent)

- **HM-017 window.** The selected range (at most 24 h today), not 28 days: raw snapshots and samples have
  retention limits and the range is what the page analyses. Within a day, hour-of-week matching is
  hour-of-day matching. Method tag `HM-017/range`.
- **HM-017 slots.** Executor slots = workers × `worker_concurrency` per minute, from Cloud Monitoring worker
  samples, else the live snapshots' worker count. D's occupancy in a minute = its executor slot-seconds ÷ 60.
  Active: ≥ 10 % of slots; inactive: no running try of D in the minute; minutes in between are not compared.
- **HM-017 matching.** Other DAGs' tries are assigned to the minute they were queued. Only hour-of-week strata
  with both active and inactive tries count; inactive tries are re-weighted to the active tries' strata mix.
  Effect = median(active) − weighted median(inactive).
- **HM-017 ranking.** ⚠️ "effect × affected task-minutes" is read as effect (minutes) × affected tries: the
  associated extra waiting in task-minutes. Confidence: high when the CI excludes 0 and ≥ 80 % of the active
  minutes' tries were matched, medium when the CI excludes 0, otherwise low. The bootstrap resamples at most
  1,000 tries per group (seeded, deterministic), so the CI is conservative for larger groups; it runs for the
  ten highest-ranked DAGs only. Control tries ≥ 200 is required as well.
- **Pools.** "Starved" = zero open slots while ready work waited for the pool (as REC-CONC-02). Deferred slots
  are not in DCAM's snapshots (the `af.live` pool state has running, queued and open only) and are not shown.
- **HM-023 observed wait.** Per waiting try in the snapshots: last time seen waiting − first known ready or
  queued time; a lower bound at snapshot resolution. Bands: tertiles of the tries' weights within the pool.
- **Actual run start.** DCAM stores no DAG runs: a run's actual start is its first try start.
- **Time zone.** Heatmaps are UTC: DCAM does not collect DAG time zones (cron times are evaluated in UTC,
  `schedule.ts`).

## Blocked

- **HM-023 starvation ratio.** Needs each band's 28-day baseline median "during periods when higher bands ran".
  DCAM's snapshots list only waiting task instances (with `priority_weight`); running tries carry no weight
  (`StoredTaskTry` has none), so "higher bands ran" cannot be observed, and the range is at most 24 h. Unblocks
  with a weight on stored tries (af.facts) and daily rollups.
- **HM-024 catchup and backfill storm risk.** Inputs missing: (1) `catchup` per DAG: `GET /dags` does not return
  it (only `DAGDetail` does, Airflow 2.11.1 `v1.yaml`), so `af.inventory` stores the `catchup_by_default`
  stand-in (`packages/application/src/collection/collectors/mapping.ts`); (2) the next data interval start
  (`next_dagrun_data_interval_start`, ⚠️ VERIFY that `GET /dags` returns it on 2.11.1) and `start_date` are not
  collected; (3) DCAM stores no DAG runs (`run_type`, logical date, creation time), so storms cannot be
  detected. Unblocks with an `af.inventory` details refresh and an `af.runs` collector (collector owners).

## Out of scope

FR-BOTL-04 stagger preview and FR-BOTL-05 forecast; a separate S-10 pools route (pools are a section of S-16);
HM-012 changes (scale-up lag already exists); 28-day baselines; DAG time zones.
