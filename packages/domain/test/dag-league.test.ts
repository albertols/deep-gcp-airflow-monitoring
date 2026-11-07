import { describe, expect, it } from 'vitest';
import { dagLeague, dagWindowStats, gini } from '../src/index';
import { tryAt, windowOf } from './fixtures';

const W = windowOf(60, 120); // the second hour after T0

describe('FR-DAGX-02 per-DAG runs and reliability', () => {
  it('FR-DAGX-02: counts runs with a try starting in the window, failed runs, success rate, tries and retries', () => {
    const tries = [
      // r0 ran entirely before the window: not counted.
      tryAt({ runId: 'r0', start: 10, end: 20 }),
      // r1: task_1 failed once, then succeeded; task_2 succeeded. The run succeeded.
      tryAt({ runId: 'r1', taskId: 'task_1', start: 61, end: 62, state: 'failed' }),
      tryAt({ runId: 'r1', taskId: 'task_1', tryNumber: 2, start: 64, end: 70 }),
      tryAt({ runId: 'r1', taskId: 'task_2', start: 71, end: 80 }),
      // r2: task_1's latest try failed, so the run failed.
      tryAt({ runId: 'r2', taskId: 'task_1', start: 90, end: 95, state: 'failed' }),
    ];
    const s = dagWindowStats(tries, W).get('dag_a');
    expect(s).toMatchObject({
      runs: 2,
      finishedRuns: 2,
      failedRuns: 1,
      successRate: 0.5,
      tries: 4,
      retries: 1,
    });
  });

  it('FR-DAGX-02: success rate is null without finished runs, and a run with waiting work is running', () => {
    const tries = [
      tryAt({ runId: 'r1', start: 100, end: null }),
      tryAt({ dagId: 'dag_b', runId: 'r2', start: 100, end: 101 }),
    ];
    const stats = dagWindowStats(tries, W, { inProgress: (dagId) => dagId === 'dag_b' });
    expect(stats.get('dag_a')).toMatchObject({ runs: 1, finishedRuns: 0, successRate: null });
    expect(stats.get('dag_b')).toMatchObject({ runs: 1, finishedRuns: 0, successRate: null });
  });

  it('FR-DAGX-02: run duration p50/p95 is last end − first start over finished runs, with the §8.9 rule', () => {
    const tries = [
      tryAt({ runId: 'r1', taskId: 'a', start: 60, end: 70 }),
      tryAt({ runId: 'r1', taskId: 'b', start: 70, end: 90 }), // 30 min
      tryAt({ runId: 'r2', taskId: 'a', start: 95, end: 105 }), // 10 min
      tryAt({ runId: 'r3', taskId: 'a', start: 110, end: null }), // running: excluded
    ];
    const s = dagWindowStats(tries, W).get('dag_a');
    expect(s?.runDurationP50).toEqual({ value: 20 * 60, samples: 2, lowSample: false });
    expect(s?.runDurationP95).toEqual({ value: 30 * 60, samples: 2, lowSample: true });
  });

  it('HM-015: flaky rate = task instances that succeeded after a failed try ÷ task instances, from 20 task instances', () => {
    const few = Array.from({ length: 19 }, (_, i) => tryAt({ runId: `r${i}`, start: 61 + i }));
    expect(dagWindowStats(few, W).get('dag_a')?.flakyRate).toBeNull();

    const tries = Array.from({ length: 20 }, (_, i) => tryAt({ runId: `r${i}`, start: 61 + i }));
    for (const runId of ['r0', 'r1']) {
      tries.push(tryAt({ runId, start: 61, end: 61.5, state: 'failed' }));
      tries[Number(runId.slice(1))] = tryAt({ runId, tryNumber: 2, start: 100 });
    }
    // A task instance whose retry also failed is not flaky.
    tries.push(tryAt({ runId: 'r2', taskId: 'task_9', start: 62, state: 'failed' }));
    tries.push(tryAt({ runId: 'r2', taskId: 'task_9', tryNumber: 2, start: 65, state: 'failed' }));
    const s = dagWindowStats(tries, W).get('dag_a');
    expect(s?.taskInstances).toBe(21);
    expect(s?.flakyRate).toBeCloseTo(2 / 21, 9);
  });

  it('HM-001: queue wait p95 is start − queued over tries starting in the window, in seconds', () => {
    const tries = Array.from({ length: 20 }, (_, i) =>
      tryAt({ runId: `r${i}`, queued: 60 + i, start: 60 + i + (i + 1) / 60 }),
    );
    tries.push(tryAt({ runId: 'no-queue', queued: null, start: 80 }));
    const q = dagWindowStats(tries, W).get('dag_a')?.queueWaitP95;
    expect(q?.samples).toBe(20);
    expect(q?.lowSample).toBe(false);
    expect(q?.value).toBeCloseTo(19.05, 6); // type-7 p95 of 1..20 s
  });

  it('HM-003 / HM-011: executor slot-seconds clipped to the window and peak concurrency per DAG', () => {
    const tries = [
      tryAt({ runId: 'r1', taskId: 'a', start: 30, end: 90 }), // 30 min inside
      tryAt({ runId: 'r1', taskId: 'b', start: 70, end: 80, poolSlots: 3 }),
      tryAt({ runId: 'r1', taskId: 'c', start: 75, end: 100 }),
      tryAt({ dagId: 'dag_b', runId: 'r9', start: 110, end: null }), // runs until now
    ];
    const stats = dagWindowStats(tries, W);
    expect(stats.get('dag_a')?.executorSlotSeconds).toBe((30 + 10 + 25) * 60);
    expect(stats.get('dag_a')?.peakConcurrency).toBe(3);
    expect(stats.get('dag_b')?.executorSlotSeconds).toBe(10 * 60);
    expect(stats.get('dag_b')?.peakConcurrency).toBe(1);
  });
});

describe('FR-DAGX-02 / FR-DAGX-03 league ranking', () => {
  const previous = windowOf(0, 60, 120);
  const tries = [
    tryAt({ dagId: 'heavy', runId: 'r1', start: 60, end: 120 }), // 60 min
    tryAt({ dagId: 'light', runId: 'r1', start: 60, end: 90 }), // 30 min
    tryAt({ dagId: 'tiny', runId: 'r1', start: 60, end: 70 }), // 10 min
    tryAt({ dagId: 'heavy', runId: 'r0', start: 0, end: 30 }), // previous: 30 min
    tryAt({ dagId: 'light', runId: 'r0', start: 0, end: 10 }), // previous: 10 min
  ];

  it('FR-DAGX-02: ranks by slot-seconds with share, cumulative share and previous share; lists inactive DAGs', () => {
    const league = dagLeague({
      tries,
      window: W,
      previousWindow: previous,
      dagIds: ['idle', 'tiny', 'heavy'],
    });
    expect(league.rows.map((r) => r.dagId)).toEqual(['heavy', 'light', 'tiny', 'idle']);
    expect(league.totalExecutorSlotSeconds).toBe(100 * 60);
    expect(league.activeDagCount).toBe(3);
    const [heavy, light, tiny, idle] = league.rows;
    expect(heavy).toMatchObject({ share: 0.6, cumulativeShare: 0.6, previousShare: 0.75 });
    expect(light).toMatchObject({ share: 0.3, previousShare: 0.25 });
    expect(light?.cumulativeShare).toBeCloseTo(0.9, 9);
    expect(tiny).toMatchObject({ share: 0.1, cumulativeShare: 1, previousShare: null });
    expect(idle).toMatchObject({
      runs: 0,
      executorSlotSeconds: 0,
      share: 0,
      peakConcurrency: 0,
      previousShare: null,
    });
    expect(idle?.queueWaitP95).toEqual({ value: null, samples: 0, lowSample: true });
  });

  it('FR-DAGX-03: Gini coefficient over active DAGs', () => {
    const league = dagLeague({ tries, window: W, previousWindow: previous, dagIds: ['idle'] });
    expect(league.gini).toBeCloseTo(gini([60, 30, 10]), 12);
    expect(gini([60, 30, 10])).toBeCloseTo(1 / 3, 12);
    expect(gini([5, 5, 5, 5])).toBe(0);
    expect(gini([0, 0, 0, 8])).toBeCloseTo(0.75, 12);
    expect(gini([7])).toBe(0);
    expect(gini([])).toBe(0);
  });

  it('FR-DAGX-02: shares stay within [0, 1] despite floating-point sums', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      tryAt({ dagId: `d${i}`, runId: 'r', start: 60 + i / 7, end: 60 + i / 3 + 0.1 }),
    );
    const league = dagLeague({ tries: many, window: W, previousWindow: previous, dagIds: [] });
    for (const r of league.rows) {
      expect(r.share).toBeLessThanOrEqual(1);
      expect(r.cumulativeShare).toBeLessThanOrEqual(1);
    }
    expect(league.rows.at(-1)?.cumulativeShare).toBe(1);
  });
});
