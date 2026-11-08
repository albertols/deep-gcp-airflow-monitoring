import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  noisyNeighbours,
  slotsPerMinute,
  slotsSourceOf,
  type EnvironmentConfig,
  type LiveSnapshot,
  type NeighbourTry,
  type TaskTry,
  type WorkerSample,
} from '../src/index';

/** HM-017 reads four fields of a try; the tests build whole tries, as the store returns them. */
type Try = NeighbourTry & TaskTry;

const SEC = 1_000;
const MIN = 60 * SEC;
const H = 60 * MIN;
/** A Monday 00:00 UTC, so that hours of the week are easy to read. */
const T0 = Date.UTC(2026, 10, 2, 0, 0, 0);

const t = (dagId: string, queuedMin: number, waitSec: number, runSec = 1, extra: Partial<Try> = {}): Try => {
  const queuedAt = T0 + queuedMin * MIN;
  const startAt = queuedAt + waitSec * SEC;
  return {
    dagId,
    runId: `r${queuedMin}`,
    taskId: `t${Math.round(waitSec)}`,
    mapIndex: -1,
    tryNumber: 1,
    pool: 'default_pool',
    poolSlots: 1,
    queuedAt,
    startAt,
    endAt: startAt + runSec * SEC,
    ...extra,
  };
};

/**
 * Three hours with 10 executor slots. `hog` runs one try (10 % of the slots) for minutes 0–29 and 60–99.
 * Each minute four small DAGs queue one try each: in hour 0 they wait 120 s while hog runs and 60 s while it
 * does not; in hour 1, 300 s and 120 s; in hour 2 (hog never runs) 600 s.
 */
function golden(): Try[] {
  const tries: Try[] = [
    t('hog', 0, 0, 30 * 60, { taskId: 'big_1' }),
    t('hog', 60, 0, 40 * 60, { taskId: 'big_2' }),
  ];
  for (let m = 0; m < 180; m++) {
    const hour = Math.floor(m / 60);
    const active = m < 30 || (m >= 60 && m < 100);
    const wait = hour === 2 ? 600 : hour === 0 ? (active ? 120 : 60) : active ? 300 : 120;
    for (const dag of ['s1', 's2', 's3', 's4']) tries.push(t(dag, m, wait));
  }
  return tries;
}
const window = { from: T0, to: T0 + 3 * H, now: T0 + 3 * H };
const tenSlots = new Array<number | null>(180).fill(10);

describe('HM-017 noisy-neighbour effect (FR-BOTL-06)', () => {
  const result = noisyNeighbours({ tries: golden(), slots: tenSlots, ...window });
  const hog = result.items.find((x) => x.dagId === 'hog');

  it('HM-017: compares other DAGs’ queue wait in minutes when D holds ≥ 10 % of slots with matched inactive minutes', () => {
    expect(result.evaluated).toBe(true);
    expect(hog?.activeMinutes).toBe(70);
    expect(hog?.affectedTries).toBe(280);
    expect(hog?.controlTries).toBe(200);
    // Active: 120 tries at 120 s (hour 0) and 160 at 300 s (hour 1).
    expect(hog?.medianActiveMs).toBe(300 * SEC);
    // Hour 2 has no active minute, so its 600 s waits are no control. Hour 1's 80 controls (120 s) weigh
    // twice to match the active tries' mix (160 of 280 in hour 1); unweighted, the median would be 60 s.
    expect(hog?.medianInactiveMs).toBe(120 * SEC);
    expect(hog?.effectMs).toBe(180 * SEC);
    expect(hog?.matchedShare).toBe(1);
  });

  it('HM-017: ranks by effect × affected tries and shows the overlap windows as evidence', () => {
    expect(result.items[0]?.dagId).toBe('hog');
    expect(hog?.scoreTaskMs).toBe(180 * SEC * 280);
    expect(hog?.overlapWindows).toEqual([
      { from: T0, to: T0 + 30 * MIN },
      { from: T0 + 60 * MIN, to: T0 + 100 * MIN },
    ]);
  });

  it('HM-017: a 95 % bootstrap interval from 1,000 resamples; a clear effect is high confidence', () => {
    expect(hog?.ci).not.toBeNull();
    expect(hog?.ci?.lowMs).toBeGreaterThan(0);
    expect(hog?.ci?.lowMs).toBeLessThanOrEqual(hog?.effectMs ?? 0);
    expect(hog?.ci?.highMs).toBeGreaterThanOrEqual(hog?.effectMs ?? 0);
    expect(hog?.confidence).toBe('high');
    expect(result.resamples).toBe(1_000);
  });

  it('HM-017: DAGs below 60 active minutes or 200 affected tries never qualify', () => {
    // Small DAGs run every minute, so they have no inactive minutes and hold < 10 % of the slots.
    expect(result.items.map((x) => x.dagId)).toEqual(['hog']);
    const short = golden().filter((x) => !(x.dagId === 'hog' && x.taskId === 'big_2'));
    expect(noisyNeighbours({ tries: short, slots: tenSlots, ...window }).items).toEqual([]);
    const few = golden().filter((x) => x.dagId === 'hog' || x.dagId === 's1' || x.dagId === 's2');
    expect(noisyNeighbours({ tries: few, slots: tenSlots, ...window }).items).toEqual([]);
  });

  it('HM-017: one mapped task queued in one minute cannot meet 200 affected tries alone: 30 distinct minutes', () => {
    // hog holds 10 % of the slots in minutes 0–69. A mapped task queues 250 map indexes in minute 65; another
    // DAG queues 4 tries a minute in minutes 70–119 (inactive, the same hour of the week).
    const tries: NeighbourTry[] = [t('hog', 0, 0, 70 * 60, { taskId: 'big' })];
    for (let i = 0; i < 250; i++) tries.push(t('mapped', 65, 300, 1, { taskId: 'fan', mapIndex: i }));
    for (let m = 70; m < 120; m++) for (const dag of ['s1', 's2', 's3', 's4']) tries.push(t(dag, m, 60));
    const r = noisyNeighbours({ tries, slots: tenSlots, ...window });
    expect(r.qualified).toBe(0);
    expect(r.items).toEqual([]);
    // The rule is DCAM's addition to the spec's 60 active minutes and 200 affected tries.
    expect(
      noisyNeighbours({ tries, slots: tenSlots, ...window }, { minAffectedMinutes: 1 }).items,
    ).toMatchObject([{ dagId: 'hog', affectedTries: 250, affectedMinutes: 1 }]);
    expect(hog?.affectedMinutes).toBe(70);
  });

  it('HM-017: the bootstrap resamples minutes, so copying every try within its minute leaves the interval as it is', () => {
    // Tries queued in one minute (a cron burst, a mapped task's expansion) are correlated: one block each.
    const noisy = golden().map((x, i) =>
      x.dagId === 'hog' ? x : { ...x, startAt: (x.startAt as number) + ((i * 37) % 90) * SEC },
    );
    const copied = noisy.flatMap((x) =>
      x.dagId === 'hog' ? [x] : [x, { ...x, taskId: `${x.taskId}_b` }, { ...x, taskId: `${x.taskId}_c` }],
    );
    const once = noisyNeighbours({ tries: noisy, slots: tenSlots, ...window }).items[0];
    const thrice = noisyNeighbours({ tries: copied, slots: tenSlots, ...window }).items[0];
    expect(thrice?.affectedTries).toBe(3 * (once?.affectedTries ?? 0));
    expect(thrice?.effectMs).toBeCloseTo(once?.effectMs ?? NaN, 6);
    expect(thrice?.ci?.lowMs).toBeCloseTo(once?.ci?.lowMs ?? NaN, 6);
    expect(thrice?.ci?.highMs).toBeCloseTo(once?.ci?.highMs ?? NaN, 6);
  });

  it('HM-017: without known slots (worker_concurrency unknown) nothing is evaluated', () => {
    const none = noisyNeighbours({ tries: golden(), slots: new Array(180).fill(null), ...window });
    expect(none.evaluated).toBe(false);
    expect(none.items).toEqual([]);
  });

  it('HM-017: is association only; waits unrelated to D give an interval that includes 0 and low confidence', () => {
    // Waits cycle 30, 60, 90 s whatever hog does: no association.
    const tries = golden().map((x, i) =>
      x.dagId === 'hog' ? x : { ...x, startAt: (x.queuedAt as number) + (30 + (i % 3) * 30) * SEC },
    );
    const r = noisyNeighbours({ tries, slots: tenSlots, ...window });
    const item = r.items.find((x) => x.dagId === 'hog');
    if (item) {
      expect(item.ci?.lowMs ?? 0).toBeLessThanOrEqual(0);
      expect(item.confidence).toBe('low');
    }
  });

  it('HM-017: deterministic, and the effect does not change when every other wait shifts by the same time', () => {
    const shift = (tries: readonly Try[], sec: number) =>
      tries.map((x) => (x.dagId === 'hog' ? x : { ...x, startAt: (x.startAt as number) + sec * SEC }));
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 600 }), (sec) => {
        const r = noisyNeighbours({ tries: shift(golden(), sec), slots: tenSlots, ...window });
        expect(r.items[0]?.effectMs).toBeCloseTo(180 * SEC, 6);
      }),
      { numRuns: 10 },
    );
    const again = noisyNeighbours({ tries: golden(), slots: tenSlots, ...window });
    expect(again).toEqual(result);
  });

  it('HM-017: every listed DAG meets the minimum samples, and its interval is ordered', () => {
    const arb = fc.array(
      fc.record({
        dag: fc.constantFrom('a', 'b', 'c', 'd'),
        minute: fc.integer({ min: 0, max: 119 }),
        wait: fc.integer({ min: 0, max: 900 }),
        run: fc.integer({ min: 1, max: 3_600 }),
      }),
      { maxLength: 120 },
    );
    fc.assert(
      fc.property(arb, (specs) => {
        const tries = specs.map((s, i) => t(s.dag, s.minute, s.wait, s.run, { taskId: `x${i}` }));
        const opts = {
          minActiveMinutes: 5,
          minAffectedTries: 5,
          minAffectedMinutes: 2,
          minControlTries: 5,
          resamples: 50,
        };
        const r = noisyNeighbours(
          { tries, slots: new Array(120).fill(4), from: T0, to: T0 + 2 * H, now: T0 + 2 * H },
          opts,
        );
        for (const x of r.items) {
          expect(x.activeMinutes).toBeGreaterThanOrEqual(5);
          expect(x.affectedTries).toBeGreaterThanOrEqual(5);
          expect(x.affectedMinutes).toBeGreaterThanOrEqual(2);
          expect(x.controlTries).toBeGreaterThanOrEqual(5);
          expect(x.effectMs).toBeGreaterThan(0);
          if (x.ci) expect(x.ci.lowMs).toBeLessThanOrEqual(x.ci.highMs);
        }
      }),
      { numRuns: 60 },
    );
  });
});

describe('HM-017 executor slots per minute', () => {
  const config: Pick<EnvironmentConfig, 'workerConcurrency' | 'limitSources'> = { workerConcurrency: 12 };
  const sample = (at: number, workers: number): WorkerSample => ({
    at,
    workers,
    target: workers,
    running: 0,
    queued: 0,
    cpu: 0,
    memory: 0,
  });
  const snapshot = (at: number, workers: number): LiveSnapshot => ({
    at,
    scheduled: [],
    queued: [],
    pools: [],
    dagActive: {},
    executor: { running: 0, queued: 0 },
    workers: { current: workers, target: workers },
  });

  it('HM-017: workers × worker_concurrency from worker samples, else from the snapshot in that minute, else unknown', () => {
    const slots = slotsPerMinute({
      samples: [sample(T0, 2), sample(T0 + MIN, 3)],
      snapshots: [snapshot(T0 + 2 * MIN + 10 * SEC, 4)],
      config,
      from: T0,
      to: T0 + 4 * MIN,
    });
    expect(slots).toEqual([24, 36, 48, null]);
  });

  it('HM-011: the slots say where the worker count came from; a count from worker hostnames is the weakest', () => {
    const counted = (source: 'hostnames' | 'config', at = T0 + 2 * MIN) => ({
      ...snapshot(at, 4),
      workers: { current: 4, target: 4, source },
    });
    const input = { config, from: T0, to: T0 + 4 * MIN };
    expect(slotsSourceOf({ ...input, samples: [sample(T0, 2)], snapshots: [] })).toBe('monitoring');
    expect(slotsSourceOf({ ...input, samples: [sample(T0, 2)], snapshots: [counted('config')] })).toBe(
      'config',
    );
    expect(
      slotsSourceOf({
        ...input,
        samples: [sample(T0, 2)],
        snapshots: [counted('config'), counted('hostnames', T0 + 3 * MIN)],
      }),
    ).toBe('hostnames');
    // A sample of the same minute replaces the snapshot's count; snapshots stored without a source say nothing.
    expect(
      slotsSourceOf({ ...input, samples: [sample(T0 + 2 * MIN, 2)], snapshots: [counted('hostnames')] }),
    ).toBe('monitoring');
    expect(slotsSourceOf({ ...input, samples: [], snapshots: [snapshot(T0, 4)] })).toBeNull();
    expect(
      slotsSourceOf({
        ...input,
        samples: [sample(T0, 2)],
        snapshots: [],
        config: { workerConcurrency: 1_000_000, limitSources: { workerConcurrency: 'unknown' } },
      }),
    ).toBeNull();
  });

  it('HM-032: an unknown worker_concurrency gives no slots at all', () => {
    const slots = slotsPerMinute({
      samples: [sample(T0, 2)],
      snapshots: [],
      config: { workerConcurrency: 1_000_000, limitSources: { workerConcurrency: 'unknown' } },
      from: T0,
      to: T0 + 2 * MIN,
    });
    expect(slots).toEqual([null, null]);
  });
});
