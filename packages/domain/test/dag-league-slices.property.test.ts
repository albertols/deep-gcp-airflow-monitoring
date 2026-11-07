import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createLeagueAccumulator, dagLeague, type DagTaskTry, type DagLeagueResult } from '../src/index';
import { M, T0, tryAt, windowOf } from './fixtures';

const arbTry = fc.record({
  dagId: fc.constantFrom('a', 'b', 'c', 'd'),
  runId: fc.constantFrom('r1', 'r2', 'r3'),
  taskId: fc.constantFrom('t1', 't2'),
  mapIndex: fc.constant(-1),
  tryNumber: fc.integer({ min: 1, max: 3 }),
  // Some tries start before the previous window (at 20) and some run into the current one (from 80).
  start: fc.integer({ min: 0, max: 139 }),
  length: fc.integer({ min: 0, max: 50 }),
  running: fc.boolean(),
  // Null: a try the store closed without a state; skipped and upstream_failed never ran (HM-015).
  state: fc.constantFrom<string | null>(
    'success',
    'failed',
    'up_for_retry',
    'upstream_failed',
    'skipped',
    null,
  ),
  wait: fc.integer({ min: 0, max: 5 }),
  ready: fc.option(fc.integer({ min: 0, max: 8 }), { nil: null }),
});

/** What `TaskInstanceStore.taskTries` returns: started tries overlapping [from, to), or still running. */
const query = (tries: readonly DagTaskTry[], from: number, to: number) =>
  tries.filter((t) => t.startAt !== null && t.startAt < to && (t.endAt === null || t.endAt > from));

/** Cuts [from, to) at the given minute offsets. */
function slices(from: number, to: number, cuts: readonly number[]) {
  const points = [...new Set(cuts.map((c) => from + c * M).filter((p) => p > from && p < to))].sort(
    (a, b) => a - b,
  );
  const edges = [from, ...points, to];
  return edges.slice(0, -1).map((f, i) => ({ from: f, to: edges[i + 1] as number }));
}

/** Rounds floating-point sums, which add up in another order when sliced. */
const rounded = (league: DagLeagueResult) =>
  JSON.parse(
    JSON.stringify(league, (_k, v: unknown) =>
      typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1e6) / 1e6 : v,
    ),
  ) as unknown;

type TrySpec = {
  readonly dagId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly mapIndex: number;
  readonly tryNumber: number;
  readonly start: number;
  readonly length: number;
  readonly running: boolean;
  readonly state: string | null;
  readonly wait: number;
  readonly ready: number | null;
};

/** The league over every slicing of both windows equals `dagLeague` over one query of both. */
function sameLeague(
  specs: readonly TrySpec[],
  currentCuts: readonly number[],
  previousCuts: readonly number[],
  waitingDag: string | null,
) {
  // The store keeps one row per try (the natural key), as upserts are idempotent.
  const unique = [
    ...new Map(
      specs.map((s) => [`${s.dagId}/${s.runId}/${s.taskId}/${s.mapIndex}/${s.tryNumber}`, s]),
    ).values(),
  ];
  const tries = unique.map((s) =>
    tryAt({
      dagId: s.dagId,
      runId: s.runId,
      taskId: s.taskId,
      mapIndex: s.mapIndex,
      tryNumber: s.tryNumber,
      queued: s.start - s.wait,
      ready: s.ready === null ? null : s.start - s.wait - s.ready,
      start: s.start,
      end: s.running ? null : s.start + s.length,
      state: s.running ? 'running' : s.state,
    }),
  );
  const now = T0 + 140 * M;
  const window = windowOf(80, 140);
  const previousWindow = windowOf(20, 80, 140);
  const inProgress = (dagId: string, runId: string) => dagId === waitingDag && runId === 'r2';
  const dagIds = ['a', 'e'];

  const expected = dagLeague({
    tries: query(tries, previousWindow.from, now),
    window,
    previousWindow,
    dagIds,
    inProgress,
  });

  const acc = createLeagueAccumulator({ window, previousWindow, inProgress });
  // Each slice is read 1 ms early, so a zero-length try on a slice edge is not lost.
  for (const s of slices(window.from, now, currentCuts)) acc.addCurrent(query(tries, s.from - 1, s.to), s);
  for (const s of slices(previousWindow.from, previousWindow.to, previousCuts).reverse())
    acc.addPrevious(query(tries, s.from - 1, s.to), s);
  const actual = acc.result(dagIds);
  expect(rounded(actual)).toEqual(rounded(expected));
  return actual;
}

const cuts = fc.array(fc.integer({ min: 1, max: 59 }), { maxLength: 4 });

describe('NFR-PERF-01 the league from slices equals the league from one query', () => {
  it('NFR-PERF-01 / FR-DAGX-02: any slicing of both windows gives the same league as all tries at once', () => {
    fc.assert(
      fc.property(
        fc.array(arbTry, { maxLength: 40 }),
        cuts,
        cuts,
        fc.option(fc.constantFrom('a', 'b'), { nil: null }),
        (specs, currentCuts, previousCuts, waitingDag) => {
          sameLeague(specs, currentCuts, previousCuts, waitingDag);
        },
      ),
      { numRuns: 300 },
    );
  });

  // Rates need 20 task instances (HM-015): many mapped task instances of two DAGs, so flaky_rate is a number.
  const arbMappedTry = fc.record({
    dagId: fc.constantFrom('a', 'b'),
    runId: fc.constantFrom('r1', 'r2'),
    taskId: fc.constantFrom('t1', 't2'),
    mapIndex: fc.integer({ min: 0, max: 14 }),
    tryNumber: fc.integer({ min: 1, max: 3 }),
    // Mostly in the current window (from 80), some earlier: a task instance's tries may span both.
    start: fc.integer({ min: 60, max: 139 }),
    length: fc.integer({ min: 0, max: 30 }),
    running: fc.boolean(),
    state: fc.constantFrom<string | null>('success', 'success', 'failed', 'up_for_retry', 'skipped', null),
    wait: fc.integer({ min: 0, max: 5 }),
    ready: fc.constant(null),
  });

  it('NFR-PERF-01 / HM-015: flaky_rate and flaky_inferred, observed and inferred from the try number, are the same from any slicing', () => {
    let rated = 0;
    let inferred = 0;
    fc.assert(
      fc.property(
        fc.array(arbMappedTry, { minLength: 30, maxLength: 120 }),
        cuts,
        cuts,
        (specs, currentCuts, previousCuts) => {
          const league = sameLeague(specs, currentCuts, previousCuts, null);
          if (league.rows.some((r) => r.flakyRate !== null)) rated++;
          if (league.rows.some((r) => r.flakyInferred > 0)) inferred++;
        },
      ),
      { numRuns: 200 },
    );
    expect(rated).toBeGreaterThan(20);
    expect(inferred).toBeGreaterThan(20);
  });

  it('HM-015: a task instance stored only as a successful try 2 is inferred flaky, across slices', () => {
    const specs: TrySpec[] = Array.from({ length: 20 }, (_, i) => ({
      dagId: 'a',
      runId: 'r1',
      taskId: 't1',
      mapIndex: i,
      tryNumber: i < 5 ? 2 : 1,
      start: 85 + i,
      length: 5,
      running: false,
      state: 'success',
      wait: 1,
      ready: null,
    }));
    const league = sameLeague(specs, [10, 20], [30], null);
    expect(league.rows[0]?.flakyRate).toBe(5 / 20);
    expect(league.rows[0]?.flakyInferred).toBe(5);
  });

  it('HM-015: a try 1 closed without a state does not stop try 2 being inferred flaky; a skipped task instance is none', () => {
    const spec = (mapIndex: number, tryNumber: number, start: number, state: string | null): TrySpec => ({
      dagId: 'a',
      runId: 'r1',
      taskId: 't1',
      mapIndex,
      tryNumber,
      start,
      length: 2,
      running: false,
      state,
      wait: 1,
      ready: null,
    });
    const specs = [
      ...Array.from({ length: 20 }, (_, i) => spec(i, 1, 82 + i, 'success')),
      spec(0, 2, 110, 'success'), // after a try 1 that succeeded: not flaky
      spec(20, 1, 70, null), // closed without a state, in the previous window
      spec(20, 2, 112, 'success'),
      spec(21, 1, 114, 'skipped'), // never ran
    ];
    const league = sameLeague(specs, [25], [30], null);
    expect(league.rows[0]).toMatchObject({ taskInstances: 21, flaky: 1, flakyInferred: 1 });
  });

  it('NFR-PERF-01: a try counts once even when it spans every slice', () => {
    const long = tryAt({ dagId: 'a', start: 10, end: 139, state: 'success' });
    const window = windowOf(80, 140);
    const previousWindow = windowOf(20, 80, 140);
    const acc = createLeagueAccumulator({ window, previousWindow });
    for (const s of slices(window.from, window.to, [10, 20, 30]))
      acc.addCurrent(query([long], s.from - 1, s.to), s);
    for (const s of slices(previousWindow.from, previousWindow.to, [15, 30]).reverse())
      acc.addPrevious(query([long], s.from - 1, s.to), s);
    const [row] = acc.result([]).rows;
    expect(row?.executorSlotSeconds).toBe(59 * 60);
    expect(row?.peakConcurrency).toBe(1);
    expect(row?.previousShare).toBe(1);
    expect(row?.tries).toBe(0);
  });
});
