/**
 * Client-side filtering, sorting, presets and CSV export for the DAG league table. The server sends
 * every row for the range; these run over all rows on each interaction (FR-DAGX-01, NFR-PERF-03).
 *
 * @implements FR-DAGX-01, FR-DAGX-02, FR-DAGX-07
 */
import type { DagLeagueRow } from '@dcam/contracts';

/** HM-015 / §8.9: rates and tail percentiles need at least this many samples. */
const MIN_SAMPLES = 20;
/** ⚠️ Preset thresholds are calls made in specs/001 (the spec leaves them open). */
export const FLAKY_RATE_THRESHOLD = 0.05;
export const LATE_START_WAIT_SECONDS = 5 * 60;
export const PARETO_SHARE = 0.8;

export const PRESETS = [
  { id: 'all', label: 'All DAGs', matches: () => true },
  {
    id: 'capacity-hogs',
    label: 'Capacity hogs',
    // The DAGs that, in rank order, reach 80 % of slot-seconds: the row that crosses 80 % is included.
    matches: (r: DagLeagueRow) => r.share > 0 && r.cumulative_share - r.share < PARETO_SHARE - 1e-9,
  },
  {
    id: 'flaky',
    label: 'Flaky',
    matches: (r: DagLeagueRow) => r.flaky_rate !== null && r.flaky_rate >= FLAKY_RATE_THRESHOLD,
  },
  {
    id: 'late-starters',
    label: 'Late starters',
    matches: (r: DagLeagueRow) =>
      !r.ready_wait_p95.low_sample &&
      r.ready_wait_p95.samples >= MIN_SAMPLES &&
      (r.ready_wait_p95.value_seconds ?? 0) >= LATE_START_WAIT_SECONDS,
  },
] as const;

export type PresetId = (typeof PRESETS)[number]['id'];

export interface LeagueFilter {
  readonly search: string;
  readonly team: string | null;
  readonly tag: string | null;
  readonly preset: PresetId;
}

export function filterRows(rows: readonly DagLeagueRow[], f: LeagueFilter): DagLeagueRow[] {
  const needle = f.search.trim().toLowerCase();
  const preset = PRESETS.find((p) => p.id === f.preset) ?? PRESETS[0];
  return rows.filter(
    (r) =>
      (needle === '' || r.dag_id.toLowerCase().includes(needle)) &&
      (f.team === null || r.team === f.team) &&
      (f.tag === null || r.tags.includes(f.tag)) &&
      preset.matches(r),
  );
}

export function facetValues(rows: readonly DagLeagueRow[]): { teams: string[]; tags: string[] } {
  const teams = new Set<string>();
  const tags = new Set<string>();
  for (const r of rows) {
    teams.add(r.team);
    for (const t of r.tags) tags.add(t);
  }
  const sorted = (s: Set<string>) => [...s].sort((a, b) => a.localeCompare(b));
  return { teams: sorted(teams), tags: sorted(tags) };
}

export type SortKey =
  | 'dag_id'
  | 'team'
  | 'runs'
  | 'success_rate'
  | 'run_duration_p95'
  | 'executor_slot_seconds'
  | 'share'
  | 'queue_wait_p95'
  | 'ready_wait_p95'
  | 'peak_concurrency'
  | 'open_findings';

export interface SortState {
  readonly key: SortKey;
  readonly direction: 'asc' | 'desc';
}

export const DEFAULT_SORT: SortState = { key: 'share', direction: 'desc' };

function sortValue(r: DagLeagueRow, key: SortKey): string | number | null {
  const value = r[key];
  if (typeof value === 'object' && value !== null) return value.value_seconds;
  return value;
}

/** A sorted copy; missing values (null) always go last, ties keep rank (share) order. */
export function sortRows(rows: readonly DagLeagueRow[], s: SortState): DagLeagueRow[] {
  const sign = s.direction === 'asc' ? 1 : -1;
  return rows
    .map((r, i) => ({ r, i, v: sortValue(r, s.key) }))
    .sort((a, b) => {
      if (a.v === null || b.v === null) return a.v === b.v ? a.i - b.i : a.v === null ? 1 : -1;
      const c = typeof a.v === 'string' ? a.v.localeCompare(b.v as string) : a.v - (b.v as number);
      return c !== 0 ? sign * c : a.i - b.i;
    })
    .map((x) => x.r);
}

/** Change of share vs the previous period, in percentage points; `null` for DAGs inactive then. */
export function shareChangePoints(r: DagLeagueRow): number | null {
  return r.previous_share === null ? null : (r.share - r.previous_share) * 100;
}

const CSV_COLUMNS: ReadonlyArray<readonly [string, (r: DagLeagueRow) => string | number | boolean | null]> = [
  ['dag_id', (r) => r.dag_id],
  ['team', (r) => r.team],
  ['owners', (r) => r.owners.join('; ')],
  ['tags', (r) => r.tags.join('; ')],
  ['schedule', (r) => r.schedule],
  ['paused', (r) => r.paused],
  ['runs', (r) => r.runs],
  ['failed_runs', (r) => r.failed_runs],
  ['success_rate', (r) => r.success_rate],
  ['tries', (r) => r.tries],
  ['retries', (r) => r.retries],
  ['flaky_rate', (r) => r.flaky_rate],
  ['run_duration_p50_seconds', (r) => r.run_duration_p50.value_seconds],
  ['run_duration_p95_seconds', (r) => r.run_duration_p95.value_seconds],
  ['run_duration_p95_low_sample', (r) => r.run_duration_p95.low_sample],
  ['executor_slot_seconds', (r) => r.executor_slot_seconds],
  ['share', (r) => r.share],
  ['cumulative_share', (r) => r.cumulative_share],
  ['previous_share', (r) => r.previous_share],
  ['peak_concurrency', (r) => r.peak_concurrency],
  ['queue_wait_p95_seconds', (r) => r.queue_wait_p95.value_seconds],
  ['queue_wait_p95_low_sample', (r) => r.queue_wait_p95.low_sample],
  ['ready_wait_p95_seconds', (r) => r.ready_wait_p95.value_seconds],
  ['ready_wait_p95_low_sample', (r) => r.ready_wait_p95.low_sample],
  ['open_findings', (r) => r.open_findings],
];

/** One CSV cell: quoted when needed; text that a spreadsheet would run as a formula is defused. */
function cell(v: string | number | boolean | null): string {
  if (v === null) return '';
  if (typeof v !== 'string') return String(v);
  const text = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The rows as RFC 4180 CSV (CRLF line ends), every field with its unit in the header. */
export function leagueCsv(rows: readonly DagLeagueRow[]): string {
  const header = CSV_COLUMNS.map(([name]) => name).join(',');
  const lines = rows.map((r) => CSV_COLUMNS.map(([, get]) => cell(get(r))).join(','));
  return [header, ...lines].join('\r\n') + '\r\n';
}
