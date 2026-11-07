import { describe, expect, it } from 'vitest';
import type { LiveSnapshot, SnapshotTaskInstance } from '../src/index';
import { dagRuns, logicalDateFromRunId, runGantt, selfThrottledRatio, taskStats } from '../src/index';
import { M, T0, tryAt, windowOf } from './fixtures';

const W = windowOf(60, 120);
const RUN_1 = 'scheduled__2026-11-05T01:00:00+00:00';
const RUN_2 = 'scheduled__2026-11-05T01:30:00+00:00';

describe('FR-DAGD-02 runs timeline', () => {
  it('FR-DAGD-02: reads the logical date from generated run IDs', () => {
    expect(logicalDateFromRunId(RUN_1)).toBe(Date.UTC(2026, 10, 5, 1, 0, 0));
    expect(logicalDateFromRunId('manual__2026-11-05T01:02:03.456789+00:00')).toBe(
      Date.UTC(2026, 10, 5, 1, 2, 3, 456),
    );
    expect(logicalDateFromRunId('backfill__2026-11-05T01:00:00+0100')).toBe(Date.UTC(2026, 10, 5, 0, 0, 0));
    expect(logicalDateFromRunId('nightly-rebuild')).toBeNull();
  });

  it('FR-DAGD-02: lists runs with state, logical date, start, end, duration and start delay, oldest first', () => {
    const tries = [
      tryAt({ runId: RUN_2, taskId: 'a', start: 92, end: 95, state: 'failed' }),
      tryAt({ runId: RUN_1, taskId: 'a', start: 61.5, end: 70 }),
      tryAt({ runId: RUN_1, taskId: 'b', start: 70, end: 80 }),
      tryAt({ runId: 'custom', taskId: 'a', start: 110, end: null }),
    ];
    const runs = dagRuns(tries, W);
    expect(runs.map((r) => r.runId)).toEqual([RUN_1, RUN_2, 'custom']);
    expect(runs[0]).toMatchObject({
      state: 'success',
      logicalDate: Date.UTC(2026, 10, 5, 1, 0, 0),
      startAt: T0 + 61.5 * M,
      endAt: T0 + 80 * M,
      durationSeconds: 18.5 * 60,
      startDelaySeconds: 90,
      tries: 2,
    });
    expect(runs[1]).toMatchObject({ state: 'failed', startDelaySeconds: 120 });
    expect(runs[2]).toMatchObject({
      state: 'running',
      endAt: null,
      durationSeconds: null,
      logicalDate: null,
      startDelaySeconds: null,
    });
  });
});

describe('FR-DAGD-03 run Gantt', () => {
  it('FR-DAGD-03: one row per try with ready, queued, start and end, plus work still waiting', () => {
    const tries = [
      tryAt({ runId: RUN_1, taskId: 'b', ready: 70, queued: 71, start: 72, end: 80 }),
      tryAt({ runId: RUN_1, taskId: 'a', ready: 60, queued: 60.5, start: 61, end: 62, state: 'failed' }),
      tryAt({ runId: RUN_1, taskId: 'a', tryNumber: 2, ready: 63, queued: 64, start: 65, end: 69 }),
      tryAt({ runId: RUN_2, taskId: 'a', start: 92 }),
    ];
    const ti = (taskId: string, since: number): SnapshotTaskInstance => ({
      dagId: 'dag_a',
      runId: RUN_1,
      taskId,
      mapIndex: -1,
      tryNumber: 1,
      pool: 'default_pool',
      poolSlots: 1,
      priorityWeight: 1,
      since: T0 + since * M,
    });
    const rows = runGantt(tries, 'dag_a', RUN_1, { scheduled: [ti('c', 81)], queued: [ti('d', 82)] });
    expect(rows.map((r) => `${r.taskId}#${r.tryNumber}:${r.state}`)).toEqual([
      'a#1:failed',
      'a#2:success',
      'b#1:success',
      'c#1:scheduled',
      'd#1:queued',
    ]);
    expect(rows[2]).toMatchObject({
      readyAt: T0 + 70 * M,
      queuedAt: T0 + 71 * M,
      startAt: T0 + 72 * M,
      endAt: T0 + 80 * M,
    });
    expect(rows[3]).toMatchObject({ readyAt: T0 + 81 * M, queuedAt: null, startAt: null, endAt: null });
    expect(rows[4]).toMatchObject({ readyAt: null, queuedAt: T0 + 82 * M, startAt: null });
  });
});

describe('FR-DAGD-04 task statistics', () => {
  it('FR-DAGD-04: per task duration, queue wait, retries, failure rate, slot-seconds share and contribution, sorted by contribution', () => {
    const tries = [
      // Two runs; "load" runs 10 min per run, "extract" 2 min, plus a failed 1-minute try.
      tryAt({ runId: RUN_1, taskId: 'extract', queued: 60, start: 61, end: 62, state: 'failed' }),
      tryAt({ runId: RUN_1, taskId: 'extract', tryNumber: 2, queued: 62, start: 62.5, end: 64.5 }),
      tryAt({ runId: RUN_1, taskId: 'load', start: 65, end: 75 }),
      tryAt({ runId: RUN_2, taskId: 'extract', start: 90, end: 92 }),
      tryAt({ runId: RUN_2, taskId: 'load', start: 92, end: 102 }),
    ];
    const stats = taskStats(tries, W);
    expect(stats.map((s) => s.taskId)).toEqual(['load', 'extract']);
    const [load, extract] = stats;
    expect(load).toMatchObject({ tries: 2, retries: 0, failureRate: null, contributionSeconds: 600 });
    expect(load?.durationP50).toEqual({ value: 600, samples: 2, lowSample: false });
    expect(load?.slotSecondsShare).toBeCloseTo(20 / 25, 9);
    expect(extract).toMatchObject({ tries: 3, retries: 1, contributionSeconds: (1 + 2 + 2) * 30 });
    expect(extract?.queueWaitP95).toEqual({ value: 60, samples: 3, lowSample: true });
    expect(extract?.slotSecondsShare).toBeCloseTo(5 / 25, 9);
  });

  it('FR-DAGD-04 / HM-015: failure rate = failed tries ÷ tries, from 20 tries', () => {
    const tries = Array.from({ length: 20 }, (_, i) =>
      tryAt({ runId: `r${i}`, start: 60 + i, state: i < 5 ? 'failed' : 'success' }),
    );
    expect(taskStats(tries, W)[0]?.failureRate).toBe(0.25);
  });
});

describe('HM-005 DAG self-throttling', () => {
  const snapshot = (at: number, active: number, ready: boolean): LiveSnapshot => ({
    at: T0 + at * M,
    scheduled: ready
      ? [
          {
            dagId: 'dag_a',
            runId: RUN_1,
            taskId: 'x',
            mapIndex: -1,
            tryNumber: 1,
            pool: 'default_pool',
            poolSlots: 1,
            priorityWeight: 1,
            since: T0,
          },
        ]
      : [],
    queued: [],
    pools: [],
    dagActive: active > 0 ? { dag_a: active } : {},
    executor: { running: active, queued: 0 },
    workers: { current: 1, target: 1 },
  });

  it('HM-005: minutes at max_active_tasks with ready work ÷ minutes the DAG was active', () => {
    const snapshots = [
      snapshot(60, 4, true), // throttled
      snapshot(60.5, 4, true), // same minute
      snapshot(61, 4, false), // at the limit, nothing waiting: active only
      snapshot(62, 2, true), // below the limit: active only
      snapshot(63, 0, false), // inactive
    ];
    expect(selfThrottledRatio(snapshots, 'dag_a', 4)).toBeCloseTo(1 / 3, 12);
  });

  it('HM-005: null without live snapshots or without active minutes', () => {
    expect(selfThrottledRatio([], 'dag_a', 4)).toBeNull();
    expect(selfThrottledRatio([snapshot(60, 0, false)], 'dag_a', 4)).toBeNull();
  });
});
