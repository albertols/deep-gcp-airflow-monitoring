# Tasks 009: environment capacity, load heatmap and 24-hour forecast

Test tasks come before the code they cover.

## Domain

- [x] T-900 Test + code: per-minute worker figures, buckets, capacity-bound periods, scale events, heatmap
      (FR-ENV-02, HM-011, HM-012)
- [ ] T-901 Test + code: DAG × hour-of-day load for the top N DAGs from task tries (FR-DAGX-06)
- [ ] T-902 Test + code: cron times in a window (HM-010)
- [ ] T-903 Test + code: run profiles, planned runs, baseline, p10/p50/p90, saturation windows, pools,
      low confidence under 14 days (HM-010, FR-BOTL-05)

## Application, contract, server

- [ ] T-910 Test + code: `getCapacity` and the `Capacity` contract (FR-ENV-02, FR-DAGX-06)
- [ ] T-911 Test + code: `getForecast` and the `Forecast` contract (HM-010, FR-BOTL-05)
- [ ] T-912 Test: 7 days capacity and a 28-day forecast at 2,000 DAGs, each under 2 s of CPU (NFR-PERF)
- [ ] T-913 Test + code: `GET …/capacity` and `GET …/forecast`; the demo forecast shows the 01:30 UTC window
      (FR-EMU-01)

## Not in this feature

- [ ] T-990 Web panels for S-04 and the forecast (later task)
- [ ] T-991 REC-SCHED-03: rule not fully defined (spec.md "Not wired")
- [ ] T-992 CPU and memory of non-worker workload types: collector, store and series budget (spec.md)
