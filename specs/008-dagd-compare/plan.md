# Plan 008: DAG concurrency, impact and comparisons

## Shape

```text
domain  self-throttling.ts    HM-005 per DAG from snapshots (shared with advisor-signals.ts, REC-DAG-01)
        concurrency-profile.ts FR-DAGD-05: running (tries) and in-flight/ready (snapshots) per bucket, pools
        dag-impact.ts         FR-DAGD-06: share of executor load and of executor slots per bucket
        noisy-neighbours.ts   + noisyNeighbourOf(dagId): HM-017 for one DAG, same computation
        environment-load.ts   HM-003 totals per bucket and pool for a whole environment (port fallback)
        dag-compare.ts        FR-DAGD-08: hourly UTC load profile, shared duration bins
        run-comparison.ts     FR-DAGD-09: per-task deltas and critical-path contributions (HM-007)
application dags.ts            getDagDetail + concurrency, impact; self_throttled_ratio from the shared HM-005
            dag-compare.ts     getDagComparison, getRunComparison
ports   TaskInstanceStore.environmentLoad? (optional, additive)
store   duckdb-store environmentLoad (SQL aggregate)
server  routes/dags.ts         + GET …/dags/{dag_id}/runs/compare; DAG findings passed to DAG detail
        routes/compare.ts      GET /api/v1/compare/dags
```

## API choice

DAG detail is extended, not split: `DagDetail.concurrency` and `DagDetail.impact` are optional fields (the S-12
tabs read one response, as for the baseline and reliability). Comparisons are new endpoints:

- `GET /api/v1/compare/dags?dags=<env>:<dag>,…&range=` → `DagComparison` (2 to 4 items; `range` any preset, the global `Range` parameter).
  An item splits at its first colon: environment IDs have none (`^[a-z0-9][a-z0-9-]{0,62}$`), and Airflow DAG IDs
  match `^[\w.-]+$` (`KEY_REGEX`, `airflow/utils/helpers.py`), so they have no comma.
- `GET /api/v1/environments/{env_id}/dags/{dag_id}/runs/compare?a=<run>&b=<run>&range=` → `RunComparison`
  (both runs must have a try starting in the range; default 7 d).

## Packages touched

| Package                          | Change                                                                                                                                                                                                    |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/domain`                | New modules above; `advisor-signals.ts` uses the shared HM-005; `noisy-neighbours.ts` split                                                                                                               |
| `packages/ports`                 | Optional `TaskInstanceStore.environmentLoad(envId, from, to, now, bucketMs)`                                                                                                                              |
| `packages/adapters/duckdb-store` | `environmentLoad` as one SQL aggregate, checked against the domain function                                                                                                                               |
| `packages/application`           | `getDagDetail` fields in its slice loop; `getDagComparison`, `getRunComparison`                                                                                                                           |
| `packages/contracts`             | Additive: `DagDetail.concurrency`, `.impact`; schemas `DagConcurrency`, `DagImpact`, `DagNoisyNeighbour`, `NoisyNeighbour` (the item, extracted), `DagComparison`, `RunComparison`; two paths; `pnpm gen` |
| `apps/server`                    | Routes (ranges through `parseRange`), demo conformance and stories                                                                                                                                        |

No web changes. No collector or fakes changes: the demo already has the throttled fan-out DAG
(`customer_360_rebuild`), the noisy neighbour (`search_index_rebuild`) and a regressed task (`search_ranking_refresh`).

## Constitution check

- Read-only: no new source or outbound call; everything derives from stored tries, snapshots and samples.
- Domain pure (time from windows; the bootstrap PRNG seeded from the DAG ID). Application imports ports, domain and
  contracts only; the store change is one read.
- Test first, requirement IDs in test names; golden tests and properties (contributions sum to the duration delta;
  shares in [0, 1]; the per-DAG HM-017 item equals the environment-wide one).
- Honest numbers: `null` for gaps and unknown limits; low samples flagged; estimates labelled with their method
  (`HM-005/snapshots`, `HM-007/timing`, `HM-017/range`, worker-count source for capacity shares).
- Public repository: demo `acme-*` names only.

## Performance

- DAG detail: the concurrency profile is linear in the DAG's tries and the snapshots, fed a day at a time; impact
  adds one pass over the environment's tries already read in slices and HM-017 for one DAG (one wait index, one
  bootstrap). Test: the 7-day domain
  computations stay < 1 s.
- Compare: per DAG one `dagTaskTries` read; per environment one `environmentLoad` aggregate (a measured DuckDB read
  of 42,000 tries took ~0.8 s, so 7 days of a 20,000-tries-a-day environment would not fit). Test: 4 DAGs over 7 days
  < 2 s in the application layer.

## Testing

- Domain: golden tests per module; properties as above; the advisor's REC-DAG-01 tests stay green.
- Application: mapping, gaps, findings link, comparisons, performance.
- Server: contract conformance of the three responses on demo data; demo stories (throttled DAG, noisy neighbour,
  regressed task ranked first in a run comparison); problems for bad input.
- Store: `environmentLoad` equals the domain function on random tries.
