import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { compareRuns, type DagTaskTry } from '../src/index';
import { tryAt } from './fixtures';

const A = 'scheduled__2026-11-05T00:00:00+00:00';
const B = 'scheduled__2026-11-05T01:00:00+00:00';
const at = (runId: string, taskId: string, queued: number, start: number, end: number | null, extra = {}) =>
  tryAt({ runId, taskId, queued, start, end, ...extra });

/**
 * Run a (minutes 0–8): extract, transform mapped two ways, load; cleanup in parallel.
 * Run b (minutes 60–75): transform mapped three ways (index 2 runs 9.5 min), load retried once.
 */
const runA: DagTaskTry[] = [
  at(A, 'extract', 0, 0, 2),
  at(A, 'transform', 2.2, 2.5, 5, { mapIndex: 0 }),
  at(A, 'transform', 2.2, 2.5, 6, { mapIndex: 1 }),
  at(A, 'cleanup', 2.2, 2.5, 3),
  at(A, 'load', 6.2, 6.5, 8),
];
const runB: DagTaskTry[] = [
  at(B, 'extract', 60, 60, 62),
  at(B, 'transform', 62.2, 62.5, 65, { mapIndex: 0 }),
  at(B, 'transform', 62.2, 62.5, 66, { mapIndex: 1 }),
  at(B, 'transform', 62.2, 62.5, 72, { mapIndex: 2 }),
  at(B, 'load', 72.2, 72.5, 73, { state: 'failed' }),
  at(B, 'load', 73.2, 73.5, 75, { tryNumber: 2 }),
];

describe('FR-DAGD-09 compare two runs of a DAG', () => {
  const c = compareRuns(runA, runB);

  it('FR-DAGD-09: ranks tasks by their contribution to the run duration difference (HM-007 timing)', () => {
    expect(c?.durationDeltaSeconds).toBe(7 * 60);
    expect(c?.ranking).toBe('critical-path');
    expect(c?.tasks.map((t) => [t.taskId, t.contributionSeconds])).toEqual([
      ['transform', 360],
      ['load', 60],
      ['extract', 0],
      ['cleanup', 0],
    ]);
    // Contributions sum to the difference: the critical path of each run sums to its duration.
    expect(c?.explainedSeconds).toBe(7 * 60);
    const load = c?.tasks.find((t) => t.taskId === 'load');
    expect(load).toMatchObject({ contributionWaitSeconds: 30, contributionRunningSeconds: 30 });
  });

  it('FR-DAGD-09 / HM-007: per-task deltas of duration and queue wait; mapped tasks collapse to the longest index', () => {
    const transform = c?.tasks.find((t) => t.taskId === 'transform');
    expect(transform?.a).toMatchObject({ mapIndexes: 2, mapIndex: 1, tries: 1, durationSeconds: 210 });
    expect(transform?.b).toMatchObject({
      mapIndexes: 3,
      mapIndex: 2,
      durationSeconds: 570,
      onCriticalPath: true,
    });
    expect(transform).toMatchObject({ durationDeltaSeconds: 360, queueWaitDeltaSeconds: 0 });
    // Retries add their wait and run time.
    const load = c?.tasks.find((t) => t.taskId === 'load');
    expect(load?.b).toMatchObject({ tries: 2, state: 'success', durationSeconds: 120, queueWaitSeconds: 36 });
    expect(load).toMatchObject({ durationDeltaSeconds: 30, queueWaitDeltaSeconds: 18 });
  });

  it("FR-DAGD-09: a task in one run only has no delta, and is off the other run's critical path", () => {
    const cleanup = c?.tasks.find((t) => t.taskId === 'cleanup');
    expect(cleanup?.a).toMatchObject({ durationSeconds: 30, onCriticalPath: false, criticalSeconds: 0 });
    expect(cleanup).toMatchObject({ b: null, durationDeltaSeconds: null, queueWaitDeltaSeconds: null });
  });

  it('FR-DAGD-09: with a run in progress there is no critical path; tasks rank by duration delta', () => {
    const running = [...runB.slice(0, 4), at(B, 'load', 72.2, 72.5, null, { state: 'running' })];
    const r = compareRuns(runA, running);
    expect(r).toMatchObject({
      ranking: 'duration-delta',
      durationDeltaSeconds: null,
      explainedSeconds: null,
    });
    expect(r?.tasks[0]?.taskId).toBe('transform');
    expect(r?.tasks.every((t) => t.contributionSeconds === null)).toBe(true);
    expect(r?.tasks.find((t) => t.taskId === 'load')?.b?.durationSeconds).toBeNull();
  });

  it('FR-DAGD-09: a skipped task never ran: no duration, and no step on the critical path', () => {
    const skipped = [...runA, at(A, 'notify', 9, 9, 9, { state: 'skipped' })];
    const r = compareRuns(skipped, runB);
    expect(r?.tasks.find((t) => t.taskId === 'notify')?.a).toMatchObject({
      state: 'skipped',
      mapIndexes: 0,
      durationSeconds: null,
      onCriticalPath: false,
    });
  });

  it('FR-DAGD-09: null without a started try in either run', () => {
    expect(compareRuns([], runB)).toBeNull();
    expect(compareRuns(runA, [tryAt({ runId: B, taskId: 'x', start: null })])).toBeNull();
  });

  it('FR-DAGD-09: for any two finished runs, the contributions add up to the duration difference', () => {
    const run = (runId: string) =>
      fc
        .array(
          fc.record({
            task: fc.constantFrom('a', 'b', 'c', 'd', 'e'),
            mapIndex: fc.integer({ min: -1, max: 2 }),
            start: fc.integer({ min: 0, max: 60 }),
            length: fc.integer({ min: 0, max: 30 }),
            wait: fc.integer({ min: 0, max: 5 }),
          }),
          { minLength: 1, maxLength: 12 },
        )
        .map((specs) => {
          const seen = new Set<string>();
          return specs
            .filter((s) => {
              const key = `${s.task}|${s.mapIndex}`;
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            })
            .map((s) =>
              at(runId, s.task, s.start - s.wait, s.start, s.start + s.length, { mapIndex: s.mapIndex }),
            );
        });
    fc.assert(
      fc.property(run(A), run(B), (a, b) => {
        const r = compareRuns(a, b);
        expect(r?.ranking).toBe('critical-path');
        expect(r?.explainedSeconds).toBeCloseTo(r?.durationDeltaSeconds ?? NaN, 6);
        const sum = (r?.tasks ?? []).reduce((s, t) => s + (t.contributionSeconds ?? 0), 0);
        expect(sum).toBeCloseTo(r?.durationDeltaSeconds ?? NaN, 6);
      }),
      { numRuns: 200 },
    );
  });
});
