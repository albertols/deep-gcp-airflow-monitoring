# Plan 011: "Open in" deep links

## Shape

```text
dcam.config.yaml ──► live workspace: environments[].composer {project_id, location, environment}
Composer API config.airflowUri ──► composer.config ──► engine shared state ──► engine.airflowUri(envId)
demo: fictitious acme-… values                                                       │
                              GET /api/v1/meta  environments[].composer, .airflow_uri ◄┘
                                     │
apps/web App ── EnvironmentPlaceContext {mode, environment summary}
                                     │
pages ── OpenInMenu(groups) ◄── links.ts (menu items, hints, what is missing)
                                     ◄── deep-links.ts (pure URL builders: URL + URLSearchParams)
```

## Packages touched

| Package                | Change                                                                                                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts`   | `EnvironmentSummary.composer` (object, optional) and `.airflow_uri` (string or null, optional)                                                                                               |
| `packages/application` | `CollectionEngine.airflowUri(envId)`: the Airflow web server URL the engine knows                                                                                                            |
| `apps/server`          | Demo environments get fictitious places; live environments get `composer` from the file; `Workspace.airflowUri` feeds `airflow_uri` of the meta answer at request time                       |
| `apps/web`             | `deep-links.ts` URL builders, `links.ts` menu items, `OpenInMenu`, the place context in the shell; menus on the overview, DAG detail (header and task rows) and bottlenecks pages; (i) entry |

No port changes. `CollectionEngine` is an application interface: one method added.

## Constitution check

- **Read-only.** Links are anchors the user clicks; DCAM requests none of them. No new network path; the HTTP
  guard and its allowlist are untouched. Airflow addresses with credentials or a non-http(s) scheme give no
  link, and no URL carries a token.
- **Domain pure.** No domain change. The web builds URLs in pure functions with `URL`/`URLSearchParams`.
- **Test first.** Each task starts with a failing test named after FR-UI-04 (or FR-UI-05).
- **Public repository.** Fixtures and demo values are fictitious (`acme-prod-123`, `acme-composer-prod`,
  `us-central1`, `acme_orders_daily`, `*.example` hosts).
- **Facts.** Every URL form cites Google's documentation or the Airflow 2.11.1 source (spec.md table);
  undocumented forms are listed under ⚠️ VERIFY and not generated.

## Decisions

- The range comes from the page's data (`range.from`/`range.to`, the instants the server counted), not from
  the preset, so the link shows exactly what the page shows.
- Logs Explorer carries the range as a `timestamp` expression in the query (documented to set the time range)
  rather than the undocumented `timeRange` parameter.
- The grid's `base_date` is the range end for the DAG link and the run's logical date for the run and task
  links, so the run is the newest one the grid shows (`execution_date <= base_date`).
- The task's Logs Explorer link filters by DAG and the try's time window (one minute either side): Composer
  documents no task label.
- A self-managed Airflow shows one disabled Cloud console item that says why there is none.
- Demo Airflow addresses use the reserved `.example` domain (RFC 2606), so they never reach a real host.

## Testing

- Web unit: every URL builder, odd IDs (spaces, `+`, `:`, `/`, `;`, quotes), unsafe Airflow addresses, the
  menu items and their missing reasons.
- Web component: the menu's anchors (new tab, `noopener noreferrer`), keyboard use, disabled items with their
  reason, demo note, (i) entry; pages show the menu with the right links.
- Application: the engine reports the Airflow URL once `composer.config` sets it.
- Server: demo and live meta conform to the contract and carry the places.
