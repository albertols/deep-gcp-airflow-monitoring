# Plan 006: DAG detail in depth

## Shape

```text
store.taskTries(env, range.from − 28 d, now)  (or dagTaskTries when the store has it)
  └─ application getDagDetail ─┬─ domain duration-regression.ts  HM-016 / FR-TASK-01 (distribution, verdict, BH)
                               │    └─ significance.ts           Mann–Whitney U (one-sided), Benjamini–Hochberg
                               ├─ domain reliability.ts           HM-015 per DAG and task (rates, flaky, MTTR)
                               ├─ domain critical-path.ts         HM-007 timing estimate per run, frequency per task
                               └─ contract DagDetail (additive)   baseline, regression, reliability,
                                                                  tasks[].duration_regression/reliability/critical_path_*,
                                                                  gantt.critical_path
web DagDetailPage ── DurationPanel.tsx, ReliabilityPanel.tsx, CriticalPathSummary.tsx (new), RunGantt highlight
web LeagueTable ── "Flaky" column
fakes ── blueprint `slowdown` (a step change in some tasks' duration), demo DAG search_ranking_refresh
```

## Packages touched

| Package                   | Change                                                                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/domain`         | New `significance.ts`, `duration-regression.ts`, `reliability.ts`, `critical-path.ts`; shared `flakiness()` in `dag-runs.ts` (league uses it) |
| `packages/ports`          | Additive, optional `TaskInstanceStore.dagTaskTries?(envId, dagId, from, to)`                                                                  |
| `packages/application`    | `getDagDetail` reads the baseline and fills the new fields; performance test                                                                  |
| `packages/contracts`      | Additive optional `DagDetail` fields and schemas `DurationDistribution`, `DurationRegression`, `TaskReliability`; `pnpm gen`                  |
| `packages/adapters/fakes` | `DagBlueprint.slowdown`; demo DAG `search_ranking_refresh`                                                                                    |
| `apps/server`             | Demo conformance and demo stories (regression, flaky) through the HTTP API                                                                    |
| `apps/web`                | New panels and explanations (`depth-explanations.ts`); critical path on the Gantt; league "Flaky" column                                      |

## Constitution check

- Read-only, no new source and no allowlist change: everything derives from stored task tries.
- Domain pure (time from the window); application imports ports, domain and contracts only.
- Test first, IDs in test names; golden tests for the statistics, property tests for the invariants.
- Honest precision: low samples, partial baselines, inferred flakiness and the timing-estimated critical path are
  labelled with their method; missing baselines are "not available yet", never zero.
- Public repository: fictitious `acme-*` environments and demo DAG names only.

## Contract changes (all additive and optional)

- `DagDetail.baseline` `{ from, to, history_from, coverage, margin }`.
- `DagDetail.regression` (`DurationRegression` of successful run durations).
- `DagDetail.reliability` `{ runs, failed_runs, run_failure_rate, run_recoveries, run_unrecovered,
run_mttr_seconds, tasks: TaskReliability }`.
- `DagDetail.tasks[]`: `duration_regression`, `reliability`, `critical_path_runs`, `critical_path_share`.
- `DagDetail.gantt.critical_path` `{ method, row_indexes, duration_seconds, waiting_seconds, running_seconds }` or
  null.

## Performance

The baseline read is environment-wide on DuckDB until `dagTaskTries` exists there (the alert pack already reads 7
days environment-wide). Domain work is linear in the DAG's tries plus a sort per task. Test: 50 tasks × 96 runs a
day × 7 days (33,600 tries) plus 100 other DAGs, `getDagDetail` < 1 s.

## Testing

- Domain: golden tests (Φ, U statistic with ties, BH adjusted values, distributions, verdicts, MTTR, critical path
  of a known run); properties (q ≥ p and monotone; rates in [0, 1]; flaky ≤ retried ≤ task instances; the critical
  path sums to the run duration and its steps do not overlap).
- Application: baseline window and coverage; verdicts through the use case; performance.
- Server: demo conforms to `DagDetail`; the demo regression and flaky stories.
- Web: panels, states, (i) entries, Gantt highlight, league column.
