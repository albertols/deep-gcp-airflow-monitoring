/**
 * CSV export of a table view (FR-STORE-04): RFC 4180 text with a header row whose column names carry their
 * unit (`_seconds`, `_minutes`, `_ratio` for 0–1, `_utc` for times, `_bytes`, `_ms`; counts and IDs have
 * none). Values are machine-readable, not the UI's formatted text: plain numbers, ISO 8601 UTC times, empty
 * cells for missing values (never 0, spec §8.1). Text that a spreadsheet would run as a formula is
 * defused, because DAG IDs, task IDs, owners, tags and pool names come from users' code.
 *
 * @implements FR-STORE-04
 */

export type CsvValue = string | number | boolean | null | undefined;

/** One column of an export: its header (with the unit) and how to read it from a row. */
export interface CsvColumn<R> {
  readonly name: string;
  readonly value: (row: R) => CsvValue;
}

/** Leading characters a spreadsheet reads as the start of a formula (OWASP "CSV injection"). */
const FORMULA_LEAD = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;

/** One CSV field: quoted when needed; formula-like text is prefixed with `'`; numbers stay plain. */
export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return String(value);
  const text = FORMULA_LEAD.test(value) ? `'${value}` : value;
  return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The rows as RFC 4180 CSV: a header row, CRLF line ends, a line break after the last record. */
export function toCsv<R>(columns: readonly CsvColumn<R>[], rows: readonly R[]): string {
  const lines = [columns.map((c) => csvCell(c.name)).join(',')];
  for (const row of rows) lines.push(columns.map((c) => csvCell(c.value(row))).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

/** A time as ISO 8601 UTC (`2026-11-05T12:00:00.000Z`); `null` for a missing or unreadable time. */
export function isoUtc(time: string | number | null | undefined): string | null {
  if (time === null || time === undefined) return null;
  const ms = typeof time === 'number' ? time : Date.parse(time);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** A list in one cell, `; `-separated. */
export const csvList = (items: readonly string[]): string => items.join('; ');

/** A duration percentile with its sample count (spec §8.9). */
interface QuantileLike {
  readonly value_seconds: number | null;
  readonly samples: number;
  readonly low_sample: boolean;
}

/**
 * Three columns for a percentile: `<name>_seconds`, `<name>_samples` and `<name>_low_sample` (true when
 * fewer than 20 samples made the value the maximum, §8.9).
 */
export function quantileColumns<R>(name: string, get: (row: R) => QuantileLike): CsvColumn<R>[] {
  return [
    { name: `${name}_seconds`, value: (r) => get(r).value_seconds },
    { name: `${name}_samples`, value: (r) => get(r).samples },
    { name: `${name}_low_sample`, value: (r) => get(r).low_sample },
  ];
}

/** What an export belongs to: shown in its file name. */
export interface ExportContext {
  readonly envId: string | null;
  /** A range preset (`24h`), or `null` for views that do not follow a range. */
  readonly range: string | null;
  /** "Data as of" of the view; `null` when nothing was collected yet. */
  readonly asOf: string | null;
  /** The range end, named instead of "data as of" when that is `null`. */
  readonly rangeEnd?: string | null;
}

const unsafe = (part: string) => part.replace(/[^A-Za-z0-9._-]+/g, '_');

/** `2026-11-05T1234Z`: the minute, in UTC, without characters file systems reject. */
function stamp(time: string | null | undefined): string | null {
  const iso = isoUtc(time);
  return iso === null ? null : `${iso.slice(0, 13)}${iso.slice(14, 16)}Z`;
}

/** `dcam-<view>-<environment>-<range>-<data as of>.csv`; parts that are not known are left out. */
export function exportFileName(view: string, context: ExportContext): string {
  const when = stamp(context.asOf) ?? stamp(context.rangeEnd) ?? 'undated';
  const parts = ['dcam', view, context.envId, context.range, when].filter(
    (p): p is string => p !== null && p !== '',
  );
  return `${parts.map(unsafe).join('-')}.csv`;
}
