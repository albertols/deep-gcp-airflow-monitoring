import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  attributeWaiting,
  createAttribution,
  createPoolActivity,
  createPriorityFairness,
  createSlotsPerMinute,
  poolActivity,
  priorityFairness,
  rawCadenceMs,
  slotsPerMinute,
  slotsSourceOf,
  type Attribution,
  type EnvironmentConfig,
  type LiveSnapshot,
  type SnapshotTaskInstance,
  type WorkerCountSource,
  type WorkerSample,
} from '../src/index';

const T0 = Date.UTC(2026, 10, 5, 0, 0, 0);
const S = 1_000;
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
  pools: [
    { name: 'tiny', slots: 1 },
    { name: 'default_pool', slots: 8 },
  ],
};
const ctx = { config, dagMaxActiveTasks: new Map([['b', 1]]) };

const ti = (dagId: string, pool: string, since: number): SnapshotTaskInstance => ({
  dagId,
  runId: 'r',
  taskId: 't',
  mapIndex: -1,
  tryNumber: 1,
  pool,
  poolSlots: 1,
  priorityWeight: 1,
  since,
});

const arbSnapshot = fc.record({
  gap: fc.integer({ min: 1, max: 200 }),
  // Thinned by the disk budget (FR-STORE-07): the snapshot carries the span its 5-minute bucket stood for.
  spanMs: fc.option(fc.integer({ min: 0, max: 300 * S }), { nil: undefined, freq: 4 }),
  ready: fc.array(
    fc.tuple(
      fc.constantFrom('a', 'b', 'c'),
      fc.constantFrom('tiny', 'default_pool'),
      fc.constantFrom('t1', 't2'),
      fc.constantFrom(1, 5, 10),
    ),
    { maxLength: 3 },
  ),
  queued: fc.integer({ min: 0, max: 2 }),
  workers: fc.integer({ min: 1, max: 2 }),
  running: fc.integer({ min: 0, max: 8 }),
  open: fc.integer({ min: 0, max: 1 }),
  // Where the snapshot's worker count came from (HM-011 slots source); absent on older snapshots.
  source: fc.option(fc.constantFrom<WorkerCountSource>('monitoring', 'config', 'hostnames'), {
    nil: undefined,
  }),
});

/** Plain values for comparison: Maps become sorted entry lists, floats are rounded. */
const plainValue = (a: unknown) =>
  JSON.parse(
    JSON.stringify(a, (_k, v: unknown) => {
      if (v instanceof Map) return [...v].sort((x, y) => String(x[0]).localeCompare(String(y[0])));
      if (typeof v === 'number' && !Number.isInteger(v)) return Math.round(v * 1e6) / 1e6;
      return v;
    }),
  ) as unknown;
const plain = (a: Attribution) => plainValue(a);

type SnapshotSpec = {
  readonly gap: number;
  readonly spanMs: number | undefined;
  readonly ready: ReadonlyArray<readonly [string, string, string, number]>;
  readonly queued: number;
  readonly workers: number;
  readonly running: number;
  readonly open: number;
  readonly source: WorkerCountSource | undefined;
};

function snapshotsOf(specs: readonly SnapshotSpec[]): LiveSnapshot[] {
  let at = T0;
  return specs.map((s) => {
    at += s.gap * S;
    return {
      at,
      ...(s.spanMs === undefined ? {} : { spanMs: s.spanMs }),
      scheduled: s.ready.map(([dag, pool, task, weight]) => ({
        ...ti(dag, pool, T0 - 40 * S),
        taskId: task,
        priorityWeight: weight,
      })),
      queued: Array.from({ length: s.queued }, () => ti('c', 'default_pool', at - 90 * S)),
      pools: [
        { name: 'tiny', slots: 1, running: 1 - s.open, queued: 0, open: s.open },
        { name: 'default_pool', slots: 8, running: s.running, queued: s.queued, open: 8 - s.running },
      ],
      dagActive: { b: s.ready.length },
      executor: { running: s.running, queued: s.queued },
      workers: { current: s.workers, target: 2, ...(s.source === undefined ? {} : { source: s.source }) },
    };
  });
}

/** The snapshots cut into consecutive batches at the given indexes. */
function batches<T>(items: readonly T[], cuts: readonly number[]): T[][] {
  const edges = [0, ...new Set(cuts.filter((c) => c < items.length)), items.length].sort((x, y) => x - y);
  return edges.slice(0, -1).map((e, i) => items.slice(e, edges[i + 1]));
}

const OPTS = { from: T0 + 30 * S, to: T0 + 3_000 * S, bucketMs: 300 * S, fallbackCadenceMs: 30 * S };
const SAMPLES: WorkerSample[] = Array.from({ length: 20 }, (_, i) => ({
  at: T0 + (120 + i * 120) * S,
  workers: 2,
  target: 2,
  running: 6,
  queued: 1,
  cpu: 0.4,
  memory: 0.5,
}));

describe('NFR-PERF-01 waiting attribution from slices of snapshots', () => {
  it('NFR-PERF-01 / FR-BOTL-01 / FR-STORE-07: snapshots added in any number of batches, raw or thinned, give the same attribution as all at once', () => {
    fc.assert(
      fc.property(
        fc.array(arbSnapshot, { maxLength: 30 }),
        fc.array(fc.integer({ min: 1, max: 29 }), { maxLength: 4 }),
        (specs, cuts) => {
          const snapshots = snapshotsOf(specs);
          const expected = attributeWaiting(snapshots, ctx, OPTS);
          const inWindow = snapshots.filter((s) => s.at >= OPTS.from && s.at < OPTS.to);
          const acc = createAttribution(ctx, { ...OPTS, cadenceMs: rawCadenceMs(inWindow) });
          for (const batch of batches(snapshots, cuts)) acc.add(batch);
          const actual = acc.result();
          expect(plain(actual)).toEqual(plain(expected));
          // Top contributors per pool (HM-006 output) come out of the batches too.
          expect([...actual.byReasonPool.keys()]).toEqual([...expected.byReasonPool.keys()]);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('NFR-PERF-01 / FR-ENV-08 / HM-023 / HM-017: pool activity, priority bands and executor slots per minute are the same from batches', () => {
    fc.assert(
      fc.property(
        fc.array(arbSnapshot, { maxLength: 30 }),
        fc.array(fc.integer({ min: 1, max: 29 }), { maxLength: 4 }),
        (specs, cuts) => {
          const snapshots = snapshotsOf(specs);
          const inWindow = snapshots.filter((s) => s.at >= OPTS.from && s.at < OPTS.to);

          const pools = createPoolActivity(config, { ...OPTS, cadenceMs: rawCadenceMs(inWindow) });
          const bands = createPriorityFairness(OPTS);
          const slots = createSlotsPerMinute({ samples: SAMPLES, config, from: OPTS.from, to: OPTS.to });
          for (const batch of batches(snapshots, cuts)) {
            pools.add(batch);
            bands.add(batch);
            slots.add(batch);
          }
          expect(plainValue(pools.result())).toEqual(plainValue(poolActivity(snapshots, config, OPTS)));
          expect(bands.result()).toEqual(priorityFairness(snapshots, OPTS));
          const whole = { samples: SAMPLES, snapshots, config, from: OPTS.from, to: OPTS.to };
          expect(slots.result()).toEqual(slotsPerMinute(whole));
          expect(slots.source()).toEqual(slotsSourceOf(whole));
        },
      ),
      { numRuns: 300 },
    );
  });

  it('NFR-PERF-01: the latest snapshot stands for one cadence up to the window end', () => {
    const one: LiveSnapshot = {
      at: T0,
      scheduled: [ti('a', 'tiny', T0 - 60 * S)],
      queued: [],
      pools: [{ name: 'tiny', slots: 1, running: 1, queued: 0, open: 0 }],
      dagActive: {},
      executor: { running: 1, queued: 0 },
      workers: { current: 1, target: 1 },
    };
    const acc = createAttribution(ctx, {
      from: T0,
      to: T0 + 3_600 * S,
      bucketMs: 600 * S,
      fallbackCadenceMs: 30 * S,
      cadenceMs: null,
    });
    acc.add([one]);
    const a = acc.result();
    expect(a.totals.get('pool-exhausted')).toBe(30 * S);
    expect(a.coveredMs).toBe(30 * S);
    expect(a.latest?.snapshot).toBe(one);
  });
});
