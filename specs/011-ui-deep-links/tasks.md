# Tasks 011: "Open in" deep links

Test tasks come before the code they cover.

## URLs

- [x] T-1100 Test + code: URL builders for the Composer environments page, Metrics Explorer, Logs Explorer with
      a query and a range, and the Airflow UI home, DAG grid, run, task log and pools; odd IDs encoded; unsafe
      Airflow addresses refused (FR-UI-04)
- [ ] T-1101 Test + code: menu items per page with hints and what is missing (FR-UI-04)

## Data

- [x] T-1102 Test + code: contract `EnvironmentSummary.composer` and `.airflow_uri`; demo meta with fictitious
      places (FR-UI-04, FR-EMU-01)
- [ ] T-1103 Test + code: engine `airflowUri`; live meta with the Composer place from the file and the Airflow
      address from the Composer API or the configured `baseUrl` (FR-UI-04)

## UI

- [ ] T-1104 Test + code: `OpenInMenu`: anchors in a new tab, keyboard, disabled items with their reason, demo
      note, (i) entry (FR-UI-04, FR-UI-05)
- [ ] T-1105 Test + code: menus on the overview, DAG detail (header and task rows) and bottlenecks pages
      (FR-UI-04)

## Done

- [ ] T-1190 Browser validation against `pnpm dcam --demo` (UV-12); code review; `pnpm check`
