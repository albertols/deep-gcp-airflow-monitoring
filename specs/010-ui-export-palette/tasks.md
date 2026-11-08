# Tasks 010: CSV export of every table view, and the command palette

Test tasks come before the code they cover.

## CSV export (FR-STORE-04)

- [x] T-1000 Test + code: CSV writer (RFC 4180, units in headers, ISO 8601 UTC, formula defusing) and file name
- [x] T-1001 Test + code: shared export button and scope; the league exports its filtered, sorted rows
- [ ] T-1002 Test + code: every other table view exports its rows; alert rules, alert history and DAG tasks
      equal the rendered rows

## Command palette (FR-UI-03)

- [ ] T-1010 Test + code: `GET …/dag-index` contract, use case and route (FR-UI-03, NFR-PERF)
- [ ] T-1011 Test + code: ranked search over the targets; 5,000 DAGs under 100 ms (FR-UI-03, NFR-PERF)
- [ ] T-1012 Test + code: the palette dialog, Ctrl/Cmd+K, keyboard and navigation (FR-UI-03, NFR-A11Y-01)

## Not in this feature

- [ ] T-1090 Parquet, JSON and full export (FR-STORE-04, M8)
- [ ] T-1091 Tasks and config options in the palette (spec.md "Out of scope")
