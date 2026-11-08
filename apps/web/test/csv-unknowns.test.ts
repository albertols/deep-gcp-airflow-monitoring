import { describe, expect, it } from 'vitest';
import { toCsv } from '../src/components/csv';
import { GANTT_CSV, ganttCsvRows } from '../src/pages/dags/RunGantt';
import { RUN_CSV } from '../src/pages/dags/RunsTimeline';
import { DETAIL } from './dag-fixtures';

/** The cells of one column, by header name, from CSV text (no quoted commas in these fixtures). */
function column(csv: string, name: string): string[] {
  const [header, ...rows] = csv.trimEnd().split('\r\n');
  const i = (header ?? '').split(',').indexOf(name);
  return rows.map((r) => r.split(',')[i] ?? '');
}

describe('FR-STORE-04 / §8.1: CSV cells are empty where the value is not known', () => {
  it('FR-STORE-04: a run whose logical date is the server stand-in (its first start) exports no logical date', () => {
    const run = DETAIL.runs[0]!;
    const custom = { ...run, run_id: 'manual_backfill_1', logical_date: run.start };
    const csv = toCsv(RUN_CSV, [run, custom]);
    const dates = column(csv, 'logical_date_utc');
    expect(dates[0]).toBe(new Date(run.logical_date).toISOString());
    expect(dates[1]).toBe('');
  });

  it('FR-STORE-04: while the critical path is not known (a running run), no try is exported as off it', () => {
    const now = DETAIL.range.to;
    const path = {
      method: 'timing' as const,
      row_indexes: [0],
      duration_seconds: 600,
      waiting_seconds: 0,
      running_seconds: 600,
    };
    const finished = { ...DETAIL.gantt, critical_path: path };
    const known = column(toCsv(GANTT_CSV, ganttCsvRows(finished, Date.parse(now))), 'critical_path');
    expect(new Set(known)).toEqual(new Set(['true', 'false']));
    for (const gantt of [{ ...DETAIL.gantt, critical_path: null }, DETAIL.gantt]) {
      const unknown = column(toCsv(GANTT_CSV, ganttCsvRows(gantt, Date.parse(now))), 'critical_path');
      expect(unknown.every((c) => c === '')).toBe(true);
    }
  });
});
