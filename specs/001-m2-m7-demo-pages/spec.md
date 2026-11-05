# Feature 001: demo-mode pages for M2–M7

- **Epic / milestone:** DAGX, DAGD, BOTL, FLEET, ADV, WIKI, ALRT · first slices of M2–M7
- **Requirements:** FR-DAGX-01..04/07, FR-DAGD-01..04, FR-BOTL-01/02/07/09, HM-001/003/005/006/011/012/015/021/028,
  FR-FLEET-01/02, FR-ADV-01..04/08, REC-CAP-01/05/08, REC-CONC-01..04, REC-DAG-01/05, REC-SCHED-01,
  FR-WIKI-01/05/06/07, FR-ALRT-01/02/06, FR-UI-05/06/07/08, FR-EMU-01/03
- **Status:** in progress

## Intent

Every page in the navigation works in demo mode (`pnpm dcam --demo`): real domain logic, through the API
contract, over a simulated environment. Real Google Cloud data arrives with the M1 collectors, which fill the
same ports. The league table (M2) and bottlenecks (M3) get the most depth because they are the #1 priority.

## User stories

- As a platform engineer, I want every DAG ranked by the executor capacity it consumes, so that I tune the few
  DAGs that matter (FR-DAGX-01..03).
- As a platform engineer, I want waiting task-minutes attributed to the limit that binds, so that I change the
  right setting (FR-BOTL-01, HM-006).
- As a team lead, I want a fleet view with an explainable health score per environment (FR-FLEET-01/02, HM-028).
- As an engineer, I want ranked findings with evidence and copy-paste snippets that I apply myself (FR-ADV-01..04).
- As a newcomer, I want a wiki that explains the concepts behind every number (FR-WIKI-01/05/07).
- As an on-call engineer, I want local alerts with history while DCAM runs (FR-ALRT-01/02/06).

## Requirements extracted from docs/spec/dcam-spec.md (line numbers refer to that file)

### Cross-cutting

- **FR-UI-05** (L1628): every metric, chart, KPI, config option and finding has an (i) explanation with definition,
  formula, source, freshness and a docs link; the UI test suite fails if a registered panel has none. Fields
  (§12.9 L2608–2630): `id, title, summary, whyItMatters, formula, howToRead, sources, freshness, caveats[],
related[], docs[], appliesTo`.
- **FR-UI-07** (§12.10 L2632–2643): loading (skeleton), empty (reason plus next step), partial, stale, error states;
  demo data shows a persistent banner. **FR-UI-08**: provenance footer (sources, data as of) on every panel.
- **§8.1** (L921–933): values carry unit, `approximate`, method, confidence; approximate values show "≈".
- **§12.7/§12.8**: tabular figures, right-aligned numbers, durations like `1h 12m`; units on axes; gaps never
  drawn as zero (NFR-DATA-03); estimates labelled (NFR-DATA-04); charts have a title, an accessible description
  and a "view as table" option.
- **§8.9** (L1501): p95 needs ≥ 20 samples, otherwise show the max and "low sample".
- **§20.6** (L4157–4180): demo workspace "acme" with `acme-dev`, `acme-test`, `acme-prod`; deterministic per seed,
  anchored to a fake "now"; stories include pool starvation, a noisy neighbour and collisions at round hours.

### DAG league table (M2), S-11, and DAG detail, S-12

- **FR-DAGX-01**: inventory with virtualised rows, filter and sort; facets tags, owners, team, schedule type.
  INP ≤ 200 ms at 5,000 DAGs (NFR-PERF-03).
- **FR-DAGX-02**: columns runs, success rate, failed runs, retries, p50/p95 run duration, slot-seconds, share,
  peak concurrent TIs, p95 queue wait, change vs previous period, open findings; the comparison period is shown.
  Wireframe: `DAG | Runs | Succ. | p95 dur | Slot-h | Share ▼ | p95 queue | … | Findings`.
- **Default sort**: share of executor slot-seconds, descending.
- **FR-DAGX-03**: Pareto: "N of M DAGs = 80 % of slot-seconds" and the Gini coefficient.
- **FR-DAGX-04**: treemap team → DAG sized by slot-seconds, coloured by p95 queue wait; a click drills down.
- **FR-DAGX-07**: presets "Capacity hogs", "Flaky", "Late starters" (filter definitions left open by the spec).
- **FR-DAGD-01**: header with file, schedule, owners, tags and every DAG-level limit that can throttle it.
- **FR-DAGD-02**: runs timeline (duration, state, start delay per run).
- **FR-DAGD-03**: run Gantt with queue wait and run time per task instance, in distinct accessible styles.
- **FR-DAGD-04**: per-task p50/p95 duration, queue wait, retries, failure rate, share of the DAG's slot-seconds;
  default sort by contribution to run duration.
- **HM-003** (L991): executor slot-seconds = Σ running time per try (one slot each); deferred time never counts.
- **HM-001** (L976): queue wait `start_date − queued_dttm`, p50/p95/max with sample counts.
- **HM-005** (L1023): minutes at `max_active_tasks` with ready work ÷ active minutes.
- **HM-015** (L1330): failure, retry and flaky rates ("succeeded after ≥ 1 failed try ÷ TIs"); rates need ≥ 20 TIs.
- **HM-021** (L1437): cost share by slot-seconds, always labelled estimate with method and price source.

### Bottlenecks (M3), S-16

- **FR-BOTL-01**: waiting task-minutes per time bucket attributed to the binding limit; stacked chart and top
  contributors; in the saturated-pool scenario ≥ 90 % is attributed to "pool exhausted".
- **FR-BOTL-02**: queue wait by pool, DAG and hour, correlated with worker count; p50/p95 with sample counts.
- **FR-BOTL-07**: sensor and long-wait waste ranked by slot-seconds (raises REC-DAG-05).
- **FR-BOTL-09**: autoscaling lag and time at `max_count` (raises REC-CAP-01).
- Answer line (wireframe): "71 % of waiting task-minutes were caused by "executor slots exhausted" while workers were
  at max (i)".
- **HM-006** (L1036–1084): waiting = upstream satisfied but not running; phases pre-queue, post-queue, deferral; first
  match wins, other matches kept as secondary evidence; unevaluable reasons are "unevaluated", never guessed;
  dependency wait is reported separately ("not a platform limit").

  | #   | Reason                   | Phase    | Condition                                                         |
  | --- | ------------------------ | -------- | ----------------------------------------------------------------- |
  | 1   | DAG `max_active_runs`    | Run      | run queued and running runs ≥ `max_active_runs`                   |
  | 2   | Pool does not exist      | Pre      | pool undefined                                                    |
  | 3   | Task larger than pool    | Pre      | `pool_slots` > pool total slots                                   |
  | 4   | Global parallelism       | Pre      | executor running + queued ≥ parallelism (per scheduler)           |
  | 5   | Pool exhausted           | Pre      | pool open slots < task `pool_slots`                               |
  | 6   | DAG `max_active_tasks`   | Pre      | DAG running + queued TIs ≥ limit                                  |
  | 7   | Task-level limit         | Pre      | tries ≥ `max_active_tis_per_dag` / `_per_dagrun`                  |
  | 8   | Scheduler throughput     | Pre      | 1–7 do not apply, yet not queued within 30 s of ready             |
  | 9   | Autoscaling lag          | Post     | slots full, workers < `max_count`, scale target > current workers |
  | 10  | Executor slots exhausted | Post     | slots full and workers = `max_count`                              |
  | 11  | Worker pickup            | Post     | free slots but queued ≥ 60 s                                      |
  | 12  | Triggerer capacity       | Deferral | deferred while running triggers ≥ 95 % of capacity                |
  | 13  | Unknown                  | Any      | nothing evaluable or matched                                      |

- **HM-011** (L1104): utilisation = used ÷ (workers × `worker_concurrency`); capacity-bound minutes when workers =
  `max_count` and queued TIs ≥ max(10, 20 % of capacity).
- **HM-012** (L1120): lag to the first added worker and to the target; time at max per day.
- **HM-008** (L1086): sensor waste = poke-mode slot-seconds.
- **HM-009** (L1237): collision index = share of daily starts in the busiest minute-of-hour.

### Fleet (M4), S-02

- **FR-FLEET-01**: a card per environment: health status, running and queued, workers (current/min/max), failures
  in 24 h, top findings, freshness.
- **FR-FLEET-02 / HM-028** (L1370–1391): score = 100 − Σ weighted penalties of failing checks; capped at 40 when a
  critical check fails; checks without data are "unknown", excluded and counted in coverage ("8 of 9 checks").
  Checks (healthy when · weight · critical): env healthy ≥ 90 %/4 h · 25 · yes; DB health ≥ 95 %/4 h · 20 · yes;
  heartbeat completeness ≥ 90 %/4 h · 20 · yes; web server ≥ 95 %/4 h · 5; DB CPU and memory < 80 %/12 h · 10;
  zombies ≤ 1/24 h · 5; worker restarts ≤ 1/24 h · 5; import errors 0 for 15 min · 5; parse loop p95 < 5 min · 5.

### Advisor (M5), S-18

- **FR-ADV-01**: one finding per (rule, scope) with scope, severity, confidence, impact and evidence.
- **FR-ADV-03**: snippets (Terraform, gcloud, DAG diff) with risks, trade-offs and rollback; copy only, never run.
- **FR-ADV-04 / §13.4**: `priority_score = tier_weight × impact × confidence ÷ effort`; critical first; impact 1–5,
  confidence 0–1, effort 1 config / 2 sizing / 3 DAG change / 5 refactor; tier weight prod 1.0, test 0.6, dev 0.3.
- **FR-ADV-08**: "Why am I seeing this?" with actual values, thresholds and data used.
- Messages read observation → impact → action (§12.12).
- Rules (§13.6 L2840–2896): REC-CAP-01 workers = `max_count` and executor-queued TIs ≥ max(10, 20 % of slots) for
  ≥ 15 min in 24 h (dev 60 min), critical at ≥ 120 min, inhibits REC-CAP-05; REC-CAP-05 slots exhausted while CPU
  p95 < 30 % and memory p95 < 40 % → raise `worker_concurrency` (1–24); REC-CAP-08 CPU or memory p95 ≥ 85 % with
  slots occupied → lower `worker_concurrency` or raise `min_count`; REC-CONC-01 parallelism × schedulers <
  `max_count` × concurrency and parallelism explains ≥ 20 % of waiting → raise `core.parallelism`; REC-CONC-02 zero
  open pool slots with work ≥ 30 min/day; REC-CONC-03 ≥ 70 % of slot-seconds in `default_pool` and it starves;
  REC-CONC-04 low priority waits ≥ 3× its median; REC-DAG-01 at `max_active_tasks` ≥ 10 % of active time with its own
  tasks waiting; REC-DAG-05 poke sensor ≥ 1 slot-hour/day → `mode="reschedule"` or deferrable; REC-SCHED-01 ≥ 20 % of
  daily starts in one minute-of-hour, coinciding with queueing → stagger.

### Wiki (M6), S-29

- **FR-WIKI-01**: pages tagged `appliesTo`; **FR-WIKI-05**: runbooks symptom → checks → causes → fixes → links;
  **FR-WIKI-06**: rule ↔ page cross-links; **FR-WIKI-07**: glossary terms.
- Seed sections (§15.1 L3132–3142): Start here, Concepts (concurrency stack, pools), Best practices, Runbooks,
  Glossary, How DCAM computes things (one page per HM). Page metadata: `appliesTo, lastVerified, sources`.

### Alerts (M7), S-24

- **FR-ALRT-01**: threshold, `for`, hysteresis, severity, scope; exactly one alert per rule and scope.
- **FR-ALRT-02**: default pack per tier (AL-01…AL-19, L3314–3334).
- States (L3299–3301): `inactive → pending → firing → resolved`, plus `unknown` when the source is stale.
- **FR-ALRT-06**: history. Alerts are local and read-only: DCAM never creates Cloud Monitoring policies (§18.2).

## Out of scope

- Real-environment collection (M1). Write actions: finding lifecycle, silences, notifiers, saved views.
- Treemap alternatives (scatter, heatmap), DAG compare, critical path, noisy neighbours, Airflow 3 per-run
  `max_active_tasks`, triggerer reasons (12) and run-level reason 1 beyond the simulator's coverage.

## Open questions and calls made (⚠️ = spec leaves it open)

- ⚠️ Sub-threshold waits (pre-queue < 30 s, post-queue < 60 s with free slots) are reported as "normal latency",
  outside the platform limits, like dependency wait.
- ⚠️ Health labels: score ≥ 80 healthy, 50–79 degraded, < 50 unhealthy.
- ⚠️ Preset filters: capacity hogs = top DAGs reaching 80 % of slot-seconds; flaky = flaky rate ≥ 5 % with ≥ 20
  TIs; late starters = p95 queue wait ≥ 5 min.
- Spec inconsistency noted: HM-031 refers to "HM-006 reason 6"; it means reason 8 (scheduler throughput).
- ⚠️ Alerts: `clearFor` is 10 min for every per-minute rule (the spec gives it only for AL-05). AL-09's
  same-hour baseline is the median of the previous 7 days and needs 6 of them (§8.9), so it is `unknown` in
  the demo. Health-reading rules (AL-01, -02, -04, -10, -18, -19) fire on the first breaching reading; AL-01
  and AL-02 are checked on their 4 h ratio only. AL-15 tracks each pool and reports the longest current
  starvation. ⚠️ VERIFY: AL-10 "over 12 h" is read as the highest value in 12 h.
- ⚠️ Advisor: REC-CAP-01's "≥ 15 min in 24 h" is read as a total (the §13.7 SQL counts only unbroken
  stretches). Impact steps (decades of hours per day), the confidence sample factor (linear up to 30
  observations), SCHED-01's "coinciding with queueing" (≥ half of the waiting in the 15 min after the busiest
  minute), 15 min minimum durations for CAP-05/-08, 80 % "mostly occupied", 50 % headroom for DAG-01 and a
  +50 % concurrency step are DCAM's calls. Not built: REC-CONC-04 (needs 28-day priority baselines), the
  long-wait part of REC-DAG-05 (needs CPU per try), finding hysteresis, lifecycle and grouping. REC-CAP-08
  records "insufficient data" until worker sizes are collected (M1). Snippets carry ⚠️ VERIFY where a
  Composer 3 fact is unconfirmed.
- Rules whose source is not collected in this version (AL-03, -08, -11 to -14, -16) are shown as `unknown`
  with the reason, never guessed. Runbooks without a wiki page yet (all but RB-01 and RB-14) are named, not
  linked.
