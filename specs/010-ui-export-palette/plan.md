# Plan 010: CSV export of every table view, and the command palette

## Shape

```text
web          components/csv.ts            CsvColumn, toCsv (RFC 4180, formula defusing), isoUtc, exportFileName
             components/ExportCsv.tsx     ExportScope (env, range, data as of) and ExportCsvButton (download)
             pages/*                      one column list per table, next to the table it exports
             components/palette/search.ts PaletteTarget, buildPaletteIndex, searchPalette (ranked, O(n))
             components/palette/targets.ts pages, environments, DAGs, wiki pages, advisor and alert rules
             components/CommandPalette.tsx accessible dialog (combobox + listbox), lazy chunk
             App.tsx                       Ctrl/Cmd+K listener, "Jump to" button, navigation with linkTo
contracts    GET /api/v1/environments/{env_id}/dag-index → DagIndex { env_id, dags: [{ dag_id, team, paused }] }
application  dag-index.ts                  getDagIndex: the inventory's DAGs, sorted by ID
server       routes/dags.ts                + the dag-index route, memoised like the other views
```

## Packages touched

| Package                | Change                                                                      |
| ---------------------- | --------------------------------------------------------------------------- |
| `apps/web`             | Export helper and button on every table view; palette; `getDagIndex` client |
| `packages/contracts`   | One path and the `DagIndex` schema (additive); `pnpm gen`                   |
| `packages/application` | `getDagIndex` (reads `EnvironmentModelSource.dags`)                         |
| `apps/server`          | The route, tested on the demo workspace                                     |

No port, domain, store or collector changes. `DcamApi.getDagIndex` is optional, so page tests' fakes stay valid
and a palette without it lists no DAGs.

## Constitution check

- Read-only: the new endpoint reads the inventory DCAM already stores; no outbound call.
- Domain untouched; the palette's search and the CSV writer are pure functions in the web.
- Test first: each task starts with a failing test named after FR-STORE-04 or FR-UI-03.
- Public repository: `acme_*` fixtures and the demo only.
- No Composer or Airflow facts are introduced.

## Testing

- `csv-export.test.ts`: quoting, formula defusing, numbers, times, file names (FR-STORE-04).
- `export-views.test.tsx`: the league, alert rules, alert history and DAG tasks export the rendered rows, in
  order, after filters and sort.
- `palette-search.test.ts`: ranking tiers and ties; 5,000 DAGs plus the registries under 100 ms.
- `command-palette.test.tsx`: shortcut per platform, not in text fields, keyboard and screen-reader roles,
  navigation keeps the context bar.
- Application and server tests for `GET …/dag-index` (contract conformance on the demo).
