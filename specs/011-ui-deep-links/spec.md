# Feature 011: "Open in" deep links

- **Epic / milestone:** UI · M2 (spec §22.2)
- **Requirements:** FR-UI-04 ("Open in" deep links); FR-UI-05 for the menu's (i) entry; UV-12 (deep links out)
- **Status:** done (browser validation open, see tasks.md)

## Intent

DCAM shows which DAGs use capacity and why work waits. The next step is often in another tool: the run in
the Airflow grid, the task's log, the environment's logs in Logs Explorer. Today the user retypes the
environment, DAG, run and time range by hand. This feature adds an "Open in" menu that opens the same
environment, DAG, run or task in the Google Cloud console and the Airflow UI, with the page's time range
wherever the target accepts one in a documented form, and says what to set by hand where it does not.

## User stories

- As an on-call engineer on a DAG's page, I want to open the selected run, or one task's log, in the Airflow
  UI in one click (FR-UI-04).
- As a platform engineer, I want the environment's or the DAG's worker logs in Logs Explorer over the range I
  am looking at, without writing the query (FR-UI-04, Appendix C base filter).
- As a user of a self-managed Airflow, I want Airflow UI links only, and to be told why there are no Cloud
  console links.
- As a demo user, I want to know that the links lead to fictitious resources.

## Requirements extracted from docs/spec/dcam-spec.md (line numbers refer to that file)

- **FR-UI-04** (L1627): "'Open in' deep links: Cloud console (Composer environment, Metrics Explorer, Logs
  Explorer with a prefilled query) and Airflow UI (DAG, run, task log)." Acceptance: "The system shall
  generate deep links that open the corresponding resource with the same time range."
- **UV-12** (L3895): "Links to the Cloud console, Airflow UI and documentation open in a new tab with the
  right context."
- **§12.1 principle 4** (L2413): "Progressive disclosure. Summary → chart → table → raw record → source deep
  link."
- **§7.3** (L580–L584): Composer logs use the `cloud_composer_environment` resource type; task log entries
  carry `workflow` (the DAG ID), `execution-date` and `try-number`; `task-id` and `map-index` are not
  confirmed (⚠️ VERIFY in the spec).
- **Appendix C.2** (L5141): base filter `resource.type`, `resource.labels.project_id`, `location`,
  `environment_name` and a `timestamp` window.
- **Non-negotiable 1** (CLAUDE.md): read-only by construction; outbound HTTP only through the HTTP guard.

## Acceptance criteria

1. Every link is an anchor that opens in a new tab (`target="_blank"`, `rel="noopener noreferrer"`). DCAM
   makes no request to these URLs; the HTTP guard and its allowlist are unchanged.
2. URLs are built with `URL` and `URLSearchParams`; every ID is encoded, including run IDs such as
   `scheduled__2026-11-05T00:00:00+00:00` and IDs with spaces. No URL carries a token or credential; an
   Airflow address with a user name or password, or not http(s), gives no link.
3. Cloud console links (Composer environments only): the Composer environments page of the project, Metrics
   Explorer of the project, and Logs Explorer with the environment's base filter and the page's range as a
   `timestamp` expression in the query (environment, DAG worker logs, task worker logs).
4. Airflow UI links: DAGs (home), the DAG's grid up to the range end, the selected run, a task's log in the
   selected run, and the pools list.
5. Where a target takes no range in a documented form (Composer page, Metrics Explorer), the menu item says
   which range to set there. The (i) entry says that time zones follow each tool's own setting.
6. A missing field never gives a broken link: the item is disabled and says what is missing and what to do
   (Airflow address not known yet; not a Composer environment; no run in the range; no try in the run).
7. In demo mode the menu says the links lead to fictitious acme resources.
8. The menu has an (i) explanation entry and works with the keyboard (open, move, follow, Escape).
9. `/api/v1/meta` environments carry `composer` (project, location, environment) and `airflow_uri`
   (additive, optional): from the configuration file and the Composer API (`config.airflowUri`) in live mode,
   fictitious `acme-…` values in demo mode; a self-managed Airflow has its configured `baseUrl` and no
   `composer`.

## Where the URL formats come from (checked 2026-11-08)

| Link                   | Form                                                                                                | Source                                                                                                                                                                                                                                                                                                                                              |
| ---------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Logs Explorer          | `https://console.cloud.google.com/logs/query;query=<URL-encoded>?project=<id>`                      | Google example on "Agent Platform: logging" (`…/logs/query;query=severity%3DINFO%0A…;duration=…?project=PROJECT_ID`, "the query has been appropriately url-encoded"), https://docs.cloud.google.com/gemini-enterprise-agent-platform/scale/runtime/logging                                                                                          |
| Range in Logs Explorer | `timestamp>="FROM" AND timestamp<"TO"` in the query                                                 | "If the query-editor field contains an expression with a timestamp, then the time-range selector is disabled, and the query uses the timestamp expression as its time-range restriction", https://docs.cloud.google.com/logging/docs/view/building-queries; RFC 3339 values, https://docs.cloud.google.com/logging/docs/view/logging-query-language |
| Log labels             | `labels.workflow`, `log_id("airflow-worker")`                                                       | Composer 3 quickstart, https://docs.cloud.google.com/composer/docs/composer-3/run-apache-airflow-dag-gcloud; troubleshooting DAGs, https://docs.cloud.google.com/composer/docs/composer-3/troubleshooting-dags; resource labels, https://docs.cloud.google.com/monitoring/api/resources                                                             |
| Composer environments  | `https://console.cloud.google.com/composer/environments?project=<id>`                               | "Go to Environments" links on the Composer 3 pages; "click the name of your environment… Go to the Monitoring tab"                                                                                                                                                                                                                                  |
| Metrics Explorer       | `https://console.cloud.google.com/monitoring/metrics-explorer?project=<id>`                         | https://docs.cloud.google.com/monitoring/charts/metrics-explorer                                                                                                                                                                                                                                                                                    |
| Airflow UI base        | Composer `config.airflowUri`: "The URI of the Apache Airflow Web UI hosted within this environment" | https://docs.cloud.google.com/composer/docs/reference/rest/v1/projects.locations.environments                                                                                                                                                                                                                                                       |
| Airflow routes         | `/home`, `/dags/<dag_id>/grid`, `/pool/list/`                                                       | `airflow/www/views.py` at tag 2.11.1 (`@expose("/home")`, `@expose("/dags/<string:dag_id>/grid")`, `PoolModelView.route_base = "/pool"`); Flask-AppBuilder `ModelView.list` `@expose("/list/")`                                                                                                                                                     |
| Grid parameters        | `dag_run_id`, `task_id`, `tab=logs`, `base_date`                                                    | `airflow/www/static/js/dag/useSelection.ts` (`RUN_ID = "dag_run_id"`, `task_id`), `dag/details/index.tsx` (`TAB_PARAM = "tab"`, `"logs"`), `dag/useFilters.tsx` (`BASE_DATE_PARAM = "base_date"`); `grid_data` keeps runs with `execution_date <= base_date` (views.py)                                                                             |

## ⚠️ VERIFY (not generated, or generated with a caveat)

- No time range for the Composer environment page or Metrics Explorer: Google documents no URL parameter
  for either. The menu says which range to set. `timeRange`, `cursorTimestamp` and `storageScope` on Logs
  Explorer are not documented either, so DCAM uses the documented `timestamp` expression instead.
- The environment's own console page (`/composer/environments/detail/<location>/<name>/…`) is not
  documented; DCAM links the documented environments list of the project.
- `?project=` on the Composer and Metrics Explorer pages: the console-wide parameter, documented only in
  Logs Explorer examples.
- Composer task-log labels `task-id`, `try-number`, `map-index` are not documented; the `execution-date`
  value format is ambiguous (the quickstart's text says run ID, its example is a logical date). DCAM's task
  log query filters by `labels.workflow` and the try's time window only, and says so.
- For a custom run ID DCAM has no logical date and the run's first task start stands in (`dags.ts`). The
  grid's `base_date` then follows that start: a run triggered with an older logical date can sit more than
  the grid's default number of runs back. The run and task hints say so and tell the user to raise the number
  of runs in the grid.
- No time zone parameter is documented for Logs Explorer (a preference in its time-range selector) or the
  Airflow 2.11.1 grid; each tool shows its own zone.

## Out of scope

- Per-row menus on the bottleneck tables: their DAGs link to DCAM's DAG page, which has the menu.
- Links from findings, alerts, reports and the wiki (FR-TASK-03, FR-INC-02, FR-RPT-01, FR-WIKI-02).
- Mapped task instances (`map_index`): DCAM's Gantt rows do not carry it; the grid opens the task's summary.
- Airflow 3 UI routes (M4).
