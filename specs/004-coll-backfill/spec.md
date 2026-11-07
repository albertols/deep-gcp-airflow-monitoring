# Feature 004: backfill on first add

- **Epic / milestone:** COLL, SELF, UI · M2 demo step 3 (spec §22.6 L4733)
- **Requirements:** FR-COLL-04 (main), FR-COLL-02, FR-COLL-03, FR-COLL-06, FR-STORE-06, NFR-OBS-01, NFR-OBS-05,
  NFR-OBS-06, NFR-DATA-03, FR-SELF-01, FR-UI-05, FR-UI-07, FR-UI-08
- **Status:** implemented (browser validation and code review pending)

## Intent

On first start against an environment, `af.facts` reads only the last hour and `mon.core` the last hour of
metrics, so the league table and the bottlenecks show one hour. With this feature DCAM fills the last 7 days of
finished task instances and the last 14 days of worker metrics in the background, at background priority and
within the observer budget, resumes after a restart, and shows its progress and an honest ETA on the DCAM health
page. Pages whose range reaches past the history read so far say so instead of showing the gap as zero.

## Requirements extracted from docs/spec/dcam-spec.md

- **FR-COLL-04** (L1598): "Backfill on first add (default 7 days of runs and task instances, 14 days of metrics;
  configurable) at background priority, within budget, with progress in the UI. — When an environment is added,
  the system shall show backfill progress and complete it without exceeding the observer budget."
- **§7.7** (L729): "When an environment is first added, backfill runs at background priority within the budget".
  L611: backfills resume from watermarks, not from page tokens.
- **§7.11** (L815–846): item 2, "Backfill, inventory refresh and static analysis run as background work and
  always yield"; the budget table lowers Monitoring (30/30/10/5) and Composer (6/6/2/1) per profile; hard maxima
  Airflow 120/min and 4 concurrent, Monitoring 120, Composer 30.
- **§17.2** (L3447): `environments[].backfill: { taskInstancesDays: 7, metricsDays: 14 }`.
- **FR-COLL-02** (L1596): while two collectors compete for the same API budget, the higher priority is served
  first. **FR-COLL-03** (L1597): persisted watermarks, idempotent upserts, no duplicates after a restart.
- **FR-COLL-06** (L1600), **NFR-OBS-01** (L1887), **NFR-OBS-05** (L1892): budgets never exceeded; tested with
  fake clocks and fakes. **NFR-OBS-06** (L1890): series counted, `crossSeriesReducer` for environment views.
- **NFR-DATA-03** (L1904): missing data is a gap, never a zero.
- **Appendix B.1–B.3** (L5078–5125): page size ≤ 100, closed `updated_at` windows split until they fit, offset
  paging only inside the minimum window.

## Facts checked

- Airflow 2.11.1 `GET /dags/{dag_id}/dagRuns/{dag_run_id}/taskInstances` (`airflow/api_connexion/openapi/v1.yaml`
  at tag 2.11.1, path parameters at the `taskInstances` path; implementation `get_task_instances` in
  `airflow/api_connexion/endpoints/task_instance_endpoint.py`): filters `execution_date_gte/lte`,
  `start_date_gte/lte`, `end_date_gte/lte`, `updated_at_gte/lte` ("New in version 2.6.0"), `duration_gte/lte`,
  `state`, `pool`, `queue`, `executor`; `limit` (default 100) and `offset`. No `order_by` on this list and no
  ORDER BY in the query, so rows come in no defined order. `_apply_range_filter` makes both bounds inclusive
  (`>=`, `<=`).
- The backfill therefore uses the same closed `updated_at` windows as `af.facts`: every row has exactly one
  `updated_at`, so `[from, A]` (backfill) and `[A, …]` (`af.facts`) partition the history with no gap. An
  `end_date` window would miss rows marked again by hand (B.3).
- The list returns the current row of each task instance only. Earlier tries of a task instance retried inside
  the backfill window are in task instance history (`GET …/tries`, 2.10+) and are not backfilled (out of scope).
- **DAG runs.** DCAM stores no DAG runs: runs are reconstructed from task instance tries
  (`packages/domain/src/dag-runs.ts`), and the store has no run table. Backfilling task instances therefore
  backfills runs; no separate run backfill is needed.
- **Metrics.** `WorkerSample` is one sample per minute, and every consumer counts a sample as at most one minute
  (`capacityStats`, `workerSignals`). History is therefore read at a 60 s alignment (the Monitoring minimum),
  in one-day chunks: 1,440 points per series per call (one page; `pageSize` counts points, at most 100,000).
  Monitoring bills per series returned, not per point: 14 days are 14 × 8 queries + 1 discovery = 113 series
  once, about 0.01 % of the default 1,000,000 a month. Health inputs are a latest-only record (each read has its
  own 4 h to 24 h lookback), so they have no history to backfill.
- Cloud Monitoring keeps Composer metrics for six weeks (L547, L4904): `metricsDays` is at most 42.
  `taskInstancesDays` is at most 90, the raw task instance retention (FR-STORE-02, L1613); Composer 3 keeps
  60 days of metadata by default (L1422), so older rows may not exist.

## User stories

- As a platform engineer adding my environment, I want the last week of task instances to fill in by itself, so
  the league table and bottlenecks show a week, not an hour.
- As the owner of the environment, I want the backfill to stay inside DCAM's budget and yield to live work.
- As a user, I want to see how far the backfill got and when it will finish, and pages to say when a range
  reaches past the history read so far.

## Acceptance criteria

1. `af.backfill` reads finished task instances with `updated_at` in `[A − days, A]`, newest first, where `A` is
   `af.facts`' persisted watermark when the backfill first runs; it waits until that watermark exists. Rows are
   stored once (natural key), and none in the window are missed at the boundary with `af.facts`.
2. It reuses `af.facts`' window reader (split on `total_entries`, page caps below 100, dense seconds across
   cycles), at `background` priority, never more requests than the budget allows.
3. Progress (`from`, `to`, covered from, items read, requests used, started, completed) is persisted with the
   rows in one transaction; a restart resumes from it without re-reading what is covered.
4. `mon.backfill` reads 14 days of the six worker-sample series newest first in one-day chunks at 60 s, within
   the Monitoring background share; partial chunks are kept across cycles; series are counted.
5. Background work gets a guaranteed share of every budget (the `background` budget class, at most half the
   profile's budget) and may also use spare capacity while the bucket is at least half full; live and standard
   requests waiting at the same time are always served first.
6. Monitoring and Composer budgets follow the profile (§7.11): eco a third, background a sixth of the
   configured value. A test proves that the hard maxima of the config schema and the engine agree.
7. `GET /api/v1/collection` adds `backfill` per environment (additive); the health page shows state, days read
   of days configured, covered from, items, requests and an ETA from the observed rate (none until it can be
   estimated). The DAG league and bottlenecks pages show "history is filling in: N of 7 days" when their range
   starts before the covered period.
8. `environments[].backfill.{taskInstancesDays, metricsDays}` with defaults 7 and 14, maxima 90 and 42, 0 to
   turn a backfill off; JSON Schema regenerated; the example updated.
9. A simulation proves 7 days at about 2,000 DAGs (20,000 tries a day) completes on the standard profile without
   exceeding 12 requests a minute, while `af.facts` keeps up, and that the ETA is believable.

## Out of scope

- Earlier tries of retried task instances (`GET …/tries` per task instance).
- Filling gaps after sleep or a restart of `mon.core` (FR-COLL-10, M4); patient mode suspending the backfill
  (§7.11 item 4, not implemented in the engine yet); eco mode switch (FR-SELF-02, M4).
- A monthly series budget governor (NFR-OBS-06 enforcement, a follow-up of feature 002).

## Decisions

- Backfill reads newest first, so recent history arrives first and "covered from" stays contiguous with live
  collection (the earliest stored try is then also where history starts, which `historyCoverage` relies on).
- The boundary `A` is `af.facts`' watermark at the first backfill cycle: `af.facts` covers from its first window
  start `S ≤ A`; `[S, A]` (normally its first hour, about 1 % of 7 days) is read by both and stored once.
- `mon.backfill`'s boundary is `now − 120 s` at its first cycle, minute-aligned; `mon.core` reads from one hour
  before its own first cycle, so the two overlap by up to an hour, upserted by minute.
- Rows of a backfill cycle and its progress commit in one transaction (`commitBackfill`, FR-STORE-06).
- A backfill that yields to the budget is not "reduced fidelity": it reports progress instead. Only lost data (a
  dense second it could not read completely) is reported as reduced fidelity.
- Background fairness: a guaranteed share (the `background` budget class, at most half the profile's budget)
  whenever a token is free, plus spare capacity while more than a quarter of the bucket is free. Measured in the
  simulation: the share alone took 16 h for the week; spare capacity above half the bucket changed nothing (about
  4 requests a minute stayed unused); above a quarter it took 10 h, with `af.live` and `af.facts` on time and no
  60 s window above 12 requests. This replaces feature 002's "background only while half the bucket is free".
- Monitoring and Composer budgets per profile: the configured value is the live and standard budget, eco a third,
  background a sixth (§7.11 table 30/30/10/5 and 6/6/2/1). A project's Monitoring gate uses the most demanding
  profile among its environments.
- The window reader (`fact-windows.ts`) is shared code, not yet used by `af.facts`: `af.facts`' page-cap rule is
  being corrected in parallel (a cap learnt from one short page could cut every window to 1 s). The reader
  already applies the corrected rule (a cap only when two short pages agree, raised by a larger page, forgotten on
  a full page; a window with a short page is halved, not re-read), so `af.facts` can move onto it after that fix.
- Parts are sized by the density of the last window read (at most 4× growth): on a day with busy and quiet hours
  59 instead of 75 requests; 79 rows a request over the simulated week.
- Measured results: 7 days at 20,000 tries a day (140,000 rows) in 1,777 requests and about 10 h on the
  standard profile; the ETA a quarter of the way in was 7.1 h for an actual 7.5 h. 14 days of worker samples in
  113 requests, 14 minutes, at most 25 Monitoring requests in a minute. Faster: the live profile for a while, or
  a higher `budgets.airflowApi.background` (the health page says so).
- ⚠️ VERIFY: whether Cloud Monitoring counts a series split across pages more than once (not the case here: one
  page per query); worker workload `type` values (shared with `mon.core`).
