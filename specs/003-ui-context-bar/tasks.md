# Tasks 003: global context bar and URL as state

Test tasks come before the code they cover.

## Long ranges

- [x] T-300 Test + code: league accumulator over store slices equals `dagLeague` for any slicing (NFR-PERF-01)
- [x] T-301 Test + code: slot-seconds and peak, waiting attribution and HM-005 over slices (NFR-PERF-01)
- [x] T-302 Test + code: contract `Range` presets 15m…90d, application lengths and chart buckets (FR-UI-01,
      NFR-PERF-06); overview, league, detail and bottlenecks read one-day slices; `coverage` of the range
- [x] T-303 Test + code: server accepts every preset; 400 lists them (FR-UI-01)
- [x] T-304 Benchmark: 7 days at 2,000 DAGs and 20,000 tries a day under 2 s; 30 and 90 days measured
      (NFR-PERF-01)
- [x] T-305 Merge with features 004–007: league flakiness (observed, inferred, `flaky_inferred`), detail
      baseline, schedule, and the bottleneck depth (top pools, pool activity, HM-017, HM-023, slots source,
      thinned spans) from slices; a test that any bottleneck slice length gives the same analysis

## Context bar and URL

- [x] T-310 Test + code: router view state and page params, defaults left out, invalid values fall back (FR-UI-02)
- [x] T-311 Test + code: context bar with environment, range presets, UTC or local, pause or resume, data as of
      with §12.10 stale colours in live mode (FR-UI-01)
- [x] T-312 Test + code: pages read the range from the bar; a range change refetches every panel (FR-UI-01)
- [x] T-313 Test + code: paused stops page and collection polling; resume refetches (FR-UI-01)
- [x] T-314 Test + code: time zone toggle changes every rendered time (FR-UI-01)
- [x] T-315 Test + code: page filters, sort, selected run and table views in the URL; a link restores them (FR-UI-02)

## Done

- [ ] T-390 Browser validation against `pnpm dcam --demo`; code review; `pnpm check`
