import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { dagLeague } from '../src/index';
import { tryAt, windowOf } from './fixtures';

const arbTry = fc.record({
  dagId: fc.constantFrom('a', 'b', 'c', 'd'),
  runId: fc.constantFrom('r1', 'r2', 'r3'),
  taskId: fc.constantFrom('t1', 't2'),
  tryNumber: fc.integer({ min: 1, max: 3 }),
  start: fc.integer({ min: 0, max: 119 }),
  length: fc.integer({ min: 0, max: 40 }),
  running: fc.boolean(),
  failed: fc.boolean(),
  wait: fc.integer({ min: 0, max: 5 }),
});

describe('FR-DAGX-02 / FR-DAGX-03 league invariants', () => {
  it('FR-DAGX-02: shares sum to 1, cumulative share rises to 1, and every rate stays within [0, 1]', () => {
    fc.assert(
      fc.property(fc.array(arbTry, { maxLength: 40 }), (specs) => {
        const tries = specs.map((s) =>
          tryAt({
            dagId: s.dagId,
            runId: s.runId,
            taskId: s.taskId,
            tryNumber: s.tryNumber,
            queued: s.start - s.wait,
            start: s.start,
            end: s.running ? null : s.start + s.length,
            state: s.running ? 'running' : s.failed ? 'failed' : 'success',
          }),
        );
        const league = dagLeague({
          tries,
          window: windowOf(60, 120),
          previousWindow: windowOf(0, 60, 120),
          dagIds: ['a', 'e'],
        });
        const shares = league.rows.reduce((s, r) => s + r.share, 0);
        if (league.totalExecutorSlotSeconds > 0) expect(shares).toBeCloseTo(1, 9);
        let previous = 0;
        for (const r of league.rows) {
          expect(r.cumulativeShare).toBeGreaterThanOrEqual(previous);
          previous = r.cumulativeShare;
          for (const rate of [r.share, r.previousShare, r.successRate, r.flakyRate, r.cumulativeShare])
            if (rate !== null) expect(rate >= 0 && rate <= 1).toBe(true);
          expect(r.failedRuns).toBeLessThanOrEqual(r.runs);
          expect(r.retries).toBeLessThanOrEqual(r.tries);
          expect(r.peakConcurrency).toBeGreaterThanOrEqual(r.executorSlotSeconds > 0 ? 1 : 0);
        }
        if (league.activeDagCount > 0)
          expect(league.rows[league.activeDagCount - 1]?.cumulativeShare).toBe(1);
        expect(league.gini).toBeGreaterThanOrEqual(0);
        expect(league.gini).toBeLessThanOrEqual(1);
        expect(league.rows.map((r) => r.dagId)).toEqual(expect.arrayContaining(['a', 'e']));
      }),
    );
  });
});
