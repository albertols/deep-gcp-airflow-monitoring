import { describe, expect, it } from 'vitest';
import type { Finding } from '@dcam/contracts';
import type { EnvironmentConfig, LiveSnapshot, SnapshotTaskInstance, WorkerSample } from '@dcam/domain';
import type { EnvironmentModelSource, StoredTaskTry, TaskInstanceStore } from '@dcam/ports';
import { countFindingsByDag, getFindingCountsByDag, getFindings } from '../src/index';

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const DAY = 24 * 3_600_000;
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
    { name: 'default_pool', slots: 128 },
    { name: 'external_api', slots: 1 },
  ],
};
const ti = (dagId: string): SnapshotTaskInstance => ({
  dagId,
  runId: 'r',
  taskId: 't',
  mapIndex: -1,
  tryNumber: 1,
  pool: 'external_api',
  poolSlots: 1,
  priorityWeight: 1,
  since: NOW - DAY,
});
// 24 h of snapshots every 30 s: two DAGs always wait for the starved one-slot external_api pool.
const snapshots: LiveSnapshot[] = Array.from({ length: 2880 }, (_, i) => ({
  at: NOW - DAY + i * 30_000,
  scheduled: [ti('partner_crm_sync'), ti('partner_tax_sync')],
  queued: [],
  pools: [
    { name: 'default_pool', slots: 128, running: 1, queued: 0, open: 127 },
    { name: 'external_api', slots: 1, running: 1, queued: 0, open: 0 },
  ],
  dagActive: { partner_crm_sync: 1 },
  executor: { running: 2, queued: 0 },
  workers: { current: 1, target: 1 },
}));
const samples: WorkerSample[] = Array.from({ length: 1440 }, (_, i) => ({
  at: NOW - DAY + i * 60_000,
  workers: 1,
  target: 1,
  running: 2,
  queued: 0,
  cpu: 0.2,
  memory: 0.3,
}));
const sensor: StoredTaskTry = {
  envId: 'acme-prod',
  dagId: 'partner_feed_wait',
  runId: 'r',
  taskId: 'wait_for_feed',
  mapIndex: -1,
  tryNumber: 1,
  pool: 'default_pool',
  poolSlots: 1,
  state: 'success',
  readyAt: NOW - 3 * 3_600_000,
  queuedAt: NOW - 3 * 3_600_000,
  startAt: NOW - 3 * 3_600_000,
  endAt: NOW - 3_600_000,
  sourceUpdatedAt: NOW - 3_600_000,
  operator: 'ExternalTaskSensor',
};
const store: TaskInstanceStore = {
  upsertTaskTries: async () => {},
  taskTries: async () => [sensor],
  countTaskTries: async () => 1,
};
const model: EnvironmentModelSource = {
  config: async (id) => (id === 'acme-prod' ? config : null),
  dags: async () => [],
  snapshots: async (_id, from, to) => snapshots.filter((s) => s.at >= from && s.at < to),
  workerSamples: async (_id, from, to) => samples.filter((s) => s.at >= from && s.at < to),
  platformHealth: async () => ({
    envHealthyRatio: null,
    dbHealthyRatio: null,
    heartbeatCompleteness: null,
    webServerHealthyRatio: null,
    dbCpuMemoryMax: null,
    zombies24h: null,
    workerRestarts24h: null,
    importErrors: null,
    parseLoopP95Seconds: null,
  }),
};
const deps = { store, model, clock: { now: () => NOW } };

describe('getFindings use case (FR-ADV-01..04)', () => {
  it('FR-ADV-01: evaluates the rules over the last 24 h, one finding per rule and scope', async () => {
    const f = await getFindings(deps, { envId: 'acme-prod', sources: ['DEMO'] });
    expect(f.env_id).toBe('acme-prod');
    expect(f.data_as_of).toBe(new Date(NOW - 30_000).toISOString());
    expect(f.findings.map((x) => `${x.rule_id} ${x.scope.kind}:${x.scope.id}`)).toEqual(
      expect.arrayContaining([
        'REC-CONC-02 pool:external_api',
        'REC-DAG-05 task:partner_feed_wait/wait_for_feed',
      ]),
    );
    const pool = f.findings.find((x) => x.rule_id === 'REC-CONC-02') as Finding;
    expect(pool).toMatchObject({
      id: 'acme-prod:REC-CONC-02:pool:external_api',
      category: 'concurrency',
      status: 'open',
      severity: 'warning',
      affected_dags: ['partner_crm_sync', 'partner_tax_sync'],
      links: { wiki: 'pools' },
      detected_at: new Date(NOW - 30_000).toISOString(),
    });
    expect(pool.impact_text.length).toBeGreaterThan(0);
  });

  it('FR-UI-08: evidence is labelled as demo data in demo mode and keeps its source otherwise', async () => {
    const demo = await getFindings(deps, { envId: 'acme-prod', sources: ['DEMO'] });
    expect(demo.findings.flatMap((x) => x.evidence.map((e) => e.source))).toEqual(
      expect.arrayContaining(['DEMO']),
    );
    expect(new Set(demo.findings.flatMap((x) => x.evidence.map((e) => e.source)))).toEqual(new Set(['DEMO']));
    const live = await getFindings(deps, { envId: 'acme-prod', sources: ['SRC-AF-API', 'SRC-MON'] });
    expect(live.findings.flatMap((x) => x.evidence.map((e) => e.source))).toContain('SRC-AF-API');
  });

  it('FR-ADV-04: findings come back ranked by priority score', async () => {
    const f = await getFindings(deps, { envId: 'acme-prod', sources: ['DEMO'] });
    const scores = f.findings.map((x) => x.priority_score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('records no finding, not an error, when nothing was collected', async () => {
    const empty = { ...deps, model: { ...model, snapshots: async () => [], workerSamples: async () => [] } };
    const f = await getFindings(empty, { envId: 'acme-prod', sources: ['DEMO'] });
    expect(f.findings.filter((x) => x.rule_id !== 'REC-DAG-05')).toEqual([]);
    expect(f.data_as_of).toBe(new Date(NOW).toISOString());
  });

  it('rejects an environment without collected configuration', async () => {
    await expect(getFindings(deps, { envId: 'acme-nope', sources: ['DEMO'] })).rejects.toThrow(/acme-nope/);
  });
});

describe('findings per DAG (league table, FR-DAGX-02 "open findings")', () => {
  it('FR-DAGX-02: counts the findings that name each DAG', async () => {
    const f = await getFindings(deps, { envId: 'acme-prod', sources: ['DEMO'] });
    const counts = countFindingsByDag(f.findings);
    expect(counts.get('partner_crm_sync')).toBe(1);
    expect(counts.get('partner_feed_wait')).toBe(1);
    expect(counts.has('orders_daily')).toBe(false);
    const viaUseCase = await getFindingCountsByDag(deps, { envId: 'acme-prod', sources: ['DEMO'] });
    expect([...viaUseCase]).toEqual([...counts]);
  });
});
