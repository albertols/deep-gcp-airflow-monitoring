import { describe, expect, it } from 'vitest';
import {
  UNKNOWN_LIMIT,
  type EnvironmentConfig,
  type LiveSnapshot,
  type SnapshotTaskInstance,
  type WorkerSample,
} from '@dcam/domain';
import type { EnvironmentModelSource, StoredTaskTry, TaskInstanceStore } from '@dcam/ports';
import { getBottlenecks } from '../src/index';

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const config: EnvironmentConfig = {
  envId: 'acme-prod',
  tier: 'prod',
  composerImage: 'composer-3-airflow-2.11.1-build.22',
  airflowVersion: '2.11.1',
  parallelism: 100,
  schedulers: 1,
  maxActiveTasksPerDag: 16,
  maxActiveRunsPerDag: 25,
  workerConcurrency: 4,
  minWorkers: 1,
  maxWorkers: 2,
  pools: [
    { name: 'default_pool', slots: 128 },
    { name: 'external_api', slots: 1 },
  ],
};
const ti = (dagId: string, pool = 'external_api'): SnapshotTaskInstance => ({
  dagId,
  runId: 'r',
  taskId: 't',
  mapIndex: -1,
  tryNumber: 1,
  pool,
  poolSlots: 1,
  priorityWeight: 1,
  since: NOW - 30 * 60_000,
});
// The last hour: 120 snapshots; three DAGs wait on the starved external_api pool, one task is queued
// with worker slots full at max_count.
const snapshots: LiveSnapshot[] = Array.from({ length: 120 }, (_, i) => ({
  at: NOW - 3_600_000 + i * 30_000,
  scheduled: [ti('partner_crm_sync'), ti('partner_crm_sync'), ti('partner_tax_sync')],
  queued: [ti('orders_daily', 'default_pool')],
  pools: [
    { name: 'default_pool', slots: 128, running: 7, queued: 1, open: 120 },
    { name: 'external_api', slots: 1, running: 1, queued: 0, open: 0 },
  ],
  dagActive: {},
  executor: { running: 8, queued: 1 },
  workers: { current: 2, target: 2 },
}));
const samples: WorkerSample[] = Array.from({ length: 60 }, (_, i) => ({
  at: NOW - 3_600_000 + i * 60_000,
  workers: 2,
  target: 2,
  running: 8,
  queued: 12,
  cpu: 0.2,
  memory: 0.4,
}));
const sensor: StoredTaskTry = {
  envId: 'acme-prod',
  dagId: 'partner_feed_wait',
  runId: 'r',
  taskId: 'wait_for_1_1',
  mapIndex: -1,
  tryNumber: 1,
  pool: 'default_pool',
  poolSlots: 1,
  state: 'success',
  readyAt: NOW - 1_900_000,
  queuedAt: NOW - 1_850_000,
  startAt: NOW - 1_800_000,
  endAt: NOW - 600_000,
  sourceUpdatedAt: NOW - 600_000,
  operator: 'ExternalTaskSensor',
};
const store: TaskInstanceStore = {
  upsertTaskTries: async () => {},
  taskTries: async () => [sensor],
  countTaskTries: async () => 1,
};
const model: EnvironmentModelSource = {
  config: async (id) => (id === 'acme-prod' ? config : null),
  dags: async () => [],
  snapshots: async (_id, from, to) => snapshots.filter((s) => s.at >= from && s.at < to),
  workerSamples: async (_id, from, to) => samples.filter((s) => s.at >= from && s.at < to),
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
};
const deps = { store, model, clock: { now: () => NOW } };

describe('getBottlenecks use case (FR-BOTL-01/02/07/09)', () => {
  it('FR-BOTL-01: answers which limit caused most waiting, with its share', async () => {
    const b = await getBottlenecks(deps, { envId: 'acme-prod', range: '1h', sources: ['DEMO'] });
    expect(b.answer.reason).toBe('pool-exhausted');
    expect(b.answer.share).toBeCloseTo(0.75);
    expect(b.waiting_task_seconds).toBe(120 * 4 * 30);
    expect(b.bucket_seconds).toBe(60);
    expect(b.series).toHaveLength(60);
  });

  it('FR-BOTL-01: lists every HM-006 reason with its phase, evaluation status and top contributors', async () => {
    const b = await getBottlenecks(deps, { envId: 'acme-prod', range: '1h', sources: ['DEMO'] });
    expect(b.reasons.map((r) => r.id)).toContain('triggerer-capacity');
    expect(b.reasons.find((r) => r.id === 'triggerer-capacity')?.evaluated).toBe(false);
    const pool = b.reasons.find((r) => r.id === 'pool-exhausted');
    expect(pool?.phase).toBe('pre-queue');
    expect(pool?.top_contributors[0]).toMatchObject({ dag_id: 'partner_crm_sync', share: 2 / 3 });
    expect(b.reasons.find((r) => r.id === 'executor-slots-exhausted')?.waiting_task_seconds).toBe(120 * 30);
  });

  it('REC-CONC-02 / HM-011: reports pool starvation, minutes at max workers and capacity-bound minutes', async () => {
    const b = await getBottlenecks(deps, { envId: 'acme-prod', range: '1h', sources: ['DEMO'] });
    expect(b.pools.find((p) => p.name === 'external_api')).toMatchObject({ starved_minutes: 60, slots: 1 });
    expect(b.capacity).toMatchObject({ minutes_at_max_workers: 60, capacity_bound_minutes: 60 });
    expect(b.current).toMatchObject({ binding: 'pool-exhausted', scheduled: 3, queued: 1, worker_slots: 8 });
  });

  it('HM-032: current worker slots and capacity-bound minutes are null when worker_concurrency is not known', async () => {
    const unknown: EnvironmentConfig = {
      ...config,
      workerConcurrency: UNKNOWN_LIMIT,
      limitSources: { workerConcurrency: 'unknown' },
    };
    const b = await getBottlenecks(
      { ...deps, model: { ...model, config: async () => unknown } },
      { envId: 'acme-prod', range: '1h', sources: ['DEMO'] },
    );
    expect(b.current.worker_slots).toBeNull();
    // 12 queued at max workers is bound at 4 slots per worker, but the slots are unknown: not "0 min".
    expect(b.capacity.capacity_bound_minutes).toBeNull();
    expect(b.capacity.minutes_at_max_workers).toBe(60);
  });

  it('FR-BOTL-07 / HM-008: ranks poke-mode sensor slot time', async () => {
    const b = await getBottlenecks(deps, { envId: 'acme-prod', range: '1h', sources: ['DEMO'] });
    expect(b.sensors).toEqual([
      { dag_id: 'partner_feed_wait', task_id: 'wait_for_1_1', slot_seconds: 1_200 },
    ]);
  });

  it('HM-011: without worker samples (no Cloud Monitoring data) the capacity minutes are null, not 0', async () => {
    const noMon = { ...deps, model: { ...model, workerSamples: async () => [] } };
    const b = await getBottlenecks(noMon, { envId: 'acme-prod', range: '1h', sources: ['DEMO'] });
    expect(b.capacity).toMatchObject({
      minutes_at_max_workers: null,
      capacity_bound_minutes: null,
      worker_samples: 0,
    });
    const withMon = await getBottlenecks(deps, { envId: 'acme-prod', range: '1h', sources: ['DEMO'] });
    expect(withMon.capacity.worker_samples).toBe(60);
  });

  it('returns an empty analysis, not an error, when nothing was collected', async () => {
    const empty = { ...deps, model: { ...model, snapshots: async () => [], workerSamples: async () => [] } };
    const b = await getBottlenecks(empty, { envId: 'acme-prod', range: '1h', sources: ['DEMO'] });
    expect(b.answer.reason).toBeNull();
    expect(b.current.at).toBeNull();
    expect(b.series.every((s) => s.workers === null)).toBe(true);
  });

  it('FR-BOTL-01: weighs each snapshot by the real af.live cadence (10 s on the live profile) and reports it', async () => {
    // 30 minutes of snapshots 10 s apart, then a 30-minute collection gap.
    const live = Array.from({ length: 180 }, (_, i) => ({
      ...(snapshots[0] as LiveSnapshot),
      at: NOW - 3_600_000 + i * 10_000,
    }));
    const b = await getBottlenecks(
      {
        ...deps,
        model: {
          ...model,
          snapshots: async (_id, from, to) => live.filter((s) => s.at >= from && s.at < to),
        },
      },
      { envId: 'acme-prod', range: '1h', sources: ['DEMO'] },
    );
    expect(b.snapshot_interval_seconds).toBe(10);
    // Four waiting task instances for 30 minutes; the gap is unknown, not waiting.
    expect(b.waiting_task_seconds).toBe(180 * 4 * 10);
  });

  it('FR-BOTL-01: the snapshot cadence is unknown, not 30 s, before two snapshots exist', async () => {
    const empty = { ...deps, model: { ...model, snapshots: async () => [] } };
    const b = await getBottlenecks(empty, { envId: 'acme-prod', range: '1h', sources: ['DEMO'] });
    expect(b.snapshot_interval_seconds).toBeNull();
  });

  it('§13.2 / FR-BOTL-01: the headline gives advice only past the advisor data gate (80 % snapshot coverage)', async () => {
    const hour = await getBottlenecks(deps, { envId: 'acme-prod', range: '1h', sources: ['DEMO'] });
    expect(hour.answer.advice_withheld).toBeNull();
    // One hour of snapshots in a 24 h range: the advisor would not evaluate REC-CONC-02, so no advice.
    const day = await getBottlenecks(deps, { envId: 'acme-prod', range: '24h', sources: ['DEMO'] });
    expect(day.answer.reason).toBe('pool-exhausted');
    expect(day.answer.advice_withheld).toMatch(
      /Only 4% of the window has live snapshots; the rule needs 80%/,
    );
  });

  it('FR-STORE-02 / FR-STORE-07: says which part of the range retention deleted or thinned', async () => {
    const horizon = { deletedBefore: NOW - 20 * 3_600_000, thinnedBefore: NOW - 30 * 3_600_000 };
    const kept = { ...deps, model: { ...model, snapshotHorizon: async () => horizon } };
    const day = await getBottlenecks(kept, { envId: 'acme-prod', range: '24h', sources: ['DEMO'] });
    expect(day.snapshot_retention).toEqual({
      deleted_before: new Date(NOW - 20 * 3_600_000).toISOString(),
      // Thinned before a time outside the range, and older than what is deleted: nothing in range is thinned.
      thinned_before: null,
    });
    // An hour that retention has not reached is complete.
    const hour = await getBottlenecks(kept, { envId: 'acme-prod', range: '1h', sources: ['DEMO'] });
    expect(hour.snapshot_retention).toEqual({ deleted_before: null, thinned_before: null });
    const thinned = {
      ...deps,
      model: {
        ...model,
        snapshotHorizon: async () => ({ deletedBefore: null, thinnedBefore: NOW - 1_800_000 }),
      },
    };
    const b = await getBottlenecks(thinned, { envId: 'acme-prod', range: '1h', sources: ['DEMO'] });
    expect(b.snapshot_retention?.thinned_before).toBe(new Date(NOW - 1_800_000).toISOString());
    // Demo mode deletes nothing and has no horizon.
    expect(
      (await getBottlenecks(deps, { envId: 'acme-prod', range: '1h', sources: ['DEMO'] })).snapshot_retention,
    ).toBeUndefined();
  });
});
