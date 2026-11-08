import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  attributeWaiting,
  type EnvironmentConfig,
  type LiveSnapshot,
  type SnapshotTaskInstance,
} from '../src/index';

const T0 = Date.UTC(2026, 10, 5, 11, 0, 0);
const MIN = 60_000;
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
    { name: 'external_api', slots: 1 },
    { name: 'etl', slots: 2 },
    { name: 'default_pool', slots: 128 },
  ],
};
const ctx = { config, dagMaxActiveTasks: new Map<string, number>() };
const ti = (dagId: string, pool: string): SnapshotTaskInstance => ({
  dagId,
  runId: 'r',
  taskId: 't',
  mapIndex: -1,
  tryNumber: 1,
  pool,
  poolSlots: 1,
  priorityWeight: 1,
  since: T0 - 10 * MIN,
});
const snap = (at: number, scheduled: SnapshotTaskInstance[], queued: SnapshotTaskInstance[] = []) =>
  ({
    at,
    scheduled,
    queued,
    pools: [
      { name: 'external_api', slots: 1, running: 1, queued: 0, open: 0 },
      { name: 'etl', slots: 2, running: 2, queued: 0, open: 0 },
      { name: 'default_pool', slots: 128, running: 8, queued: 1, open: 119 },
    ],
    dagActive: {},
    executor: { running: 8, queued: queued.length },
    workers: { current: 2, target: 2 },
  }) satisfies LiveSnapshot;

describe('HM-006 top contributors per reason (FR-BOTL-01)', () => {
  it('FR-BOTL-01: ranks the pools that waited most for each reason, largest first', () => {
    // Per snapshot: three tries wait on the full external_api pool, one on the full etl pool, and one is
    // queued in default_pool with worker slots full at max_count.
    const snapshots = [0, 1].map((i) =>
      snap(
        T0 + i * 30_000,
        [ti('a', 'external_api'), ti('b', 'external_api'), ti('c', 'external_api'), ti('a', 'etl')],
        [ti('d', 'default_pool')],
      ),
    );
    const a = attributeWaiting(snapshots, ctx, {
      from: T0,
      to: T0 + MIN,
      bucketMs: MIN,
      fallbackCadenceMs: 30_000,
    });
    expect([...(a.byReasonPool.get('pool-exhausted') ?? [])]).toEqual([
      ['external_api', 3 * 60_000],
      ['etl', 60_000],
    ]);
    expect([...(a.byReasonPool.get('executor-slots-exhausted') ?? [])]).toEqual([['default_pool', 60_000]]);
  });

  it('FR-BOTL-01: per reason, the pools add up to the reason total, as the DAGs do', () => {
    const pools = ['external_api', 'etl', 'default_pool', 'missing_pool'];
    const arbTi = fc.record({ dag: fc.constantFrom('a', 'b', 'c'), pool: fc.constantFrom(...pools) });
    fc.assert(
      fc.property(
        fc.array(fc.record({ scheduled: fc.array(arbTi, { maxLength: 6 }), queued: fc.array(arbTi) }), {
          minLength: 1,
          maxLength: 8,
        }),
        (specs) => {
          const snapshots = specs.map((s, i) =>
            snap(
              T0 + i * 30_000,
              s.scheduled.map((x) => ti(x.dag, x.pool)),
              s.queued.map((x) => ti(x.dag, x.pool)),
            ),
          );
          const a = attributeWaiting(snapshots, ctx, {
            from: T0,
            to: T0 + 10 * MIN,
            bucketMs: MIN,
            fallbackCadenceMs: 30_000,
          });
          for (const [reason, total] of a.totals) {
            const sum = (m: ReadonlyMap<string, number> | undefined) =>
              [...(m ?? new Map<string, number>()).values()].reduce((x, y) => x + y, 0);
            expect(sum(a.byReasonPool.get(reason))).toBeCloseTo(total, 6);
            expect(sum(a.byReasonDag.get(reason))).toBeCloseTo(total, 6);
          }
        },
      ),
    );
  });
});
