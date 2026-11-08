/**
 * NFR-PERF-01: the bottleneck analysis read in slices equals the analysis read in one go, for every part of
 * it: waiting by reason and over time, top DAGs and pools per reason (HM-006), pool activity (FR-ENV-08),
 * HM-017 noisy neighbours, HM-023 priority bands, sensors and capacity, with raw and thinned (FR-STORE-07)
 * snapshots. The store answers as the ports say (rows by start time, like DuckDB's insertion order).
 */
import { describe, expect, it } from 'vitest';
import type { EnvironmentConfig, LiveSnapshot, SnapshotTaskInstance, WorkerSample } from '@dcam/domain';
import type { EnvironmentModelSource, StoredTaskTry, TaskInstanceStore } from '@dcam/ports';
import { bottlenecksInWindow } from '../src/index';

const SEC = 1_000;
const MIN = 60 * SEC;
const H = 60 * MIN;
const DAY = 24 * H;
/** A Monday 00:00 UTC. */
const NOW = Date.UTC(2026, 10, 9, 0, 0, 0);
const FROM = NOW - 3 * DAY;

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
  maxWorkers: 2,
  pools: [
    { name: 'default_pool', slots: 128 },
    { name: 'external_api', slots: 1 },
  ],
};

const tryOf = (
  dagId: string,
  runId: string,
  queuedAt: number,
  waitMs: number,
  runMs: number,
  operator = 'PythonOperator',
): StoredTaskTry => ({
  envId: 'acme-prod',
  dagId,
  runId,
  taskId: 't',
  mapIndex: -1,
  tryNumber: 1,
  pool: 'default_pool',
  poolSlots: 1,
  state: 'success',
  readyAt: null,
  queuedAt,
  startAt: queuedAt + waitMs,
  endAt: queuedAt + waitMs + runMs,
  sourceUpdatedAt: null,
  operator,
});

/** `acme_hog` runs for half of every hour; two small DAGs queue a try a minute and wait longer while it runs. */
const tries: StoredTaskTry[] = [
  tryOf('acme_sensor', 'early', FROM - 2 * H, 0, 3 * H, 'ExternalTaskSensor'), // started before the range
  ...Array.from({ length: 72 }, (_, h) => tryOf('acme_hog', `h${h}`, FROM + h * H, 0, 30 * MIN)),
  ...Array.from({ length: 72 * 60 - 1 }, (_, m) =>
    ['acme_small_a', 'acme_small_b'].map((dag) =>
      tryOf(dag, `m${m}`, FROM + m * MIN, ((m % 60 < 30 ? 240 : 60) + (m % 7)) * SEC, SEC),
    ),
  ).flat(),
].sort((a, b) => (a.startAt ?? 0) - (b.startAt ?? 0));

const ti = (
  dagId: string,
  pool: string,
  weight: number,
  since: number,
  taskId = 't',
): SnapshotTaskInstance => ({
  dagId,
  runId: 'r',
  taskId,
  mapIndex: -1,
  tryNumber: 1,
  pool,
  poolSlots: 1,
  priorityWeight: weight,
  since,
});

/** A snapshot every 2 min; on the first day the disk budget kept one per 5 minutes, with its span. */
function snapshotsOf(seed: number): LiveSnapshot[] {
  const out: LiveSnapshot[] = [];
  for (let at = FROM; at < NOW; at += 2 * MIN) {
    const thinned = at < FROM + DAY;
    if (thinned && (at - FROM) % (10 * MIN) !== 0) continue;
    const k = Math.floor((at - FROM) / MIN) + seed;
    out.push({
      at,
      ...(thinned ? { spanMs: 5 * MIN } : {}),
      scheduled: [
        ti('partner_crm_sync', 'external_api', 1 + (k % 3), at - (k % 5) * MIN, `fetch_${k % 4}`),
        ti('partner_tax_sync', 'external_api', 5, at - 3 * MIN),
      ],
      queued: k % 3 === 0 ? [ti('orders_daily', 'default_pool', 1, at - 2 * MIN)] : [],
      pools: [
        { name: 'default_pool', slots: 128, running: 9 + (k % 4), queued: k % 3 === 0 ? 1 : 0, open: 115 },
        { name: 'external_api', slots: 1, running: 1, queued: 0, open: k % 11 === 0 ? 1 : 0 },
      ],
      dagActive: { partner_crm_sync: 1 },
      executor: { running: 10 + (k % 10), queued: k % 3 === 0 ? 1 : 0 },
      workers: { current: 1 + (k % 2), target: 2 },
    });
  }
  return out;
}

const samples: WorkerSample[] = Array.from({ length: 72 * 60 }, (_, i) => ({
  at: FROM + i * MIN,
  workers: i % 90 < 45 ? 1 : 2,
  target: 2,
  running: 10,
  queued: 1,
  cpu: 0.3,
  memory: 0.4,
}));

function depsOf(snapshots: readonly LiveSnapshot[]) {
  const store: TaskInstanceStore = {
    upsertTaskTries: async () => {},
    taskTries: async (_env, from, to) =>
      tries.filter((t) => t.startAt !== null && t.startAt < to && (t.endAt === null || t.endAt > from)),
    countTaskTries: async () => tries.length,
  };
  const model: EnvironmentModelSource = {
    config: async () => config,
    dags: async () => [],
    snapshots: async (_env, from, to) => snapshots.filter((s) => s.at >= from && s.at < to),
    workerSamples: async (_env, from, to) => samples.filter((s) => s.at >= from && s.at < to),
    platformHealth: async () => {
      throw new Error('not used');
    },
  };
  return { store, model };
}

/** Floating-point sums add up in another order when sliced. */
const rounded = (x: unknown) =>
  JSON.parse(
    JSON.stringify(x, (_k, v: unknown) =>
      typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1e6) / 1e6 : v,
    ),
  ) as unknown;

const query = { envId: 'acme-prod', from: FROM, to: NOW, bucketMs: H, sources: ['DEMO' as const] };

describe('NFR-PERF-01 bottlenecks from slices equal bottlenecks from one read', { timeout: 120_000 }, () => {
  it('NFR-PERF-01 / HM-017 / HM-023 / FR-ENV-08: day slices give the same analysis as reading 3 days at once', async () => {
    const deps = depsOf(snapshotsOf(0));
    const whole = await bottlenecksInWindow(deps, query, { sliceMs: 4 * DAY });
    const days = await bottlenecksInWindow(deps, query, { sliceMs: DAY });
    expect(rounded(days)).toEqual(rounded(whole));
    // The comparison is not vacuous: every part has something in it.
    expect(whole.noisy_neighbours?.items[0]?.dag_id).toBe('acme_hog');
    expect(
      whole.priority_fairness?.pools.find((p) => p.pool === 'external_api')?.bands.length,
    ).toBeGreaterThan(1);
    expect(whole.pools.find((p) => p.name === 'external_api')?.starved_minutes).toBeGreaterThan(0);
    expect(whole.reasons.find((r) => r.id === 'pool-exhausted')?.top_pools?.[0]?.pool).toBe('external_api');
    expect(whole.sensors[0]?.dag_id).toBe('acme_sensor');
  });

  it.each([37 * MIN, 7 * H, 13 * H + 1, DAY + MIN, 2 * DAY])(
    'NFR-PERF-01: slices of %i ms give the same analysis',
    async (sliceMs) => {
      const deps = depsOf(snapshotsOf(3));
      const whole = await bottlenecksInWindow(deps, query, { sliceMs: 4 * DAY });
      expect(rounded(await bottlenecksInWindow(deps, query, { sliceMs }))).toEqual(rounded(whole));
    },
  );
});
