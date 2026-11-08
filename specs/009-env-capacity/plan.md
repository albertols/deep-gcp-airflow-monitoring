# Plan 009: environment capacity, load heatmap and 24-hour forecast

## Shape

```text
domain       capacity.ts        per-minute worker figures (samples, else snapshots), buckets, capacity-bound
                                periods, scale events, UTC day × hour heatmap, ratio stats (HM-011, HM-012)
             dag-load.ts        DAG × hour-of-day mean slots from task tries, top N (FR-DAGX-06)
             schedule.ts        + cronTimesBetween (planned starts in a window, UTC)
             forecast.ts        run occupancy profiles, planned runs, hour-of-week baseline, 24 h p10/p50/p90,
                                saturation windows, pools (HM-010, FR-BOTL-05)
application  capacity.ts        getCapacity → contract Capacity
             forecast.ts        getForecast → contract Forecast (reads 28 days of tries)
contracts    GET /api/v1/environments/{env_id}/capacity?range=1h|6h|24h|7d → Capacity
             GET /api/v1/environments/{env_id}/forecast → Forecast
server       routes/capacity.ts (both), parseRange takes the allowed ranges
```

## API choice

Two endpoints, as S-04 (capacity) and S-17 (forecast, FR-BOTL-05) are different screens and the forecast reads
28 days of history while capacity reads the selected range. The DAG × hour-of-day heatmap (FR-DAGX-06) is part
of `Capacity` (`dag_load`): it reads the same tries and range, and a separate path under `…/dags/` would shadow a
DAG ID. Capacity takes its own range parameter (`CapacityRange`, adds `7d`) so the shared `Range` used by every
other page is unchanged; the default stays `24h`. The forecast takes no parameter: its horizon is the next 24 h.

## Packages touched

| Package                | Change                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `packages/domain`      | New `capacity.ts`, `dag-load.ts`, `forecast.ts`; `cronTimesBetween` (additive)      |
| `packages/application` | `getCapacity`, `getForecast`; perf test                                             |
| `packages/contracts`   | Two paths, `CapacityRange` parameter, `Capacity` and `Forecast` schemas; `pnpm gen` |
| `apps/server`          | `routes/capacity.ts`; `parseRange(reply, raw, allowed)`; route tests on the demo    |
| `apps/web`             | `pages/capacity/` (S-04 tabs, heatmaps, forecast), route, navigation, API client    |

No port changes, no collector or store changes. The web tasks (T-990a–g) use the merged contract unchanged.

## Web (T-990a–g)

```text
apps/web/src/pages/capacity/
  range.ts            global Range → CapacityRange and the note that says so
  heat-scale.ts       viridis per theme (FR-UI-06), luminance helpers for the contrast test
  explanations.ts     (i) entries for every panel (FR-UI-05)
  CapacityPage.tsx    header, range note, tabs, partial and stale states, provenance footer
  TimeChart.tsx       bucketed bars and step lines with highlighted buckets, gaps never zero
  CapacityTab.tsx     answer, KPIs, slots chart, bound periods, workers and scale events, limits, workloads, pools
  HourGrid.tsx        rows × 24 hours of cell buttons (selection in the URL), legend, unobserved cells outlined
  SaturationPanel.tsx UTC day × hour heatmap; DagLoadPanel.tsx DAG × hour-of-day heatmap
  ForecastTab.tsx     confidence, windows, demand band chart, DAGs, pools
```

Testing: Vitest and Testing Library on contract-typed fixtures (`test/capacity-fixtures.ts`, `acme_*` names), one
test per acceptance criterion, named with its requirement ID; unit tests for the range mapping and the colour
scale (luminance monotonic, the top of the scale ≥ 3:1 against the panel in both themes).

## Constitution check

- Read-only: no new outbound calls; everything derives from stored tries, snapshots and samples.
- Domain stays pure: time comes in as arguments (`now`, windows); `new Date(ms)` only formats UTC fields.
- Test first: each task starts with a failing test named after its requirement ID.
- Public repository: demo `acme_*` data and synthetic fixtures only.
- Facts: the `scheduled__` run ID prefix is Airflow's `DagRunType.SCHEDULED` (`airflow/utils/types.py`, and
  `DagRun.generate_run_id` builds `f"{run_type}__{logical_date.isoformat()}"` in `airflow/models/dagrun.py`,
  Airflow 2.11.1); a manual trigger may choose its own `run_id`, which then counts as unscheduled.

## Rollups (FR-DAGX-06)

The spec renders the DAG × hour-of-day heatmap "from 5-minute rollups". The store has no rollups yet, so
`dagLoadByHour` reads the range's task tries: one pass, each try split at UTC hour boundaries (O(tries × hours a
try spans) and O(DAGs × 24) memory), top 20 by executor slot-seconds. When `agg.*_5m` rollups land (spec §11.7),
the heatmap reads them instead and keeps its contract.

## Cost

- Capacity at 7 days: 10,080 minutes, one pass over samples and snapshots, the HM-003 sweep over the tries and
  the FR-DAGX-06 pass. Forecast: one pass over 28 days of tries to group runs, per-run profiles at one-minute
  resolution (sparse per offset, so memory follows the total run-minutes), percentiles per offset, and
  planned-run placement over 1,440 minutes. Both measured in `capacity-forecast-perf.test.ts` (CPU time).
- The live store read of 28 days (about 560,000 tries at the target) is outside the application budget; the
  server memo serves repeated requests.

## Testing

- Domain: golden tests per module (hand-computed minutes, periods, heatmap cells, profiles and percentiles,
  saturation windows), gaps as `null`, hostname and unknown-concurrency labels, cron times in a window.
- Application: mapping to the contract with fakes; perf test at 2,000 DAGs (7 days capacity, 28 days forecast).
- Server: Ajv conformance on the demo for every capacity range and the forecast; the demo forecast shows the
  01:30 UTC window as low confidence; 404 and 400 problems.
