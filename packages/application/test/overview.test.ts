import { describe, expect, it } from 'vitest';
import type { StoredTaskTry } from '@dcam/ports';
import { getEnvironmentOverview, paretoCount } from '../src/index';

const T0 = Date.UTC(2026, 10, 5, 0, 0, 0);
const H = 3_600_000;
const tryOf = (dagId: string, startAt: number, endAt: number | null): StoredTaskTry => ({
  envId: 'acme-prod',
  dagId,
  runId: 'r',
  taskId: `t-${startAt}`,
  mapIndex: -1,
  tryNumber: 1,
  pool: 'default_pool',
  poolSlots: 1,
  state: endAt === null ? 'running' : 'success',
  queuedAt: startAt,
  readyAt: null,
  startAt,
  endAt,
  operator: null,
  sourceUpdatedAt: endAt ?? startAt,
});

const store = (rows: StoredTaskTry[]) => ({
  upsertTaskTries: async () => {},
  countTaskTries: async () => rows.length,
  taskTries: async () => rows,
});

describe('FR-DAGX-03 concentration', () => {
  it('FR-DAGX-03: counts how many DAGs account for 80 % of slot-seconds', () => {
    expect(paretoCount([50, 30, 10, 10])).toBe(2);
    expect(paretoCount([25, 25, 25, 25])).toBe(4);
    expect(paretoCount([])).toBe(0);
  });
});

describe('HM-003 / HM-011 environment overview', () => {
  it('HM-003: ranks DAGs by executor slot-seconds with shares, peak concurrency and freshness', async () => {
    const now = T0 + 24 * H;
    const rows = [
      tryOf('heavy', T0 + H, T0 + 4 * H),
      tryOf('heavy', T0 + H, T0 + 2 * H),
      tryOf('light', T0 + 3 * H, T0 + 3 * H + 30 * 60_000),
      tryOf('live', now - 60_000, null),
    ];
    const o = await getEnvironmentOverview(
      { store: store(rows), clock: { now: () => now } },
      { envId: 'acme-prod', range: '24h', sources: ['DEMO'] },
    );
    expect(o.env_id).toBe('acme-prod');
    expect(o.range).toEqual({ from: new Date(T0).toISOString(), to: new Date(now).toISOString() });
    expect(o.total_executor_slot_seconds).toBe(4 * 3600 + 1800 + 60);
    expect(o.top_dags.map((d) => d.dag_id)).toEqual(['heavy', 'light', 'live']);
    expect(o.top_dags[0]?.share).toBeCloseTo((4 * 3600) / (4 * 3600 + 1860), 6);
    expect(o.peak_concurrency).toBe(2);
    expect(o.dag_count).toBe(3);
    expect(o.pareto_80_dag_count).toBe(1);
    expect(o.data_as_of).toBe(new Date(now).toISOString());
    expect(o.sources).toEqual(['DEMO']);
    expect(o.approximate).toBe(false);
  });
});
