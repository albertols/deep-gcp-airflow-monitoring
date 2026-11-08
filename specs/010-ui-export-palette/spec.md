# Feature 010: CSV export of every table view, and the command palette

- **Epic / milestone:** STORE, UI · M2 "DAG league table (MVP)" (spec §22.2 L4626, demo step 9 L4739)
- **Requirements:** FR-STORE-04 (CSV only), FR-UI-03, NFR-PERF, NFR-A11Y-01
- **Scope:** web (shared export helper and button, palette), plus one small additive read-only endpoint that
  lists an environment's DAG IDs for the palette.
- **Status:** implemented

## Requirements extracted from docs/spec/dcam-spec.md

- **FR-STORE-04** (L1615): "Export any table view (with filters) to CSV, Parquet or JSON; full export per
  environment and time range. — When the user exports a view, the system shall produce a file whose rows equal
  the filtered view." M2 is CSV; Parquet, JSON and the full export are M8.
- **FR-UI-03** (L1626): "Command palette (Ctrl/Cmd + K) to jump to environments, DAGs, tasks, config options,
  wiki pages and rules. — When the user types three characters, the system shall show ranked matches within
  100 ms."
- **§12.11** (L2645): keyboard-operable, visible focus, Escape closes overlays; **UV-07** (L3890): the command
  palette works by keyboard. **§12.9** (L2630): explanations are searchable from the palette (later, see below).

## User stories and acceptance criteria

1. **Export what I see (FR-STORE-04).** As an operator I export any table to CSV and get exactly its rows, in
   its order, with its filters. AC: the DAG league (search, team, tag, preset, sort), the alert rules (state
   filter), the alert history (event filter) and the DAG tasks produce files whose rows equal the rendered
   rows. Every table view has an "Export CSV" button: overview top DAGs, league and its treemap table, DAG
   limits, runs, Gantt, tasks, durations, reliability; bottleneck waiting per bucket, reasons, top DAGs and
   pools, noisy neighbours, pools, starved minutes, priority bands, sensors; schedule busiest cells, colliding
   minutes, shared schedules; advisor findings; alert rules and history; health collectors, backfill and
   requests; fleet environments and health checks.
2. **Machine-readable files.** AC: RFC 4180 (CRLF, quotes doubled, fields with `,` `"` CR or LF quoted); a
   header row; column names carry their unit (`_seconds`, `_minutes`, `_ratio` for 0–1, `_utc` for times,
   `_bytes`, `_ms`; counts and IDs have none); times are ISO 8601 UTC; numbers are plain (no grouping, no
   rounding, no "≤" or "—"); missing values are empty cells, never 0.
3. **Formula injection.** AC: a text cell starting with `=`, `+`, `-`, `@`, tab or CR is prefixed with `'`
   (DAG IDs, task IDs, owners, tags and pool names come from users' code). Numbers are never prefixed.
4. **File name.** AC: `dcam-<view>-<environment>-<range>-<data as of>.csv`, data as of as `YYYY-MM-DDTHHmmZ`;
   without data as of the range end, else `undated`; characters other than letters, digits, `.`, `_` and `-`
   become `_`.
5. **Open the palette (FR-UI-03).** AC: Ctrl+K on Windows and Linux, Cmd+K on macOS, or the "Jump to" button;
   not when focus is in another text field (the browser keeps its shortcut there); inside the palette the
   shortcut closes it, as in other palettes. An accessible dialog: focus trapped, Esc closes, a combobox with a
   listbox of options, arrow keys, Home, End and Enter, and a live count of matches.
6. **Targets.** AC: pages, environments (`/api/v1/meta`), the selected environment's DAGs
   (`GET …/dag-index`, read on open, not polled), wiki pages, advisor rules (their wiki page) and alert rules
   (the alerts page). Selecting one navigates and keeps the context bar's state; an environment switches the
   environment on the current page, as the context bar does.
7. **Ranking.** AC: exact match, then prefix, then word prefix (after `_`, `-`, `.`, a space or another
   separator), then substring; ties alphabetical (case-insensitive, then by kind). At most 50 shown, with the
   total count.
8. **Performance.** AC: 5,000 DAG IDs plus every other target answer a three-character query in under 100 ms
   (the search function, measured in the test); the index is built once per open.

## Decisions

- **DAG list.** A new `GET /api/v1/environments/{env_id}/dag-index` returns the inventory's DAG IDs with team
  and paused flag (`EnvironmentModelSource.dags`; no task tries read). The league would compute the HM-003
  sweep over the range on every open. The path is not under `…/dags/`, so it cannot shadow a DAG ID.
- **Export scope.** Each page provides its environment, range and data as of through a React context that every
  button reads, so panels need no new props. Fixed-window pages (advisor, alerts, fleet) name `24h`; the
  health page names no range.
- **Rows equal the view.** Each button exports the array the table renders (after filters, sort and limits
  such as the 50 busiest cells or the first 8 sensors), never the raw response.
- **Palette chunk.** The palette and its registries (the wiki content) load on first open, so the main chunk
  does not grow (NFR-PERF-05).

## Out of scope

- Parquet, JSON and the full export per environment and range (FR-STORE-04, M8).
- **Tasks** in the palette: task IDs exist only in task tries (`DagMeta` has none), so listing them would read
  the range's tries of every DAG. Later, with a task inventory.
- **Config options** in the palette: the web has no configuration knowledge-base registry yet.
- Explanation entries (§12.9) and glossary terms in the palette: later, with unified search (FR-WIKI-08).
- Tables that are content, not data: wiki tables, the setup page's configuration issues, a finding's evidence.
