import { describe, expect, it } from 'vitest';
import { RULE_THRESHOLDS, type DagMeta } from '@dcam/domain';
import type { EnvironmentModelSource, StoredTaskTry, TaskInstanceStore } from '@dcam/ports';
import { getScheduleIntelligence } from '../src/index';

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const MIN = 60_000;

const dag = (dagId: string, schedule: string, paused = false): DagMeta => ({
  dagId,
  fileloc: `/home/airflow/gcs/dags/${dagId}.py`,
  owners: ['acme'],
  tags: [],
  team: 'acme',
  schedule,
  maxActiveTasks: 16,
  maxActiveRuns: 16,
  catchup: false,
  paused,
});
const DAGS = [
  dag('acme_orders_hourly', '0 * * * *'),
  dag('acme_billing_hourly', '0 * * * *'),
  dag('acme_finance_nightly', '30 2 * * *'),
  dag('acme_manual', 'None'),
];
const run = (runId: string, startAt: number): StoredTaskTry => ({
  envId: 'acme-prod',
  dagId: 'acme_orders_hourly',
  runId,
  taskId: 'extract',
  mapIndex: -1,
  tryNumber: 1,
  pool: 'default_pool',
  poolSlots: 1,
  state: 'success',
  readyAt: null,
  queuedAt: startAt,
  startAt,
  endAt: startAt + MIN,
  sourceUpdatedAt: null,
  operator: 'PythonOperator',
});
const tries = [run('r1', NOW - 60 * MIN + 30_000), run('r2', NOW - 120 * MIN + 2 * MIN)];

const store: TaskInstanceStore = {
  upsertTaskTries: async () => {},
  taskTries: async () => tries,
  countTaskTries: async () => tries.length,
};
const model = (dags: DagMeta[]): EnvironmentModelSource => ({
  config: async () => null,
  dags: async () => dags,
  snapshots: async () => [],
  workerSamples: async () => [],
  platformHealth: async () => ({
    envHealthyRatio: null,
    dbHealthyRatio: null,
    heartbeatCompleteness: null,
    webServerHealthyRatio: null,
    dbCpuMemoryMax: null,
    zombies24h: null,
    workerRestarts24h: null,
    importErrors: null,
    parseLoopP95Seconds: null,
  }),
});
const deps = { store, model: model(DAGS), clock: { now: () => NOW } };
const query = { envId: 'acme-prod', range: '24h' as const, sources: ['SRC-AF-API' as const] };

describe('getScheduleIntelligence (S-17, FR-BOTL-03, HM-009)', () => {
  it('FR-BOTL-03: planned starts per hour and minute, as non-empty cells, in UTC', async () => {
    const s = await getScheduleIntelligence(deps, query);
    expect(s.time_zone).toBe('UTC');
    expect(s.planned.cells).toHaveLength(24 + 1);
    expect(s.planned.cells).toContainEqual({ hour: 2, minute: 30, starts_per_day: 1 });
    expect(s.planned.cells).toContainEqual({ hour: 5, minute: 0, starts_per_day: 2 });
  });

  it('FR-BOTL-03: actual run starts over the range, by the first try of each run', async () => {
    const s = await getScheduleIntelligence(deps, query);
    expect(s.actual).toEqual({
      runs: 2,
      days: 1,
      cells: [
        { hour: 10, minute: 2, runs: 1 },
        { hour: 11, minute: 0, runs: 1 },
      ],
    });
  });

  it('HM-009 / REC-SCHED-01: the collision index against the rule threshold, and the most colliding minutes and schedules', async () => {
    const s = await getScheduleIntelligence(deps, query);
    expect(s.collision).toEqual({
      index: 48 / 49,
      busiest_minute: 0,
      total_daily_starts: 49,
      threshold: RULE_THRESHOLDS['REC-SCHED-01'].minCollisionIndex,
      scheduled_dags: 3,
      unscheduled_dags: 1,
    });
    expect(s.top_minutes[0]).toMatchObject({
      minute: 0,
      dags: 2,
      schedules: [{ schedule: '0 * * * *', dags: 2 }],
    });
    expect(s.top_schedules[0]).toMatchObject({ schedule: '0 * * * *', dags: 2, starts_per_day: 48 });
  });

  it('FR-UI-07 / FR-UI-08: with nothing collected the page is empty, has no data time and no source', async () => {
    const empty = await getScheduleIntelligence(
      { store: { ...store, taskTries: async () => [] }, model: model([]), clock: deps.clock },
      query,
    );
    expect(empty.data_as_of).toBeNull();
    expect(empty.sources).toEqual([]);
    expect(empty.planned.cells).toEqual([]);
    expect(empty.collision.busiest_minute).toBeNull();
  });
});
