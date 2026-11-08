import { describe, expect, it } from 'vitest';
import {
  SNAPSHOT_GAP_CADENCES,
  attributeWaiting,
  observedCadenceMs,
  snapshotSpans,
  type EnvironmentConfig,
  type LiveSnapshot,
} from '../src/index';

const T0 = Date.UTC(2026, 10, 5, 11, 0, 0);
const S = 1_000;
const MIN = 60 * S;
const at = (...seconds: number[]) => seconds.map((s) => ({ at: T0 + s * S }));

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
  pools: [{ name: 'tiny', slots: 1 }],
};
/** Two task instances wait on a full one-slot pool. */
const snap = (seconds: number): LiveSnapshot => ({
  at: T0 + seconds * S,
  scheduled: ['a', 'b'].map((dagId) => ({
    dagId,
    runId: 'r',
    taskId: 't',
    mapIndex: -1,
    tryNumber: 1,
    pool: 'tiny',
    poolSlots: 1,
    priorityWeight: 1,
    since: T0 - MIN,
  })),
  queued: [],
  pools: [{ name: 'tiny', slots: 1, running: 1, queued: 0, open: 0 }],
  dagActive: {},
  executor: { running: 1, queued: 0 },
  workers: { current: 1, target: 1 },
});
const ctx = { config, dagMaxActiveTasks: new Map<string, number>() };

describe('FR-BOTL-01 time each live snapshot stands for (af.live cadence)', () => {
  it('FR-BOTL-01: the cadence is the median gap between snapshots; unknown with fewer than two', () => {
    expect(observedCadenceMs(at(0, 10, 20.5, 30))).toBe(10 * S);
    // One long collection gap does not change the cadence.
    expect(observedCadenceMs(at(0, 10, 20, 30, 630))).toBe(10 * S);
    expect(observedCadenceMs(at(0))).toBeNull();
    expect(observedCadenceMs([])).toBeNull();
  });

  it('FR-BOTL-01: a snapshot stands for the gap to the next, capped at 2 × the cadence; the last one up to the window end', () => {
    expect(SNAPSHOT_GAP_CADENCES).toBe(2);
    // The 600 s gap after 30 s is a collection gap: 20 s stand for it, the rest is unknown.
    expect(snapshotSpans(at(0, 10, 20, 30, 630), 10 * S, T0 + 635 * S)).toEqual([
      10 * S,
      10 * S,
      10 * S,
      20 * S,
      5 * S,
    ]);
    expect(snapshotSpans(at(0), 30 * S, T0 + 60 * S)).toEqual([30 * S]);
  });

  it('FR-BOTL-01: waiting is weighed by the real cadence (10 s on the live profile), not a fixed 30 s', () => {
    const live = Array.from({ length: 12 }, (_, i) => snap(i * 10));
    const a = attributeWaiting(live, ctx, {
      from: T0,
      to: T0 + 2 * MIN,
      bucketMs: MIN,
      fallbackCadenceMs: 30 * S,
    });
    expect(a.cadenceMs).toBe(10 * S);
    expect(a.totals.get('pool-exhausted')).toBe(2 * 12 * 10 * S);
    expect(a.pools.get('tiny')?.starvedMs).toBe(2 * MIN);
    expect(a.coveredMs).toBe(2 * MIN);
  });

  it('FR-BOTL-01: a collection gap counts as unknown, not as waiting', () => {
    const gappy = [snap(0), snap(10), snap(20), snap(90)];
    const a = attributeWaiting(gappy, ctx, {
      from: T0,
      to: T0 + 100 * S,
      bucketMs: MIN,
      fallbackCadenceMs: 30 * S,
    });
    // Spans 10, 10, 20 (capped from 70) and 10 s: 50 s observed, 50 s unknown.
    expect(a.coveredMs).toBe(50 * S);
    expect(a.totals.get('pool-exhausted')).toBe(2 * 50 * S);
  });
});
