import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DISK_BUDGET_GB,
  DEFAULT_RETENTION_DAYS,
  DISK_WARN_SHARE,
  RETENTION_DAY_LIMITS,
  attributeWaiting,
  diskUsageState,
  snapshotSpans,
  thinSnapshots,
  type EnvironmentConfig,
  type LiveSnapshot,
} from '../src/index';

const T0 = Date.UTC(2026, 10, 5, 11, 0, 0);
const S = 1_000;
const MIN = 60 * S;
const BUCKET = 5 * MIN;
const raw = (...seconds: number[]) => seconds.map((s) => ({ at: T0 + s * S }));
const range = (from: number, to: number, step: number) =>
  Array.from({ length: Math.ceil((to - from) / step) }, (_, i) => from + i * step);

describe('FR-STORE-02 retention classes (spec §9.4, §17.2)', () => {
  it('FR-STORE-02: the defaults are those of §17.2', () => {
    expect(DEFAULT_RETENTION_DAYS).toEqual({
      rawTaskInstancesDays: 90,
      rawMetricPointsDays: 14,
      rollup5mDays: 90,
      rollup1hDays: 400,
      logSignaturesDays: 30,
      findingsDays: 400,
    });
    expect(DEFAULT_DISK_BUDGET_GB).toBe(5);
  });

  it('FR-STORE-02: every default lies within its limits', () => {
    for (const [key, days] of Object.entries(DEFAULT_RETENTION_DAYS)) {
      const limits = RETENTION_DAY_LIMITS[key as keyof typeof DEFAULT_RETENTION_DAYS];
      expect(days, key).toBeGreaterThanOrEqual(limits.min);
      expect(days, key).toBeLessThanOrEqual(limits.max);
    }
    // The alerts' same-hour baseline reads the previous 7 days of task tries.
    expect(RETENTION_DAY_LIMITS.rawTaskInstancesDays.min).toBe(7);
  });
});

describe('FR-STORE-07 disk budget', () => {
  it('FR-STORE-07: usage at or above 90 % of the budget is a warning', () => {
    expect(DISK_WARN_SHARE).toBe(0.9);
    expect(diskUsageState(899, 1_000)).toBe('ok');
    expect(diskUsageState(900, 1_000)).toBe('warning');
    expect(diskUsageState(1_200, 1_000)).toBe('warning');
  });
});

describe('FR-STORE-07 thinning live snapshots to one per 5 minutes', () => {
  it('FR-STORE-07: keeps the first snapshot of each bucket, standing for the time the bucket stood for', () => {
    const snapshots = raw(...range(0, 600, 30));
    const plan = thinSnapshots(snapshots, {
      before: T0 + 600 * S,
      bucketMs: BUCKET,
      nextAt: T0 + 600 * S,
      fallbackCadenceMs: 30 * S,
    });
    expect(plan.spans).toEqual([
      { at: T0, spanMs: 5 * MIN },
      { at: T0 + 300 * S, spanMs: 5 * MIN },
    ]);
    expect(plan.dropped).toHaveLength(18);
    expect(plan.dropped).not.toContain(T0);
    expect(plan.dropped).not.toContain(T0 + 300 * S);
  });

  it('FR-STORE-07: a collection gap stays unknown: spans are capped at two cadences, as when read raw', () => {
    // 60 → 250 s is a 190 s gap at a 30 s cadence: it stands for 60 s.
    const snapshots = raw(0, 30, 60, 250, 280);
    const plan = thinSnapshots(snapshots, {
      before: T0 + 300 * S,
      bucketMs: BUCKET,
      nextAt: T0 + 300 * S,
      fallbackCadenceMs: 30 * S,
    });
    const rawSpans = snapshotSpans(snapshots, 30 * S, T0 + 300 * S);
    expect(rawSpans).toEqual([30 * S, 30 * S, 60 * S, 30 * S, 20 * S]);
    expect(plan.spans).toEqual([{ at: T0, spanMs: 170 * S }]);
  });

  it('FR-STORE-07: snapshots from the last bucket before `before` on are left as they are', () => {
    const snapshots = raw(...range(0, 900, 30));
    // `before` falls inside the third bucket: only whole buckets are thinned.
    const plan = thinSnapshots(snapshots, {
      before: T0 + 700 * S,
      bucketMs: BUCKET,
      nextAt: null,
      fallbackCadenceMs: 30 * S,
    });
    expect(plan.spans.map((s) => s.at)).toEqual([T0, T0 + 300 * S]);
    expect(Math.max(...plan.dropped)).toBeLessThan(T0 + 600 * S);
  });

  it('FR-STORE-06: thinning again changes nothing (idempotent), and a lone snapshot keeps its span', () => {
    const snapshots = raw(...range(0, 600, 30));
    const options = {
      before: T0 + 600 * S,
      bucketMs: BUCKET,
      nextAt: T0 + 600 * S,
      fallbackCadenceMs: 30 * S,
    };
    const first = thinSnapshots(snapshots, options);
    const thinned = first.spans;
    expect(thinSnapshots(thinned, options)).toEqual({ spans: [], dropped: [] });
    // A raw snapshot alone in its bucket gets its span fixed too (here capped at two 30 s cadences), so
    // later reads need no cadence for it.
    const lone = thinSnapshots(raw(0, 30, 60, 400), { ...options, nextAt: T0 + 610 * S });
    expect(lone).toEqual({
      spans: [
        { at: T0, spanMs: 120 * S },
        { at: T0 + 400 * S, spanMs: 60 * S },
      ],
      dropped: [T0 + 30 * S, T0 + 60 * S],
    });
  });

  it('FR-STORE-07: a bucket that holds a thinned snapshot and raw ones merges them without double counting', () => {
    const options = {
      before: T0 + 300 * S,
      bucketMs: BUCKET,
      nextAt: T0 + 300 * S,
      fallbackCadenceMs: 30 * S,
    };
    const merged = thinSnapshots([{ at: T0, spanMs: 150 * S }, ...raw(150, 180, 210, 240, 270)], options);
    expect(merged.spans).toEqual([{ at: T0, spanMs: 300 * S }]);
    expect(merged.dropped).toHaveLength(5);
  });
});

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
const snap = (seconds: number, spanMs?: number): LiveSnapshot => ({
  at: T0 + seconds * S,
  ...(spanMs === undefined ? {} : { spanMs }),
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

describe('FR-STORE-07 thinned snapshots in waiting attribution (FR-BOTL-01, HM-006)', () => {
  it('FR-STORE-07: a thinned snapshot stands for its stored span, clipped to the window end', () => {
    expect(snapshotSpans([{ at: T0, spanMs: 5 * MIN }], 10 * S, T0 + 2 * MIN)).toEqual([2 * MIN]);
    expect(snapshotSpans([{ at: T0, spanMs: 5 * MIN }, ...raw(300)], 10 * S, T0 + 10 * MIN)).toEqual([
      5 * MIN,
      10 * S,
    ]);
  });

  it('FR-STORE-07: an hour thinned to one per 5 minutes before an hour at 10 s keeps coverage and waiting exact', () => {
    const thinned = range(0, 3_600, 300).map((s) => snap(s, 5 * MIN));
    const live = range(3_600, 7_200, 10).map((s) => snap(s));
    const a = attributeWaiting([...thinned, ...live], ctx, {
      from: T0,
      to: T0 + 7_200 * S,
      bucketMs: 15 * MIN,
      fallbackCadenceMs: 30 * S,
    });
    // The cadence is that of the raw snapshots: the 5-minute spacing is not a 300 s cadence.
    expect(a.cadenceMs).toBe(10 * S);
    expect(a.coveredMs).toBe(2 * 3_600 * S);
    expect(a.totals.get('pool-exhausted')).toBe(2 * 2 * 3_600 * S);
  });
});
