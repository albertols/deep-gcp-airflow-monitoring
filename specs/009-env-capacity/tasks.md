# Tasks 009: environment capacity, load heatmap and 24-hour forecast

Test tasks come before the code they cover.

## Domain

- [x] T-900 Test + code: per-minute worker figures, buckets, capacity-bound periods, scale events, heatmap
      (FR-ENV-02, HM-011, HM-012)
- [x] T-901 Test + code: DAG × hour-of-day load for the top N DAGs from task tries (FR-DAGX-06)
- [x] T-902 Test + code: cron times in a window (HM-010)
- [x] T-903 Test + code: run profiles, planned runs, baseline, p10/p50/p90, saturation windows, pools,
      low confidence under 14 days (HM-010, FR-BOTL-05)

## Application, contract, server

- [x] T-910 Test + code: `getCapacity` and the `Capacity` contract (FR-ENV-02, FR-DAGX-06)
- [x] T-911 Test + code: `getForecast` and the `Forecast` contract (HM-010, FR-BOTL-05)
- [x] T-912 Test: 7 days capacity and a 28-day forecast at 2,000 DAGs, each under 2 s of CPU (NFR-PERF)
- [x] T-913 Test + code: `GET …/capacity` and `GET …/forecast`; the demo forecast shows the 01:30 UTC window
      (FR-EMU-01)

## Web (T-990, split; spec.md "Web panels")

- [x] T-990a Test + code: `/capacity` route and "Capacity" navigation entry, the tab in the URL, the API client
      for both endpoints, the global range mapped to 1h, 6h, 24h or 7d with a plain note for 15m, 30d and 90d
      (FR-ENV-02, FR-UI-01, FR-UI-02)
- [x] T-990b Test + code: capacity tab: the answer, KPIs, worker slots against running and queued task
      instances with the capacity-bound periods highlighted, a table view, and the periods listed (FR-ENV-02,
      HM-011)
- [x] T-990c Test + code: limits with their provenance (unknown reads as unknown, never zero), workers against
      min and max with scale events, worker CPU and memory, pools (FR-ENV-02, HM-012, HM-032)
- [x] T-990d Test + code: a colour-blind-safe sequential scale for the light and dark themes; the UTC day × hour
      saturation heatmap with the selected cell in the URL and a table view (FR-ENV-02, FR-UI-06)
- [x] T-990e Test + code: DAG × hour-of-day load heatmap of the top DAGs, the selected cell in the URL and a
      table view (FR-DAGX-06)
- [ ] T-990f Test + code: forecast tab: the next 24 hours from now, the confidence statement (low confidence
      prominent), the history used, the demand band against capacity with saturation and risk windows, DAGs and
      pools (HM-010, FR-BOTL-05)
- [ ] T-990g Test: loading, empty, partial, stale and error states, an (i) explanation for every panel and the
      provenance footers (FR-UI-05, FR-UI-07, FR-UI-08)

## Not in this feature

- [ ] T-991 REC-SCHED-03: rule not fully defined (spec.md "Not wired")
- [ ] T-992 CPU and memory of non-worker workload types: collector, store and series budget (spec.md)
