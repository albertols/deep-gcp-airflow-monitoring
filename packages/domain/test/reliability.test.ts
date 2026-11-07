import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { dagLeague, dagReliability, flakiness, type DagTaskTry } from '../src/index';
import { tryAt, windowOf } from './fixtures';

const W = windowOf(0, 24 * 60);
const run = (i: number) => `scheduled__run_${String(i).padStart(2, '0')}`;

describe('HM-015 flakiness of one task instance', () => {
  it('HM-015: succeeded after a stored failed try is flaky (observed)', () => {
    expect(
      flakiness([
        tryAt({ start: 0, end: 1, state: 'failed' }),
        tryAt({ tryNumber: 2, start: 3, end: 4, state: 'success' }),
      ]),
    ).toBe('observed');
    expect(
      flakiness([
        tryAt({ start: 0, end: 1, state: 'up_for_retry' }),
        tryAt({ tryNumber: 2, start: 3, end: 4, state: 'success' }),
      ]),
    ).toBe('observed');
  });

  it('HM-015: only a successful try 2 stored (backfilled history keeps the latest try) is flaky, inferred', () => {
    expect(flakiness([tryAt({ tryNumber: 2, start: 3, end: 4, state: 'success' })])).toBe('inferred');
  });

  it('HM-015: an earlier try closed by the store without a state, then a successful try 2, is flaky, inferred', () => {
    // The store ends a try that stopped showing as running, estimated and with state NULL, until its row is read.
    expect(
      flakiness([
        tryAt({ start: 0, end: 1, state: null }),
        tryAt({ tryNumber: 2, start: 3, end: 4, state: 'success' }),
      ]),
    ).toBe('inferred');
    expect(
      flakiness([
        tryAt({ start: 0, end: 1, state: null }),
        tryAt({ tryNumber: 2, start: 2, end: 3, state: 'failed' }),
        tryAt({ tryNumber: 3, start: 4, end: 5, state: 'success' }),
      ]),
    ).toBe('observed');
  });

  it('HM-015: a first-try success, a final failure, or a re-run after a success is not flaky', () => {
    expect(flakiness([tryAt({ start: 0, end: 1 })])).toBeNull();
    expect(
      flakiness([
        tryAt({ start: 0, end: 1, state: 'failed' }),
        tryAt({ tryNumber: 2, start: 3, end: 4, state: 'failed' }),
      ]),
    ).toBeNull();
    expect(
      flakiness([tryAt({ start: 0, end: 1 }), tryAt({ tryNumber: 2, start: 3, end: 4, state: 'success' })]),
    ).toBeNull();
    expect(flakiness([])).toBeNull();
  });

  it('HM-015: the league flaky rate counts inferred flaky task instances too', () => {
    const tries = Array.from({ length: 20 }, (_, i) =>
      tryAt({ runId: run(i), tryNumber: i < 4 ? 2 : 1, start: 60 + i, end: 61 + i }),
    );
    const league = dagLeague({
      tries,
      window: W,
      previousWindow: windowOf(-24 * 60, 0, 24 * 60),
      dagIds: ['dag_a'],
    });
    expect(league.rows[0]?.flakyRate).toBe(4 / 20);
  });
});

describe('HM-015 failures, retries and flakiness of one DAG', () => {
  /**
   * 20 hourly runs of two tasks. "extract" fails its first try in runs 0–4 and succeeds on the retry (5
   * flaky); in run 5 both tries fail, so the run fails. "load" always succeeds first time.
   */
  function fixture(): DagTaskTry[] {
    const tries: DagTaskTry[] = [];
    for (let i = 0; i < 20; i++) {
      const at = i * 60 + 1;
      if (i < 5) {
        tries.push(tryAt({ runId: run(i), taskId: 'extract', start: at, end: at + 2, state: 'failed' }));
        tries.push(tryAt({ runId: run(i), taskId: 'extract', tryNumber: 2, start: at + 5, end: at + 7 }));
        tries.push(tryAt({ runId: run(i), taskId: 'load', start: at + 8, end: at + 10 }));
      } else if (i === 5) {
        tries.push(tryAt({ runId: run(i), taskId: 'extract', start: at, end: at + 2, state: 'failed' }));
        tries.push(
          tryAt({
            runId: run(i),
            taskId: 'extract',
            tryNumber: 2,
            start: at + 5,
            end: at + 7,
            state: 'failed',
          }),
        );
      } else {
        tries.push(tryAt({ runId: run(i), taskId: 'extract', start: at, end: at + 2 }));
        tries.push(tryAt({ runId: run(i), taskId: 'load', start: at + 3, end: at + 5 }));
      }
    }
    return tries;
  }

  it('HM-015: try failure rate, retry rate and flaky rate per task, with counts', () => {
    const r = dagReliability(fixture(), W);
    expect(r.byTask.get('extract')).toEqual({
      tries: 26,
      failedTries: 7,
      tryFailureRate: 7 / 26,
      taskInstances: 20,
      retried: 6,
      retryRate: 6 / 20,
      flaky: 5,
      flakyInferred: 0,
      flakyRate: 5 / 20,
      // Runs 0–4 recover 5 min after the failure (end of try 1 → end of try 2). Run 5 fails twice (ending
      // 5:03 and 5:08); the next success ends at 6:03 in run 6: 60 min after the first failure.
      recoveries: 6,
      unrecovered: 0,
      mttrSeconds: ((5 * 5 + 60) * 60) / 6,
    });
    // 19 task instances of "load": below 20, so its rates are not shown.
    expect(r.byTask.get('load')).toMatchObject({
      taskInstances: 19,
      tryFailureRate: null,
      retryRate: null,
      flakyRate: null,
      recoveries: 0,
      mttrSeconds: null,
    });
  });

  it('HM-015: run failure rate and time to recovery per DAG, and the tries of all tasks together', () => {
    const r = dagReliability(fixture(), W);
    expect(r).toMatchObject({
      finishedRuns: 20,
      failedRuns: 1,
      runFailureRate: 1 / 20,
      runRecoveries: 1,
      runUnrecovered: 0,
    });
    // Run 5 ended at 5:08 (its last try), run 6 at 6:06: recovered 58 min later.
    expect(r.runMttrSeconds).toBe(58 * 60);
    expect(r.tasks).toMatchObject({ tries: 45, failedTries: 7, taskInstances: 39, retried: 6, flaky: 5 });
    expect(r.tasks.flakyRate).toBe(5 / 39);
  });

  it('HM-015: a failure without a later success is unrecovered, not a recovery of zero', () => {
    const tries = [
      tryAt({ runId: run(0), taskId: 'extract', start: 10, end: 12 }),
      tryAt({ runId: run(1), taskId: 'extract', start: 70, end: 72, state: 'failed' }),
    ];
    const r = dagReliability(tries, W);
    expect(r.byTask.get('extract')).toMatchObject({ recoveries: 0, unrecovered: 1, mttrSeconds: null });
    expect(r).toMatchObject({ runRecoveries: 0, runUnrecovered: 1, runMttrSeconds: null });
  });

  it('HM-015: skipped and upstream_failed task instances never ran: they are no tries and no task instances', () => {
    const tries = [
      tryAt({ runId: run(0), taskId: 'a', start: 10, end: 12, state: 'failed' }),
      tryAt({ runId: run(0), taskId: 'b', start: 12, end: 12, state: 'upstream_failed', queued: null }),
      tryAt({ runId: run(1), taskId: 'a', start: 70, end: 72 }),
      tryAt({ runId: run(1), taskId: 'b', start: 72, end: 72, state: 'skipped', queued: null }),
    ];
    const r = dagReliability(tries, W);
    expect(r.tasks).toMatchObject({ tries: 2, failedTries: 1, taskInstances: 2 });
    expect(r.byTask.has('b')).toBe(false);
    expect(
      dagLeague({ tries, window: W, previousWindow: windowOf(-24 * 60, 0, 24 * 60), dagIds: ['dag_a'] })
        .rows[0],
    ).toMatchObject({ tries: 2, taskInstances: 2 });
  });

  it('HM-015: outages are per map index: another map index succeeding is no recovery', () => {
    const tries = [
      tryAt({ taskId: 'm', mapIndex: 0, start: 10, end: 20, state: 'failed' }),
      tryAt({ taskId: 'm', mapIndex: 1, start: 10, end: 20.01 }),
      tryAt({ taskId: 'm', mapIndex: 2, start: 10, end: 20, state: 'failed' }),
      tryAt({ taskId: 'm', mapIndex: 2, tryNumber: 2, start: 25, end: 30 }),
    ];
    // Index 0 never recovered; index 2 recovered with its retry 10 min after its failure.
    expect(dagReliability(tries, W).byTask.get('m')).toMatchObject({
      recoveries: 1,
      unrecovered: 1,
      mttrSeconds: 600,
    });
    expect(dagReliability(tries, W).tasks).toMatchObject({ recoveries: 1, unrecovered: 1, mttrSeconds: 600 });
  });

  it('HM-015: only tries starting in the window count; a failure before it does not open an outage', () => {
    const tries = [
      tryAt({ runId: run(0), taskId: 'extract', start: -30, end: -28, state: 'failed' }),
      tryAt({ runId: run(1), taskId: 'extract', start: 10, end: 12 }),
    ];
    const r = dagReliability(tries, W);
    expect(r.byTask.get('extract')).toMatchObject({
      tries: 1,
      failedTries: 0,
      recoveries: 0,
      unrecovered: 0,
    });
  });

  it('HM-015: counts are consistent and every rate is in [0, 1]', () => {
    const arbTry = fc.record({
      runId: fc.constantFrom('r1', 'r2', 'r3', 'r4'),
      taskId: fc.constantFrom('a', 'b'),
      mapIndex: fc.constantFrom(-1, 0, 1),
      tryNumber: fc.integer({ min: 1, max: 3 }),
      start: fc.integer({ min: -60, max: 24 * 60 }),
      length: fc.integer({ min: 0, max: 30 }),
      state: fc.constantFrom('success', 'failed', 'up_for_retry', 'upstream_failed', 'running'),
    });
    fc.assert(
      fc.property(
        // The store keeps one row per try (natural key).
        fc.uniqueArray(arbTry, {
          maxLength: 60,
          selector: (s) => `${s.runId}|${s.taskId}|${s.mapIndex}|${s.tryNumber}`,
        }),
        (specs) => {
          const tries = specs.map((s) =>
            tryAt({
              runId: s.runId,
              taskId: s.taskId,
              mapIndex: s.mapIndex,
              tryNumber: s.tryNumber,
              start: s.start,
              end: s.state === 'running' ? null : s.start + s.length,
              state: s.state,
            }),
          );
          const r = dagReliability(tries, W);
          for (const t of [r.tasks, ...r.byTask.values()]) {
            expect(t.failedTries).toBeLessThanOrEqual(t.tries);
            expect(t.flaky).toBeLessThanOrEqual(t.retried);
            expect(t.flakyInferred).toBeLessThanOrEqual(t.flaky);
            expect(t.retried).toBeLessThanOrEqual(t.taskInstances);
            expect(t.taskInstances).toBeLessThanOrEqual(t.tries);
            for (const rate of [t.tryFailureRate, t.retryRate, t.flakyRate])
              if (rate !== null) expect(rate >= 0 && rate <= 1).toBe(true);
            if (t.mttrSeconds !== null) expect(t.mttrSeconds).toBeGreaterThanOrEqual(0);
            if (t.recoveries === 0) expect(t.mttrSeconds).toBeNull();
          }
          expect(r.failedRuns).toBeLessThanOrEqual(r.finishedRuns);
          if (r.runFailureRate !== null) expect(r.runFailureRate >= 0 && r.runFailureRate <= 1).toBe(true);
        },
      ),
    );
  });
});
