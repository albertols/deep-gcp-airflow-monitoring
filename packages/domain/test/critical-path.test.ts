import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { criticalPath, criticalPathFrequency, summariseRun, type DagTaskTry } from '../src/index';
import { tryAt, windowOf } from './fixtures';

const steps = (tries: readonly DagTaskTry[]) =>
  criticalPath(tries)?.steps.map((s) => (s.tryNumber > 1 ? `${s.taskId}#${s.tryNumber}` : s.taskId));

describe('HM-007 critical path of one run, estimated from timing', () => {
  // extract → (transform_a ‖ transform_b) → load: transform_b is the longer branch.
  const run = [
    tryAt({ taskId: 'extract', start: 0, end: 10 }),
    tryAt({ taskId: 'transform_a', start: 11, end: 20 }),
    tryAt({ taskId: 'transform_b', start: 11, end: 30 }),
    tryAt({ taskId: 'load', ready: 31, queued: 31.5, start: 32, end: 40 }),
  ];

  it('HM-007: steps back from the last end to the try that ended last before each step became ready', () => {
    const path = criticalPath(run);
    expect(steps(run)).toEqual(['extract', 'transform_b', 'load']);
    expect(path?.method).toBe('timing');
    expect(path?.steps.map((s) => [s.waitSeconds, s.runningSeconds])).toEqual([
      [0, 600],
      [60, 1_140],
      [120, 480],
    ]);
    expect(path).toMatchObject({ durationSeconds: 2_400, waitingSeconds: 180, runningSeconds: 2_220 });
  });

  it('HM-007: a retry follows its own failed try, even when another try ended in between', () => {
    const tries = [
      tryAt({ taskId: 'x', start: 0, end: 5, state: 'failed' }),
      tryAt({ taskId: 'side', start: 1, end: 5.5 }),
      tryAt({ taskId: 'x', tryNumber: 2, ready: 6, queued: 6.5, start: 7, end: 12 }),
      tryAt({ taskId: 'y', start: 13, end: 20 }),
    ];
    expect(steps(tries)).toEqual(['x', 'x#2', 'y']);
    // Retries add their wait and run time (HM-007).
    expect(criticalPath(tries)?.steps[1]).toMatchObject({ waitSeconds: 120, runningSeconds: 300 });
  });

  it('HM-007: a root that started after the run began waits from the run start, so the path is the run', () => {
    const tries = [
      tryAt({ taskId: 'quick_root', start: 0, end: 2 }),
      tryAt({ taskId: 'slow_root', start: 1, end: 50 }),
    ];
    expect(steps(tries)).toEqual(['slow_root']);
    expect(criticalPath(tries)).toMatchObject({ durationSeconds: 3_000, waitingSeconds: 60 });
  });

  it('HM-007: mapped task instances collapse to the map index that ended last; skipped ones never started', () => {
    const tries = [
      tryAt({ taskId: 'fan', mapIndex: 0, start: 0, end: 5 }),
      tryAt({ taskId: 'fan', mapIndex: 1, start: 0, end: 9 }),
      tryAt({ taskId: 'skipped', start: null, state: 'skipped' }),
      tryAt({ taskId: 'join', start: 10, end: 12 }),
    ];
    expect(criticalPath(tries)?.steps.map((s) => `${s.taskId}[${s.mapIndex}]`)).toEqual([
      'fan[1]',
      'join[-1]',
    ]);
  });

  it('HM-007: a run with a try still running, or without tries, has no critical path yet', () => {
    expect(criticalPath([...run, tryAt({ taskId: 'late', start: 41, end: null })])).toBeNull();
    expect(criticalPath([])).toBeNull();
  });

  it('HM-007: across the finished runs of a window, how often each task is on the critical path', () => {
    const runOf = (runId: string, offset: number, longB: boolean) => [
      tryAt({ runId, taskId: 'extract', start: offset, end: offset + 10 }),
      tryAt({ runId, taskId: 'transform_a', start: offset + 11, end: offset + (longB ? 20 : 30) }),
      tryAt({ runId, taskId: 'transform_b', start: offset + 11, end: offset + (longB ? 30 : 20) }),
      tryAt({ runId, taskId: 'load', start: offset + 31, end: offset + 40 }),
    ];
    const tries = [
      ...runOf('r1', 60, true),
      ...runOf('r2', 120, true),
      ...runOf('r3', 180, false),
      tryAt({ runId: 'r4', taskId: 'extract', start: 230, end: null }),
    ];
    const frequency = criticalPathFrequency(tries, windowOf(60, 240));
    expect(frequency.runs).toBe(3);
    expect(Object.fromEntries(frequency.byTask)).toEqual({
      extract: 3,
      transform_a: 1,
      transform_b: 2,
      load: 3,
    });
  });

  it('HM-007: the path sums to the run duration; its steps are distinct and follow each other in time', () => {
    const arbTry = fc.record({
      taskId: fc.constantFrom('a', 'b', 'c', 'd', 'e'),
      tryNumber: fc.integer({ min: 1, max: 2 }),
      start: fc.integer({ min: 0, max: 120 }),
      length: fc.integer({ min: 0, max: 30 }),
      lead: fc.integer({ min: 0, max: 5 }),
      failed: fc.boolean(),
    });
    fc.assert(
      fc.property(
        fc.uniqueArray(arbTry, {
          minLength: 1,
          maxLength: 12,
          selector: (s) => `${s.taskId}|${s.tryNumber}`,
        }),
        (specs) => {
          const tries = specs.map((s) =>
            tryAt({
              taskId: s.taskId,
              tryNumber: s.tryNumber,
              ready: s.start - s.lead,
              queued: s.start - s.lead / 2,
              start: s.start,
              end: s.start + s.length,
              state: s.failed ? 'failed' : 'success',
            }),
          );
          const path = criticalPath(tries);
          const run = summariseRun(tries);
          expect(path).not.toBeNull();
          if (!path || !run) return;
          expect(path.durationSeconds).toBeCloseTo(run.durationSeconds as number, 6);
          expect(path.waitingSeconds + path.runningSeconds).toBeCloseTo(path.durationSeconds, 6);
          const keys = path.steps.map((s) => `${s.taskId}|${s.mapIndex}|${s.tryNumber}`);
          expect(new Set(keys).size).toBe(keys.length);
          path.steps.forEach((s, i) => {
            expect(s.waitSeconds).toBeGreaterThanOrEqual(0);
            const next = path.steps[i + 1];
            if (next) expect(s.endAt).toBeLessThanOrEqual(next.startAt);
          });
        },
      ),
    );
  });
});
