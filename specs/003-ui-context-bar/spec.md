# Feature 003: global context bar and URL as state

- **Epic / milestone:** UI · M1 (spec §22.2)
- **Requirements:** FR-UI-01 (global context bar), FR-UI-02 (URL as state); NFR-PERF-01 and NFR-PERF-06 for
  the long ranges this feature makes possible
- **Status:** done

## Intent

DCAM runs for days against environments with about 2,000 DAGs, and the questions that matter most need long
windows: "who used capacity over the last 7 days", "what waited over the last 30 days". Today the contract
offers only 1 h, 6 h and 24 h, and each page keeps its own range, so two pages can show different windows and a
link never restores what someone saw. This feature puts one context bar at the top of the shell, with
environment, time range (15 minutes to 90 days), time zone, live or paused updates and freshness, and keeps
all of it, plus each page's filters, selection and tabs, in the URL.

## User stories

- As a platform engineer, I want to look at the league table and the bottlenecks over the last 7 and 30 days,
  with a chart that still reads well at that length and says its bucket size (FR-UI-01, NFR-PERF-06).
- As a user, I want one range for every panel on the page, so the numbers on a page always agree (FR-UI-01).
- As an on-call engineer, I want to pause updates while I study a chart, and see how fresh the data is
  (FR-UI-01, §12.10 stale).
- As someone in a time zone other than UTC, I want to switch times to my local zone and back (FR-UI-01).
- As a team member, I want to send a link that opens exactly the view I see: environment, range, time zone,
  paused, filters, sort, the selected run and table views (FR-UI-02).

## Requirements extracted from docs/spec/dcam-spec.md (line numbers refer to that file)

- **FR-UI-01** (L1624): "Global context bar: environment selector (multi-select for comparisons), time range
  picker (relative and absolute; presets from 15 minutes to 90 days), time zone toggle, live or paused mode,
  freshness indicator." Acceptance: "When the time range changes, the system shall update every panel on the
  page consistently."
- **FR-UI-02** (L1625): "URL as state: filters, time range, selection and tabs are encoded in the URL."
  Acceptance: "When a user opens a shared link, the system shall restore the same view."
- **§12.2** (L2418): app bar `[Environment selector ▾] [Time range ▾] [TZ] [● Live/Paused] …`.
- **§12.8** (L2594): "All charts in a view share the time range"; units always visible; gaps never drawn as
  zero; "Large data: server-side aggregation first" (NFR-PERF-06: more than 10,000 points need aggregation).
- **§12.10** (L2632) Stale: "Freshness chip turns amber when data is older than 2 × cadence, red when older than
  5 ×".
- **§12.7** (L2587): tabular numbers, humanised durations with exact values on hover.
- **NFR-PERF-01** (L1848): aggregated views p95 ≤ 500 ms at reference scale (5,000 DAGs, 100,000 task instances
  a day). This feature proves the first target profile (2,000 DAGs, about 20,000 tries a day) over 7 days.
- **FR-STORE-02** (L1613): raw runs and task instances are kept 90 days, so 90 days is the longest raw range.

## Acceptance criteria

1. The `range` parameter of the overview, DAG league, DAG detail and bottlenecks endpoints accepts `15m`, `1h`,
   `6h`, `24h`, `7d`, `30d` and `90d` (additive enum values); anything else is a 400 problem that lists them.
2. Every range-based use case computes its comparison period with the same length as the range, and chart
   series have at most 360 buckets: 1 min (15 m, 1 h), 5 min (6 h), 15 min (24 h), 1 h (7 d), 3 h (30 d),
   6 h (90 d). The chart and its table name the bucket.
3. Findings, alerts and the fleet keep their fixed 24 h window; the bar says so instead of offering a range
   that would not apply.
4. The DAG league and the bottleneck analysis for 7 days at 2,000 DAGs (about 20,000 tries a day) complete in
   under 2 s each on the maintainer's Intel Mac (measured in a test). 30 and 90 days are measured and reported.
5. The shell shows one context bar: environment (single select), time range presets, UTC or local time, live
   or paused, and "data as of" with the §12.10 stale colours in live mode. Pages have no range control of their
   own; a range change refetches every panel of the page with the new range.
6. Paused stops every polling refetch (pages and collection status); user actions such as a new range still
   load. Resuming restarts polling.
7. The time zone toggle changes every rendered time: provenance footers, chart axes and tooltips, run times,
   alert times and the freshness indicator.
8. Environment, range, time zone, paused, and each page's filters, sort, selected run and table views are in
   the URL; defaults are left out; opening the URL restores the view; invalid values fall back to defaults.

## Out of scope

- Absolute date ranges (nice to have; the URL format leaves room for `from`/`to`).
- Multi-environment selection for comparisons (S-21 compare environments, M2 or later).
- Rollup-backed long ranges (FR-STORE-02 5-minute and 1-hour rollups, M2): long ranges read raw facts.

## Decisions (calls made where the spec is open)

- "Live or paused" is shown as a **Pause / Resume** button and a "Paused" freshness chip: the shell's "Live"
  chip already means "reading your environments, not demo data" (FR-COLL-11), so reusing the word would mean
  two different things.
- The schedule page follows the range for actual starts; its heatmaps stay in UTC whatever the toggle says,
  because they are hours of the day of UTC cron schedules.
- The bottleneck analysis reads a week at a time (one read for 7 days); the others a day at a time.
- Time zone default is UTC: Airflow, the store and every timestamp DCAM receives are UTC.
- Bucket sizes are fixed per preset (table above) rather than computed from the screen width, so a shared link
  shows the same buckets on every screen.
