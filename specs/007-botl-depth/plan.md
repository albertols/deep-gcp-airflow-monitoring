# Plan 007: why is work waiting, in depth

## Shape

```text
domain   attribution.ts     + byReasonPool (top pools per reason)
         noisy-neighbours.ts  HM-017: per-minute occupancy, matched strata, weighted medians, seeded bootstrap
         pool-activity.ts     FR-ENV-08: running/queued slots, ready/queued waiting, starved series, top DAGs
         priority-fairness.ts HM-023: observed waits per priority band within a pool
         schedule.ts          + dailyStartsByHourMinute; schedule-heatmap.ts: planned/actual heatmaps, top
                              colliding minutes and schedules (HM-009, FR-BOTL-03)
application bottlenecks.ts  window-based core (bottlenecksInWindow) + additive fields via bottlenecks-depth.ts
            schedule.ts      getScheduleIntelligence
contracts   Bottlenecks: reasons[].top_pools, pools[] extra fields, noisy_neighbours, priority_fairness
            (all optional); new GET /api/v1/environments/{env_id}/schedule → Schedule
server      routes/schedule.ts, registered in app.ts
web         pages/bottlenecks/{TopContributorsPanel,NoisyNeighboursPanel,PoolsPanel,PriorityPanel}.tsx,
            explanations-depth.ts; pages/schedule/{SchedulePage,Heatmap,explanations}.ts(x);
            router + nav: `schedule`
```

## Packages touched

| Package                | Change                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------- |
| `packages/domain`      | New pure modules above; additive `Attribution.byReasonPool`; `dailyStartsByHourMinute` |
| `packages/application` | `bottlenecksInWindow`, `bottlenecks-depth.ts`, `getScheduleIntelligence`, perf test    |
| `packages/contracts`   | Additive optional fields on `Bottlenecks`; new `Schedule` schema and path; `pnpm gen`  |
| `apps/server`          | `GET /api/v1/environments/{env_id}/schedule`; contract conformance on demo data        |
| `apps/web`             | New panels and page; `DcamApi.getSchedule`; router `schedule`; one nav entry           |

No port changes. No collector, store, doctor or DAG detail changes.

## Constitution check

- Read-only: no new outbound calls; everything derives from data DCAM already stores.
- Domain stays pure: time comes in as window arguments; the bootstrap PRNG is seeded from the DAG ID.
- Test first: each task starts with a failing test named after its requirement ID.
- Public repository: demo `acme_*` data and synthetic fixtures only.
- Facts: no new Composer or Airflow facts beyond those cited in spec.md; uncertain ones marked ⚠️ VERIFY.

## Contract changes (additive)

- `Bottlenecks.reasons[].top_pools?` (≤ 10: pool, waiting_task_seconds, share).
- `Bottlenecks.pools[]`: `running_slots_avg?`, `running_slots_peak?`, `queued_slots_avg?`, `ready_task_seconds?`,
  `queued_task_seconds?`, `top_dags?`, `starved_series?` (minutes per bucket, null without snapshots).
- `Bottlenecks.noisy_neighbours?`, `Bottlenecks.priority_fairness?`.
- `GET /api/v1/environments/{env_id}/schedule?range=` → `Schedule`.

## Testing

- Domain: golden tests per module (hand-computed medians, starved minutes, heatmap cells) and fast-check
  properties (shares ≤ 1, CI brackets the effect, heatmap totals equal daily starts, no DAG below the minimums).
- Application: mapping to the contract; 7 days × 2,000 DAGs × 60 s snapshots under 2 s.
- Server: contract conformance on the demo; demo shows a noisy neighbour, a starved pool and the minute-0
  collision.
- Web: each panel's states (empty, not evaluated, low sample), (i) entries (FR-UI-05), provenance footers,
  table views; router and navigation.
