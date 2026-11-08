import { describe, expect, it } from 'vitest';
import {
  UNKNOWN_LIMIT,
  capacityAnalysis,
  type EnvironmentConfig,
  type LiveSnapshot,
  type TaskTry,
  type WorkerCountSource,
  type WorkerSample,
} from '../src/index';

const T0 = Date.UTC(2026, 10, 5, 0, 0, 0);
const MIN = 60_000;
const at = (minute: number) => T0 + minute * MIN;

const config: EnvironmentConfig = {
  envId: 'acme-prod',
  tier: 'prod',
  composerImage: 'composer-3-airflow-2.11.1-build.22',
  airflowVersion: '2.11.1',
  parallelism: 100,
  schedulers: 1,
  maxActiveTasksPerDag: 16,
  maxActiveRunsPerDag: 25,
  workerConcurrency: 10,
  minWorkers: 1,
  maxWorkers: 3,
  pools: [{ name: 'default_pool', slots: 128 }],
};

const sample = (minute: number, p: Partial<WorkerSample>): WorkerSample => ({
  at: at(minute),
  workers: 1,
  target: 1,
  running: 0,
  queued: 0,
  cpu: 0.2,
  memory: 0.3,
  ...p,
});

const snapshot = (
  ms: number,
  workers: number,
  running: number,
  queued: number,
  source?: WorkerCountSource,
): LiveSnapshot => ({
  at: ms,
  scheduled: [],
  queued: [],
  pools: [],
  dagActive: {},
  executor: { running, queued },
  workers: { current: workers, target: workers, ...(source ? { source } : {}) },
});

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);

/**
 * Minutes 0–19 and 45–59 have Cloud Monitoring samples; minutes 20 and 25 only live snapshots (hostname counts);
 * minutes 21–24 and 26–44 nothing. Workers scale 1 → 2 → 3 from minute 5 and sit at max_count (3) with 12 queued
 * from minute 8 to 19.
 */
function scenario() {
  const samples: WorkerSample[] = [
    ...range(0, 5).map((m) => sample(m, { workers: 1, running: 5 })),
    sample(5, { workers: 1, target: 3, running: 10, queued: 15 }),
    ...range(6, 8).map((m) => sample(m, { workers: 2, target: 3, running: 20, queued: 12 })),
    ...range(8, 20).map((m) => sample(m, { workers: 3, target: 3, running: 30, queued: 12, cpu: 0.9 })),
    ...range(45, 60).map((m) => sample(m, { workers: 2, target: 2, running: 4 })),
  ];
  const snapshots = [
    snapshot(at(20), 3, 20, 0, 'hostnames'),
    snapshot(at(20) + 30_000, 3, 25, 0, 'hostnames'),
    snapshot(at(25), 3, 25, 0, 'hostnames'),
  ];
  return { samples, snapshots };
}

const analyse = (over: Partial<Parameters<typeof capacityAnalysis>[0]> = {}) => {
  const { samples, snapshots } = scenario();
  return capacityAnalysis({
    config,
    samples,
    snapshots,
    tries: [],
    from: T0,
    to: at(60),
    bucketMs: 15 * MIN,
    ...over,
  });
};

describe('capacityAnalysis (FR-ENV-02, HM-011, HM-012)', () => {
  it('HM-011: a minute takes the worker sample, else the last snapshot in it; minutes with neither are gaps', () => {
    const a = analyse();
    expect(a.observedMinutes).toBe(37);
    expect(a.windowMinutes).toBe(60);
    expect(a.buckets.map((b) => b.observedMinutes)).toEqual([15, 7, 0, 15]);
    // Minute 20 takes its last snapshot (25 running), not the first (20).
    expect(a.buckets[1]?.runningPeak).toBe(30);
    expect(a.buckets[1]?.runningMean).toBeCloseTo((5 * 30 + 25 + 25) / 7, 9);
    expect(a.latest).toBe(at(59));
  });

  it('FR-ENV-02: buckets have means and peaks; a bucket without data is null, never zero', () => {
    const [b0, , gap, b3] = analyse().buckets;
    expect(b0).toMatchObject({
      start: T0,
      workersMax: 3,
      targetMax: 3,
      runningPeak: 30,
      queuedPeak: 15,
      atMaxMinutes: 7,
      boundMinutes: 7,
    });
    expect(b0?.workersMean).toBeCloseTo((6 * 1 + 2 * 2 + 7 * 3) / 15, 9);
    expect(b0?.slotsMean).toBeCloseTo(((6 * 1 + 2 * 2 + 7 * 3) / 15) * 10, 9);
    expect(b0?.utilisationMean).toBeCloseTo((5 * 0.5 + 1 + 2 + 7) / 15, 9);
    expect(b0?.cpuMax).toBe(0.9);
    expect(gap).toEqual({
      start: at(30),
      observedMinutes: 0,
      workersMean: null,
      workersMax: null,
      targetMax: null,
      slotsMean: null,
      runningMean: null,
      runningPeak: null,
      queuedMean: null,
      queuedPeak: null,
      utilisationMean: null,
      atMaxMinutes: null,
      boundMinutes: null,
      cpuMax: null,
      memoryMax: null,
      // Task history covers the bucket (no history start given) and no try ran: a measured zero.
      runningTriesMean: 0,
    });
    // Snapshot minutes carry no CPU: the bucket's CPU comes from its samples only.
    expect(b3?.cpuMax).toBe(0.2);
  });

  it('FR-ENV-02: capacity-bound periods are stretches at max_count with queued ≥ max(10, 20 % of slots)', () => {
    const a = analyse();
    expect(a.boundMinutes).toBe(12);
    expect(a.minutesAtMax).toBe(14);
    expect(a.periods).toEqual([{ start: at(8), end: at(20), minutes: 12, queuedPeak: 12, workers: 3 }]);
    expect(a.threshold).toEqual({ minQueued: 10, queuedRatio: 0.2 });
    // 3 workers × 10 slots: 20 % is 6, so 10 queued is the bar; 9 queued at max is not bound.
    const nine = capacityAnalysis({
      config,
      samples: range(0, 5).map((m) => sample(m, { workers: 3, running: 30, queued: 9 })),
      snapshots: [],
      tries: [],
      from: T0,
      to: at(5),
      bucketMs: 5 * MIN,
    });
    expect(nine.boundMinutes).toBe(0);
    expect(nine.minutesAtMax).toBe(5);
    expect(nine.periods).toEqual([]);
  });

  it('HM-032: with worker_concurrency unknown, slots, utilisation and capacity-bound minutes are null', () => {
    const unknown: EnvironmentConfig = {
      ...config,
      workerConcurrency: UNKNOWN_LIMIT,
      limitSources: { workerConcurrency: 'unknown' },
    };
    const a = analyse({ config: unknown });
    expect(a.slotsKnown).toBe(false);
    expect(a.boundMinutes).toBeNull();
    expect(a.periods).toEqual([]);
    expect(a.utilisation.samples).toBe(0);
    expect(a.minutesAtMax).toBe(14);
    expect(a.buckets[0]).toMatchObject({ slotsMean: null, utilisationMean: null, boundMinutes: null });
    expect(a.buckets[0]?.atMaxMinutes).toBe(7);
    expect(a.heatmap[0]).toMatchObject({ utilisationMean: null, boundMinutes: null, atMaxMinutes: 14 });
  });

  it('HM-011: worker counts from hostnames make the range a hostname estimate (the weakest source)', () => {
    expect(analyse().slotsSource).toBe('hostnames');
    expect(analyse({ snapshots: [] }).slotsSource).toBe('monitoring');
    // Snapshots that do not say where their count came from (demo) leave it unknown.
    const { snapshots } = scenario();
    const unlabelled = snapshots.map((s) => snapshot(s.at, 3, 25, 0));
    expect(analyse({ samples: [], snapshots: unlabelled }).slotsSource).toBeNull();
    expect(analyse({ samples: [], snapshots: [snapshot(at(1), 2, 1, 0, 'config')] }).slotsSource).toBe(
      'config',
    );
  });

  it('HM-012: scale events and scale-up lags come from Cloud Monitoring samples only', () => {
    const a = analyse();
    expect(a.scaleEvents).toEqual({
      evaluated: true,
      up: 2,
      down: 1,
      items: [
        { at: at(6), from: 1, to: 2 },
        { at: at(8), from: 2, to: 3 },
        { at: at(45), from: 3, to: 2 },
      ],
    });
    expect(a.scaleUpLag).toMatchObject({ p50: 180, max: 180, samples: 1, lowSample: true, p95: null });
    const noSamples = analyse({ samples: [] });
    expect(noSamples.scaleEvents).toEqual({ evaluated: false, up: 0, down: 0, items: [] });
  });

  it('FR-ENV-02: the saturation heatmap has a cell per UTC day and hour in the range, null where unobserved', () => {
    const a = analyse();
    expect(a.heatmap).toHaveLength(1);
    const cell = a.heatmap[0];
    expect(cell).toMatchObject({ day: T0, hour: 0, observedMinutes: 37, boundMinutes: 12, atMaxMinutes: 14 });
    expect(cell?.utilisationMean).toBeCloseTo((5 * 0.5 + 1 + 2 + 12 + 2 * (25 / 30) + 15 * 0.2) / 37, 9);

    const twoDays = capacityAnalysis({
      config,
      samples: [sample(-50, { workers: 3, running: 30, queued: 20 })],
      snapshots: [],
      tries: [],
      from: at(-60),
      to: at(60),
      bucketMs: 60 * MIN,
    });
    expect(twoDays.heatmap).toEqual([
      {
        day: T0 - 86_400_000,
        hour: 23,
        observedMinutes: 1,
        utilisationMean: 1,
        atMaxMinutes: 1,
        boundMinutes: 1,
      },
      {
        day: T0,
        hour: 0,
        observedMinutes: 0,
        utilisationMean: null,
        atMaxMinutes: null,
        boundMinutes: null,
      },
    ]);
  });

  it('HM-011: running tries from task history cross-check the executor count; before history they are null', () => {
    const run = (start: number, end: number): TaskTry => ({
      dagId: 'acme_orders_daily',
      taskId: 'load',
      runId: 'scheduled__2026-11-05T00:00:00+00:00',
      mapIndex: -1,
      tryNumber: 1,
      pool: 'default_pool',
      poolSlots: 1,
      startAt: at(start),
      endAt: at(end),
    });
    const a = analyse({ tries: [run(2, 17)], historyFrom: at(2) });
    // Bucket 0 is covered from minute 2: 13 slot-minutes over 13 covered minutes.
    expect(a.buckets.map((b) => b.runningTriesMean)).toEqual([1, 2 / 15, 0, 0]);
    const late = analyse({ tries: [run(22, 26)], historyFrom: at(20) });
    expect(late.buckets.map((b) => b.runningTriesMean)).toEqual([null, 0.4, 0, 0]);
    expect(analyse({ tries: [], historyFrom: null }).buckets.every((b) => b.runningTriesMean === null)).toBe(
      true,
    );
  });

  it('§8.9: worker CPU and memory p95 need 20 samples; with fewer the p95 is null and the max stays', () => {
    const a = analyse();
    expect(a.worker.samples).toBe(35);
    expect(a.worker.cpu).toMatchObject({ max: 0.9, samples: 35, lowSample: false });
    expect(a.worker.cpu.p95).toBe(0.9);
    expect(a.worker.memory.p50).toBe(0.3);
    const few = analyse({ samples: scenario().samples.slice(0, 5), snapshots: [] });
    expect(few.worker.cpu).toEqual({ p50: 0.2, p95: null, max: 0.2, samples: 5, lowSample: true });
    expect(few.utilisation).toMatchObject({ p95: null, max: 0.5, lowSample: true });
  });
});
