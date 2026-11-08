import { describe, expect, it } from 'vitest';
import {
  UNKNOWN_LIMIT,
  type DagMeta,
  type EnvironmentConfig,
  type LiveSnapshot,
  type WorkerSample,
} from '@dcam/domain';
import type { EnvironmentModelSource, StoredTaskTry, TaskInstanceStore } from '@dcam/ports';
import { getBottlenecks, getDagDetail } from '../src/index';

const S = 1_000;
const M = 60 * S;
const H = 60 * M;
const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();

const tryOf = (
  dagId: string,
  taskId: string,
  queuedAt: number,
  startAt: number,
  endAt: number | null,
  extra: Partial<StoredTaskTry> = {},
): StoredTaskTry => ({
  envId: 'acme-prod',
  dagId,
  runId: `scheduled__${iso(queuedAt - (queuedAt % H)).replace('.000Z', '+00:00')}`,
  taskId,
  mapIndex: -1,
  tryNumber: 1,
  pool: 'default_pool',
  poolSlots: 1,
  state: endAt === null ? 'running' : 'success',
  readyAt: null,
  queuedAt,
  startAt,
  endAt,
  operator: 'PythonOperator',
  sourceUpdatedAt: endAt ?? startAt,
  ...extra,
});

const meta = (dagId: string, maxActiveTasks = 16): DagMeta => ({
  dagId,
  fileloc: `/home/airflow/gcs/dags/${dagId}.py`,
  owners: ['acme-oncall'],
  tags: [],
  team: 'acme',
  schedule: '0 * * * *',
  maxActiveTasks,
  maxActiveRuns: 2,
  catchup: false,
  paused: false,
});

const CONFIG: EnvironmentConfig = {
  envId: 'acme-prod',
  tier: 'prod',
  composerImage: 'composer-3-airflow-2.11.1-build.22',
  airflowVersion: '2.11.1',
  parallelism: 96,
  schedulers: 2,
  maxActiveTasksPerDag: 16,
  maxActiveRunsPerDag: 25,
  workerConcurrency: 10,
  minWorkers: 1,
  maxWorkers: 3,
  pools: [{ name: 'default_pool', slots: 128 }],
};

function deps(
  rows: StoredTaskTry[],
  opts: { snapshots?: LiveSnapshot[]; samples?: WorkerSample[]; config?: EnvironmentConfig } = {},
) {
  const store: TaskInstanceStore = {
    upsertTaskTries: async () => {},
    countTaskTries: async () => rows.length,
    taskTries: async (_env, from, to) =>
      rows.filter((t) => t.startAt !== null && t.startAt < to && (t.endAt === null || t.endAt > from)),
  };
  const model: EnvironmentModelSource = {
    config: async () => opts.config ?? CONFIG,
    dags: async () => [meta('acme_fanout', 2), meta('hog'), ...['s1', 's2', 's3', 's4'].map((d) => meta(d))],
    snapshots: async (_env, from, to) => (opts.snapshots ?? []).filter((s) => s.at >= from && s.at < to),
    workerSamples: async (_env, from, to) => (opts.samples ?? []).filter((s) => s.at >= from && s.at < to),
    platformHealth: async () => {
      throw new Error('not used');
    },
  };
  return { store, model, clock: { now: () => NOW } };
}

/**
 * HM-017's golden story in the last three hours: `hog` holds 10 % of 10 slots in minutes 0–29 and 60–99, while
 * four small DAGs queue a try every minute (longer waits while hog runs). One worker of 10 slots throughout.
 */
function neighbourRows(): StoredTaskTry[] {
  const t0 = NOW - 3 * H;
  const rows = [
    tryOf('hog', 'big_1', t0, t0, t0 + 30 * M),
    tryOf('hog', 'big_2', t0 + 60 * M, t0 + 60 * M, t0 + 100 * M),
  ];
  for (let m = 0; m < 180; m++) {
    const hour = Math.floor(m / 60);
    const active = m < 30 || (m >= 60 && m < 100);
    const wait = hour === 2 ? 600 : hour === 0 ? (active ? 120 : 60) : active ? 300 : 120;
    for (const dag of ['s1', 's2', 's3', 's4']) {
      const queued = t0 + m * M;
      rows.push(tryOf(dag, `t${m}`, queued, queued + wait * S, queued + wait * S + S));
    }
  }
  return rows;
}
const samples: WorkerSample[] = Array.from({ length: 6 * 60 }, (_, k) => ({
  at: NOW - 6 * H + k * M,
  workers: 1,
  target: 1,
  running: 0,
  queued: 0,
  cpu: 0.2,
  memory: 0.3,
}));

/** acme_fanout at its max_active_tasks of 2 with one task ready for 10 of 20 minutes of snapshots. */
const fanoutSnapshots: LiveSnapshot[] = Array.from({ length: 20 }, (_, i) => ({
  at: NOW - 30 * M + i * M,
  scheduled:
    i < 10
      ? [
          {
            dagId: 'acme_fanout',
            runId: 'r1',
            taskId: 'fan',
            mapIndex: i,
            tryNumber: 1,
            pool: 'default_pool',
            poolSlots: 1,
            priorityWeight: 1,
            since: NOW - 30 * M,
          },
        ]
      : [],
  queued: [],
  pools: [{ name: 'default_pool', slots: 128, running: 5, queued: 0, open: 123 }],
  dagActive: { acme_fanout: 2 },
  executor: { running: 5, queued: 0 },
  workers: { current: 1, target: 1 },
}));
const fanoutRows = [
  tryOf('acme_fanout', 'fan', NOW - 30 * M, NOW - 30 * M, NOW - 10 * M, { mapIndex: 0 }),
  tryOf('acme_fanout', 'fan', NOW - 30 * M, NOW - 30 * M, NOW - 10 * M, { mapIndex: 1 }),
];
const query = (dagId: string, range: '1h' | '6h' | '24h' = '24h') => ({
  envId: 'acme-prod',
  dagId,
  range,
  sources: ['DEMO' as const],
});

describe('FR-DAGD-05 concurrency in DAG detail', () => {
  it('FR-DAGD-05: per-bucket running, in flight and ready against max_active_tasks, with its pools', async () => {
    const r = await getDagDetail(deps(fanoutRows, { snapshots: fanoutSnapshots }), query('acme_fanout'));
    if (r.kind !== 'ok') throw new Error(r.kind);
    const c = r.detail.concurrency;
    expect(c).toMatchObject({
      bucket_seconds: 900,
      max_active_tasks: 2,
      max_active_tasks_is_default: false,
      limit_scope: 'dag',
      snapshots: 20,
      snapshot_interval_seconds: 60,
      peak_running: 2,
      peak_in_flight: 2,
    });
    expect(c?.series).toHaveLength(96);
    // Before the environment's first try and without snapshots: gaps, not zero. The last two buckets hold the
    // snapshots.
    expect(c?.series[0]).toMatchObject({ start: iso(NOW - 24 * H), running_avg: null, in_flight_max: null });
    // Two tries run 5 of the last bucket's 15 minutes.
    expect(c?.series.at(-1)).toMatchObject({
      running_max: 2,
      in_flight_max: 2,
      ready_max: 0,
      at_limit_seconds: 0,
    });
    expect(c?.series.at(-1)?.running_avg).toBeCloseTo(2 / 3, 12);
    expect(c?.series.at(-2)).toMatchObject({ in_flight_max: 2, ready_max: 1, at_limit_seconds: 600 });
    expect(c?.pools).toEqual([expect.objectContaining({ name: 'default_pool', slots: 128, pool_slots: 1 })]);
    expect(c?.pools[0]?.dag_slots_max).toHaveLength(96);
  });

  it("FR-DAGD-05 / REC-DAG-01: the advisor's HM-005 share, the rule's condition, and the open finding", async () => {
    const finding = {
      id: 'acme-prod:REC-DAG-01:dag:acme_fanout',
      rule_id: 'REC-DAG-01',
      title: 'DAG throttled by max_active_tasks',
      severity: 'warning' as const,
    };
    const r = await getDagDetail(deps(fanoutRows, { snapshots: fanoutSnapshots }), {
      ...query('acme_fanout'),
      findings: [finding],
    });
    if (r.kind !== 'ok') throw new Error(r.kind);
    expect(r.detail.concurrency?.self_throttling).toEqual({
      method: 'HM-005/snapshots',
      active_seconds: 20 * 60,
      at_limit_seconds: 10 * 60,
      at_limit_share: 0.5,
      own_waiting_task_seconds: 10 * 60,
      peak_demand: 3,
      // Five of ten worker slots were busy at the limit: free slots in every at-limit snapshot.
      headroom_share: 1,
      last_at_limit: iso(NOW - 21 * M),
      threshold: 0.1,
      raises_rec_dag_01: true,
      finding_id: finding.id,
    });
    // One HM-005 number on the page.
    expect(r.detail.stats.self_throttled_ratio).toBe(0.5);
  });

  it('REC-DAG-01: not raised below 10 % of the active time, and no finding to link', async () => {
    const mostlyFree = fanoutSnapshots.map((s, i) => (i === 0 ? s : { ...s, scheduled: [] }));
    const r = await getDagDetail(deps(fanoutRows, { snapshots: mostlyFree }), query('acme_fanout'));
    if (r.kind !== 'ok') throw new Error(r.kind);
    expect(r.detail.concurrency?.self_throttling).toMatchObject({
      at_limit_share: 0.05,
      raises_rec_dag_01: false,
      finding_id: null,
    });
  });
});

describe('FR-DAGD-06 impact in DAG detail', () => {
  it("FR-DAGD-06 / HM-017: the noisy-neighbour score is the bottlenecks page's item for the DAG", async () => {
    const d = deps(neighbourRows(), { samples });
    const r = await getDagDetail(d, query('hog', '6h'));
    if (r.kind !== 'ok') throw new Error(r.kind);
    const page = await getBottlenecks(d, { envId: 'acme-prod', range: '6h', sources: ['DEMO'] });
    const item = page.noisy_neighbours?.items.find((x) => x.dag_id === 'hog');
    expect(item).toBeDefined();
    const nn = r.detail.impact?.noisy_neighbour;
    expect(nn).toMatchObject({ method: 'HM-017/range', status: 'associated', active_minutes: 70 });
    expect(nn?.score).toEqual(item);
    expect(nn?.reason).toContain('associated with');
  });

  it('FR-DAGD-06: share of the environment load and of the executor slots per bucket', async () => {
    const r = await getDagDetail(deps(neighbourRows(), { samples }), query('hog', '6h'));
    if (r.kind !== 'ok') throw new Error(r.kind);
    const impact = r.detail.impact;
    expect(impact?.bucket_seconds).toBe(300);
    expect(impact?.series).toHaveLength(72);
    expect(impact?.slots_source).toBe('monitoring');
    // The first five minutes of the story: hog's 300 s of one slot against 10 slots × 300 s.
    const first = impact?.series.find((b) => b.start === iso(NOW - 3 * H));
    expect(first?.dag_slot_seconds).toBe(300);
    expect(first?.capacity_share).toBeCloseTo(0.1, 9);
    expect(first?.share).toBeGreaterThan(0.5);
    // Before the environment's first try: no history, so a gap.
    expect(impact?.series[0]).toMatchObject({ share: null, dag_slot_seconds: null });
  });

  it('FR-DAGD-06 / HM-032: without worker_concurrency the score is not evaluated and says why', async () => {
    const unknown = {
      ...CONFIG,
      workerConcurrency: UNKNOWN_LIMIT,
      limitSources: { workerConcurrency: 'unknown' },
    };
    const r = await getDagDetail(
      deps(neighbourRows(), { samples, config: unknown as EnvironmentConfig }),
      query('hog', '6h'),
    );
    if (r.kind !== 'ok') throw new Error(r.kind);
    expect(r.detail.impact?.noisy_neighbour).toMatchObject({ status: 'not_evaluated', score: null });
    expect(r.detail.impact?.noisy_neighbour.reason).toContain('worker_concurrency');
    expect(r.detail.impact?.series.every((b) => b.capacity_share === null)).toBe(true);
  });

  it('FR-DAGD-06: a small DAG is inactive, with a reason and no score', async () => {
    const r = await getDagDetail(deps(neighbourRows(), { samples }), query('s1', '6h'));
    if (r.kind !== 'ok') throw new Error(r.kind);
    expect(r.detail.impact?.noisy_neighbour).toMatchObject({ status: 'inactive', score: null });
  });
});
