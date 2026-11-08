import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SORT,
  facetValues,
  filterRows,
  leagueCsv,
  parsePreset,
  parseSort,
  shareChangePoints,
  sortParam,
  sortRows,
  type PresetId,
} from '../src/pages/dags/league';
import { queueWaitBand, squarify, treemapLayout } from '../src/pages/dags/treemap-layout';
import { q, row, ROWS } from './dag-fixtures';

const ids = (rows: readonly { dag_id: string }[]) => rows.map((r) => r.dag_id);

describe('FR-DAGX-01 filter and sort', () => {
  it('FR-DAGX-01: sorts by any column, nulls last in both directions', () => {
    expect(ids(sortRows(ROWS, { key: 'share', direction: 'desc' }))).toEqual([
      'orders_daily',
      'fraud_scoring_hourly',
      'partner_crm_sync',
      'idle_export',
    ]);
    expect(ids(sortRows(ROWS, { key: 'dag_id', direction: 'asc' }))[0]).toBe('fraud_scoring_hourly');
    const bySuccess = ids(sortRows(ROWS, { key: 'success_rate', direction: 'asc' }));
    expect(bySuccess[0]).toBe('fraud_scoring_hourly');
    expect(bySuccess.at(-1)).toBe('idle_export');
    expect(ids(sortRows(ROWS, { key: 'queue_wait_p95', direction: 'desc' }))[0]).toBe('partner_crm_sync');
    expect(ids(sortRows(ROWS, { key: 'queue_wait_p95', direction: 'desc' })).at(-1)).toBe('idle_export');
  });

  it('FR-DAGX-01: filters by search text, team and tag', () => {
    expect(ids(filterRows(ROWS, { search: 'CRM', team: null, tag: null, preset: 'all' }))).toEqual([
      'partner_crm_sync',
    ]);
    expect(ids(filterRows(ROWS, { search: '', team: 'ml-platform', tag: null, preset: 'all' }))).toEqual([
      'fraud_scoring_hourly',
    ]);
    expect(ids(filterRows(ROWS, { search: '', team: null, tag: 'hourly', preset: 'all' }))).toEqual([
      'fraud_scoring_hourly',
      'partner_crm_sync',
    ]);
    expect(facetValues(ROWS).teams).toEqual(['analytics', 'customer', 'finance-data', 'ml-platform']);
    expect(facetValues(ROWS).tags).toContain('partner_api');
  });
});

describe('FR-UI-02 league state in the URL', () => {
  it('FR-UI-02: sort and preset round-trip through URL values; unknown values fall back to the defaults', () => {
    expect(sortParam({ key: 'runs', direction: 'asc' })).toBe('runs.asc');
    expect(parseSort('runs.asc')).toEqual({ key: 'runs', direction: 'asc' });
    expect(parseSort(sortParam(DEFAULT_SORT))).toEqual(DEFAULT_SORT);
    for (const bad of [undefined, '', 'runs', 'nope.asc', 'runs.up', '__proto__.desc'])
      expect(parseSort(bad)).toEqual(DEFAULT_SORT);
    expect(parsePreset('flaky')).toBe('flaky');
    expect(parsePreset('nope')).toBe('all');
    expect(parsePreset(undefined)).toBe('all');
  });
});

describe('FR-DAGX-07 presets', () => {
  const preset = (id: PresetId) => ids(filterRows(ROWS, { search: '', team: null, tag: null, preset: id }));

  it('FR-DAGX-07: capacity hogs are the DAGs up to 80 % of slot-seconds', () => {
    expect(preset('capacity-hogs')).toEqual(['orders_daily', 'fraud_scoring_hourly']);
  });

  it('FR-DAGX-07: flaky means a flaky rate of at least 5 % with enough task instances', () => {
    expect(preset('flaky')).toEqual(['fraud_scoring_hourly']);
  });

  it('FR-DAGX-07: late starters wait at least 5 min from ready to start (p95, 20 or more tries)', () => {
    expect(preset('late-starters')).toEqual(['partner_crm_sync']);
    const lowSample = row('few', { ready_wait_p95: q(900, 5, true) });
    // Queue wait alone does not make a late starter: most waiting happens before the queue.
    const queuedOnly = row('queued', { queue_wait_p95: q(900), ready_wait_p95: q(60) });
    expect(
      ids(
        filterRows([lowSample, queuedOnly], { search: '', team: null, tag: null, preset: 'late-starters' }),
      ),
    ).toEqual([]);
  });
});

describe('FR-DAGX-02 change vs previous period and export', () => {
  it('FR-DAGX-02: share change in percentage points, null for DAGs new in this period', () => {
    expect(shareChangePoints(ROWS[0]!)).toBeCloseTo(10, 9);
    expect(shareChangePoints(ROWS[2]!)).toBeNull();
  });

  it('FR-DAGX-02: CSV export has a header, units and safe cells', () => {
    const csv = leagueCsv([row('a,b', { tags: ['=cmd()', 'x"y'] })]);
    const [header, line] = csv.split('\r\n');
    expect(header).toContain('dag_id,team,owners,tags');
    expect(header).toContain('executor_slot_seconds');
    expect(header).toContain('queue_wait_p95_seconds');
    expect(line?.startsWith('"a,b",finance-data,finance-data-oncall,')).toBe(true);
    expect(line).toContain(`"'=cmd(); x""y"`);
  });
});

describe('FR-DAGX-04 treemap layout', () => {
  const rect = { x: 0, y: 0, width: 600, height: 400 };

  it('FR-DAGX-04: squarified tiles fill the rectangle with areas proportional to their values', () => {
    const tiles = squarify(
      [6, 6, 4, 3, 2, 2, 1].map((value, i) => ({ id: `t${i}`, value })),
      rect,
    );
    const total = 24;
    for (const t of tiles) {
      expect(t.width * t.height).toBeCloseTo(((rect.width * rect.height) / total) * t.value, 6);
      expect(t.x).toBeGreaterThanOrEqual(-1e-9);
      expect(t.y).toBeGreaterThanOrEqual(-1e-9);
      expect(t.x + t.width).toBeLessThanOrEqual(rect.width + 1e-9);
      expect(t.y + t.height).toBeLessThanOrEqual(rect.height + 1e-9);
    }
    const worst = Math.max(...tiles.map((t) => Math.max(t.width / t.height, t.height / t.width)));
    expect(worst).toBeLessThan(3);
  });

  it('FR-DAGX-04: groups DAGs by team, skips inactive DAGs and folds small ones into "other"', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      row(`d${i}`, { team: i % 2 ? 'odd' : 'even', executor_slot_seconds: 100 + i }),
    );
    const layout = treemapLayout([...many, ROWS[3]!], rect, { maxTiles: 10 });
    expect(layout.map((g) => g.team).sort()).toEqual(['even', 'odd']);
    const tiles = layout.flatMap((g) => g.tiles);
    expect(tiles.filter((t) => t.kind === 'dag')).toHaveLength(10);
    expect(tiles.filter((t) => t.kind === 'other').map((t) => t.dagCount)).toEqual(
      expect.arrayContaining([expect.any(Number)]),
    );
    expect(tiles.reduce((s, t) => s + t.value, 0)).toBe(
      many.reduce((s, r) => s + r.executor_slot_seconds, 0),
    );
  });

  it('FR-DAGX-04: colours by p95 queue wait band, with no colour claim for missing data', () => {
    expect(queueWaitBand(q(null, 0, true))).toBe('none');
    expect(queueWaitBand(q(20))).toBe('low');
    expect(queueWaitBand(q(120))).toBe('medium');
    expect(queueWaitBand(q(600))).toBe('high');
  });
});
