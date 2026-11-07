# Plan 004: backfill on first add

## Shape

```text
af.facts ──(watermark A)──▶ af.backfill: [A − 7 d, A] by updated_at, newest first, background priority
                              └─ fact-windows.ts (af.facts' rules; af.facts moves onto it later): split on total_entries, page cap, dense second
mon.core                    mon.backfill: [B − 14 d, B] one-day chunks at 60 s, newest first, background priority
                              └─ worker-samples.ts (shared with mon.core): worker type, limits, six series → WorkerSample
both ──▶ CollectionStore.commitBackfill(rows + progress, one transaction) ──▶ meta.backfill (migration 0006)
both ──▶ ctx.reportBackfill(progress, ETA) ──▶ engine status ──▶ GET /api/v1/collection `backfill[]`
                                                                    └─ web: health page panel, history note on pages
budget.ts: background gets a guaranteed share + spare capacity; Monitoring/Composer budgets per profile
```

## Packages touched

| Package                          | Change                                                                                                                                                                                                                                                                  |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/ports`                 | Additive: `EnvironmentEntry.backfill?`, `BackfillDays`, `BackfillProgress`, `CollectionStore.backfill()`, `CollectionStore.commitBackfill()`                                                                                                                            |
| `packages/adapters/config-file`  | `environments[].backfill` (replaces the "not used yet" key), defaults, maxima, JSON Schema, Monitoring/Composer descriptions                                                                                                                                            |
| `packages/adapters/duckdb-store` | Migration `0006_backfill` (`meta.backfill`), the two store methods                                                                                                                                                                                                      |
| `packages/application`           | `fact-windows.ts` (`af.facts`' window rules, both directions), `af.backfill`, `worker-samples.ts` (extracted from `mon.core`), `mon.backfill`, `backfill.ts` (defaults, maxima, rate and ETA), budget fairness and per-profile Google budgets, `reportBackfill`, status |
| `packages/contracts`             | Additive `CollectionEnvironment.backfill` (`BackfillStatus[]`); `pnpm gen`                                                                                                                                                                                              |
| `apps/server`                    | Hard maxima agreement test; contract conformance of the new field                                                                                                                                                                                                       |
| `apps/web`                       | Health page backfill panel with (i) entries; `HistoryNote` on the DAG league and bottlenecks pages                                                                                                                                                                      |
| root                             | `dcam.config.example.yaml`                                                                                                                                                                                                                                              |

## Constitution check

- Read-only: only `GET` task instance lists and `timeSeries.list`, through the existing guarded clients; no new
  allowlist entry.
- No network outside adapters; domain untouched; application imports ports and contracts only.
- Test first: every task starts with a failing test named after its requirement ID.
- Public repository: fictitious `acme-*` data; no captured responses.
- Facts cited (Airflow 2.11.1 OpenAPI and endpoint source, spec lines); uncertain ones marked ⚠️ VERIFY.

## Budget arithmetic (standard profile, about 2,000 DAGs, 20,000 tries a day)

- Live and standard Airflow work: about 6–7 of 12 requests a minute (pools, live snapshot, facts, import errors).
- Background share: 2 a minute guaranteed (inventory about 0.3 of it), plus spare capacity while more than a
  quarter of the bucket is free. 7 days are 140,000 rows at about 80 rows a request: measured 1,777 requests and
  about 10 h on standard (16 h with the guaranteed share alone).
- Monitoring: 113 requests at 5 a minute guaranteed plus spare capacity: measured 14 min.

## Testing

- Collectors harness: window reader in both directions; `af.backfill` first run, waiting, resume after restart,
  boundary with `af.facts`, days changed, disabled; `mon.backfill` chunks, partial chunks, series counted.
- Store contract cases run against the in-memory store and DuckDB.
- Budget gate: guaranteed share under contention, standard first, spare capacity; per-profile Google budgets;
  the agreement of the hard maxima (server test, the only package that may import both).
- Engine simulation with fake time: 7 days at 20,000 tries a day on standard; requests per 60 s window never
  above 12; `af.facts` lag bounded; ETA within 30 % of the actual remaining time.
- Web: health page panel and states; history note shown only when the range starts before the covered period.
