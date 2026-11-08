import { describe, expect, it } from 'vitest';
import {
  concurrencyProfile,
  createConcurrencyProfile,
  dagSelfThrottling,
  type EnvironmentConfig,
  type LiveSnapshot,
  type SnapshotTaskInstance,
} from '../src/index';
import { M, T0, tryAt, windowOf } from './fixtures';

const DAG = 'acme_fanout';
const config: Pick<EnvironmentConfig, 'workerConcurrency' | 'limitSources' | 'pools'> = {
  workerConcurrency: 4,
  pools: [
    { name: 'default_pool', slots: 128 },
    { name: 'etl', slots: 24 },
  ],
};
const ready = (): SnapshotTaskInstance => ({
  dagId: DAG,
  runId: 'r1',
  taskId: 'fan',
  mapIndex: 3,
  tryNumber: 1,
  pool: 'default_pool',
  poolSlots: 1,
  priorityWeight: 1,
  since: T0,
});
/** One snapshot a minute for 15 minutes, then collection stops. */
const snapshots: LiveSnapshot[] = Array.from({ length: 15 }, (_, minute) => ({
  at: T0 + minute * M,
  // Minutes 0–4: at the limit of 2 with one own task ready; 5–9: at the limit, nothing ready; 10–14: one in flight.
  scheduled: minute < 5 ? [ready()] : [],
  queued: [],
  pools: [
    { name: 'default_pool', slots: 128, running: 3, queued: 1, open: 124 },
    { name: 'etl', slots: 24, running: 2, queued: 0, open: 22 },
  ],
  dagActive: { [DAG]: minute < 10 ? 2 : 1, other_dag: 5 },
  executor: { running: 2, queued: 0 },
  workers: { current: 2, target: 2 },
}));
const tries = [
  tryAt({ dagId: DAG, taskId: 'a', start: 0, end: 10 }),
  tryAt({ dagId: DAG, taskId: 'b', start: 0, end: 5 }),
  tryAt({ dagId: DAG, taskId: 'c', start: 5, end: 20, pool: 'etl', poolSlots: 2 }),
  tryAt({ dagId: 'other_dag', taskId: 'x', start: 0, end: 30 }),
];
const base = {
  tries,
  snapshots,
  dagId: DAG,
  limit: 2,
  config,
  window: windowOf(0, 30),
  bucketMs: 10 * M,
  fallbackCadenceMs: 30_000,
  historyFrom: T0 - 60 * M,
};

describe('FR-DAGD-05 concurrency profile', () => {
  it('FR-DAGD-05 / HM-011: running task instances per bucket from tries, in flight and ready from snapshots', () => {
    const p = concurrencyProfile(base);
    expect(p.buckets).toEqual([
      { start: T0, runningAvg: 2, runningMax: 2, inFlightMax: 2, readyMax: 1, atLimitMs: 5 * M },
      { start: T0 + 10 * M, runningAvg: 1, runningMax: 1, inFlightMax: 1, readyMax: 0, atLimitMs: 0 },
      // No snapshot in the last bucket: a gap, never zero (NFR-DATA-03).
      {
        start: T0 + 20 * M,
        runningAvg: 0,
        runningMax: 0,
        inFlightMax: null,
        readyMax: null,
        atLimitMs: null,
      },
    ]);
    expect(p).toMatchObject({ peakRunning: 2, peakInFlight: 2, snapshots: 15, cadenceMs: M });
  });

  it("FR-DAGD-05: per pool, the DAG's slots in use against the pool size and its occupied slots", () => {
    expect(concurrencyProfile(base).pools).toEqual([
      { pool: 'default_pool', slots: 128, poolSlots: 1, dagSlotsMax: [2, 0, 0], occupiedMax: [4, 4, null] },
      { pool: 'etl', slots: 24, poolSlots: 2, dagSlotsMax: [2, 2, 0], occupiedMax: [2, 2, null] },
    ]);
  });

  it('HM-005 / REC-DAG-01: the self-throttling totals are the shared computation', () => {
    const p = concurrencyProfile(base);
    expect(p.selfThrottling).toEqual(
      dagSelfThrottling({
        snapshots,
        from: base.window.from,
        to: base.window.to,
        fallbackCadenceMs: base.fallbackCadenceMs,
        dagId: DAG,
        limit: 2,
        config,
      }),
    );
    expect(p.selfThrottling).toMatchObject({ activeMs: 15 * M, atLimitMs: 5 * M, peakDemand: 3 });
  });

  it('NFR-DATA-03: buckets that end before the environment history starts have no running count', () => {
    const p = concurrencyProfile({ ...base, historyFrom: T0 + 15 * M });
    expect(p.buckets.map((b) => b.runningAvg)).toEqual([null, 1, 0]);
    expect(p.pools[0]?.dagSlotsMax).toEqual([null, 0, 0]);
    expect(concurrencyProfile({ ...base, historyFrom: null }).peakRunning).toBeNull();
  });

  it('FR-DAGD-05: without snapshots the snapshot series are gaps and the self-throttling is empty', () => {
    const p = concurrencyProfile({ ...base, snapshots: [] });
    expect(
      p.buckets.every((b) => b.inFlightMax === null && b.readyMax === null && b.atLimitMs === null),
    ).toBe(true);
    expect(p).toMatchObject({ peakInFlight: null, snapshots: 0, cadenceMs: null });
    expect(p.selfThrottling.activeMs).toBe(0);
  });

  it('FR-DAGD-05 / NFR-PERF-01: snapshots added in batches give the same profile, spans across batches included', () => {
    const acc = createConcurrencyProfile(base);
    for (const batch of [snapshots.slice(0, 4), snapshots.slice(4, 11), [], snapshots.slice(11)])
      acc.add(batch);
    expect(acc.result(tries)).toEqual(concurrencyProfile(base));
  });
});
