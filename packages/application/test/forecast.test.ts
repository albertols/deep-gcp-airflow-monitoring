import { describe, expect, it } from 'vitest';
import type { DagMeta, EnvironmentConfig } from '@dcam/domain';
import type { EnvironmentModelSource, StoredTaskTry, TaskInstanceStore } from '@dcam/ports';
import { getForecast } from '../src/index';

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
const NOW = Date.UTC(2026, 10, 5, 12, 0);
const config: EnvironmentConfig = {
  envId: 'acme-prod',
  tier: 'prod',
  composerImage: 'composer-3-airflow-2.11.1-build.22',
  airflowVersion: '2.11.1',
  parallelism: 30,
  schedulers: 1,
  maxActiveTasksPerDag: 16,
  maxActiveRunsPerDag: 25,
  workerConcurrency: 10,
  minWorkers: 1,
  maxWorkers: 2,
  pools: [{ name: 'default_pool', slots: 128 }],
  limitSources: { workerConcurrency: 'override', parallelism: 'override' },
};
const dag = (dagId: string, schedule: string): DagMeta => ({
  dagId,
  fileloc: `/home/airflow/gcs/dags/${dagId}.py`,
  owners: ['acme'],
  tags: [],
  team: 'acme',
  schedule,
  maxActiveTasks: 16,
  maxActiveRuns: 16,
  catchup: false,
  paused: false,
});
const tryOf = (dagId: string, runId: string, taskId: string, start: number, end: number): StoredTaskTry => ({
  envId: 'acme-prod',
  dagId,
  runId,
  taskId,
  mapIndex: -1,
  tryNumber: 1,
  pool: 'default_pool',
  poolSlots: 1,
  state: 'success',
  readyAt: null,
  queuedAt: start,
  startAt: start,
  endAt: end,
  sourceUpdatedAt: null,
  operator: 'PythonOperator',
});

/** A nightly rebuild with 25 tries for 30 minutes at 01:30 over `days` days; an hourly DAG over the last 3 days. */
function history(days: number): StoredTaskTry[] {
  const tries: StoredTaskTry[] = [];
  for (let d = 0; d < days; d++) {
    const start = Date.UTC(2026, 10, 5 - d, 1, 30);
    for (let i = 0; i < 25; i++)
      tries.push(tryOf('acme_rebuild_nightly', `scheduled__${d}`, `part_${i}`, start, start + 30 * MIN));
  }
  for (let t = NOW - 3 * DAY; t < NOW; t += H)
    tries.push(tryOf('acme_orders_hourly', `scheduled__${t}`, 'load', t, t + 10 * MIN));
  return tries;
}

function deps(tries: StoredTaskTry[], reads: Array<[number, number]> = []) {
  const store: TaskInstanceStore = {
    upsertTaskTries: async () => {},
    taskTries: async (_env, from, to) => {
      reads.push([from, to]);
      return tries;
    },
    countTaskTries: async () => tries.length,
    historyStart: async () => (tries.length ? Math.min(...tries.map((t) => t.startAt ?? Infinity)) : null),
  };
  const model: EnvironmentModelSource = {
    config: async () => config,
    dags: async () => [dag('acme_rebuild_nightly', '30 1 * * *'), dag('acme_orders_hourly', '0 * * * *')],
    snapshots: async () => [],
    workerSamples: async () => [],
    platformHealth: async () => {
      throw new Error('not read');
    },
  };
  return { store, model, clock: { now: () => NOW } };
}

describe('getForecast (HM-010, FR-BOTL-05)', () => {
  it('HM-010: reads 28 days of task history and maps the forecast to the contract', async () => {
    const reads: Array<[number, number]> = [];
    const f = await getForecast(deps(history(20), reads), {
      envId: 'acme-prod',
      sources: ['SRC-AF-API', 'SRC-COMPOSER'],
    });
    expect(reads).toEqual([[NOW - 28 * DAY, NOW]]);
    expect(f).toMatchObject({
      env_id: 'acme-prod',
      horizon: { from: '2026-11-05T12:00:00.000Z', to: '2026-11-06T12:00:00.000Z' },
      sources: ['SRC-AF-API', 'SRC-COMPOSER'],
      method: 'HM-010/run-profiles',
      estimate: true,
      evaluated: true,
      not_evaluated_reason: null,
      time_zone: 'UTC',
      step_seconds: 300,
      pool_step_seconds: 900,
      planned_runs: 25,
      unscheduled_dags: 0,
      dag_count: 2,
      capacity: {
        worker_slots_at_max: 20,
        worker_concurrency_source: 'override',
        max_workers: 2,
        parallelism_total: 30,
      },
    });
    expect(f.history).toEqual({
      from: '2026-10-17T01:30:00.000Z',
      to: '2026-11-05T12:00:00.000Z',
      days: 19 + 10.5 / 24,
      read_days: 28,
      min_days: 14,
      runs_profiled: 20 + 72,
    });
    expect(f.data_as_of).toBe('2026-11-05T11:10:00.000Z');
    expect(f.series).toHaveLength(288);
    expect(f.series[162]).toEqual({
      start: '2026-11-06T01:30:00.000Z',
      p10: 25,
      p50: 25,
      p90: 25,
      baseline: 0,
    });
    expect(f.saturation).toEqual({
      evaluated: true,
      not_evaluated_reason: null,
      band: 'p50',
      min_minutes: 15,
      windows: [
        {
          start: '2026-11-06T01:30:00.000Z',
          end: '2026-11-06T02:00:00.000Z',
          minutes: 30,
          peak_slots: 25,
          capacity_slots: 20,
          low_confidence: false,
          top_dags: [{ dag_id: 'acme_rebuild_nightly', slot_minutes: 750, share: 1, low_confidence: false }],
        },
      ],
    });
    expect(f.risk.band).toBe('p90');
    expect(f.dags[0]).toEqual({
      dag_id: 'acme_rebuild_nightly',
      schedule: '30 1 * * *',
      planned_runs: 1,
      runs_profiled: 20,
      history_days: 19 + 10.5 / 24,
      low_confidence: false,
      slot_minutes: 750,
      peak_slots: 25,
    });
    expect(f.pools[0]).toMatchObject({
      name: 'default_pool',
      slots: 128,
      peak_slots: 25,
      peak_at: '2026-11-06T01:30:00.000Z',
      minutes_over: 0,
    });
    expect(f.pools[0]?.series).toHaveLength(96);
    expect(f.confidence).toMatchObject({
      level: 'normal',
      dags: 2,
      low_confidence_dags: 1,
      dags_without_history: 0,
    });
    expect(f.confidence.summary).toBe(
      '1 of 2 DAGs has less than 14 days of history; its part of the forecast is low confidence.',
    );
  });

  it('HM-010: with a few days of history the forecast says plainly that it is low confidence', async () => {
    const f = await getForecast(deps(history(3)), { envId: 'acme-prod', sources: ['DEMO'] });
    expect(f.sources).toEqual(['DEMO']);
    expect(f.confidence.level).toBe('low');
    expect(f.confidence.low_confidence_dags).toBe(2);
    expect(f.confidence.low_confidence_share).toBe(1);
    expect(f.confidence.summary).toBe(
      'Low confidence: 2 of 2 DAGs have less than 14 days of history (DCAM has 3 days), so the forecast rests on few runs. It firms up as history builds.',
    );
    expect(f.saturation.windows[0]?.low_confidence).toBe(true);
  });

  it('NFR-DATA-03: without task history there is no forecast, and it says why', async () => {
    const f = await getForecast(deps([]), { envId: 'acme-prod', sources: ['SRC-AF-API'] });
    expect(f.evaluated).toBe(false);
    expect(f.not_evaluated_reason).toMatch(/history/);
    expect(f.data_as_of).toBeNull();
    expect(f.history.from).toBeNull();
    expect(f.series.every((s) => s.p50 === null)).toBe(true);
    expect(f.confidence).toMatchObject({ level: 'low', dags_without_history: 2, low_confidence_share: null });
    expect(f.confidence.summary).toMatch(/^No forecast yet/);
    expect(f.dags.every((d) => d.slot_minutes === null)).toBe(true);
  });
});
