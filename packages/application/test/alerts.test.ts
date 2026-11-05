import { describe, expect, it } from 'vitest';
import type { AlertRule } from '@dcam/contracts';
import type {
  EnvironmentConfig,
  LiveSnapshot,
  PlatformHealth,
  SnapshotTaskInstance,
  WorkerSample,
} from '@dcam/domain';
import type { EnvironmentModelSource, StoredTaskTry, TaskInstanceStore } from '@dcam/ports';
import { getAlerts, type AlertDeps } from '../src/index';

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();

const prod: EnvironmentConfig = {
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
const test: EnvironmentConfig = { ...prod, envId: 'acme-test', tier: 'test' };

/** 25 h of samples; workers at max with 12 queued from 40 to 20 minutes ago. */
const samples: WorkerSample[] = Array.from({ length: 25 * 60 + 1 }, (_, i) => {
  const at = NOW - 25 * HOUR + i * MIN;
  const busy = at >= NOW - 40 * MIN && at < NOW - 20 * MIN;
  return {
    at,
    workers: busy ? 2 : 1,
    target: busy ? 2 : 1,
    running: busy ? 8 : 2,
    queued: busy ? 12 : 0,
    cpu: 0.2,
    memory: 0.4,
  };
});
const waiting = (pool: string): SnapshotTaskInstance => ({
  dagId: 'partner_crm_sync',
  runId: 'r',
  taskId: 't',
  mapIndex: -1,
  tryNumber: 1,
  pool,
  poolSlots: 1,
  priorityWeight: 1,
  since: NOW - 45 * MIN,
});
/** 25 h of snapshots every 30 s; the one-slot external_api pool is starved for the last 45 minutes. */
const snapshots: LiveSnapshot[] = Array.from({ length: 25 * 120 + 1 }, (_, i) => {
  const at = NOW - 25 * HOUR + i * 30_000;
  const starved = at >= NOW - 45 * MIN;
  return {
    at,
    scheduled: starved ? [waiting('external_api')] : [],
    queued: [],
    pools: [
      { name: 'default_pool', slots: 128, running: 2, queued: 0, open: 126 },
      { name: 'external_api', slots: 1, running: starved ? 1 : 0, queued: 0, open: starved ? 0 : 1 },
    ],
    dagActive: {},
    executor: { running: 2, queued: 0 },
    workers: { current: 1, target: 1 },
  };
});
const tryAt = (startAt: number, waitMs: number, state = 'success'): StoredTaskTry => ({
  envId: 'acme-prod',
  dagId: 'orders_daily',
  runId: `r-${startAt}`,
  taskId: 't',
  mapIndex: -1,
  tryNumber: 1,
  pool: 'default_pool',
  poolSlots: 1,
  state,
  readyAt: startAt - waitMs,
  queuedAt: startAt - waitMs,
  startAt,
  endAt: startAt + MIN,
  sourceUpdatedAt: startAt + MIN,
  operator: 'PythonOperator',
});
/** 20 tries started in the last 10 minutes after 12 minutes in the queue. */
const slowStarts = Array.from({ length: 20 }, (_, i) => tryAt(NOW - 10 * MIN + i * 30_000, 12 * MIN));
const storeOf = (tries: readonly StoredTaskTry[]): TaskInstanceStore => ({
  upsertTaskTries: async () => {},
  taskTries: async (_env, from, to) =>
    tries.filter((t) => (t.endAt ?? Infinity) > from && (t.startAt ?? -Infinity) < to),
  countTaskTries: async () => tries.length,
});
const health: PlatformHealth = {
  envHealthyRatio: 0.85,
  dbHealthyRatio: 0.99,
  heartbeatCompleteness: 0.95,
  webServerHealthyRatio: null,
  dbCpuMemoryMax: 0.5,
  zombies24h: 0,
  workerRestarts24h: 3,
  importErrors: 2,
  parseLoopP95Seconds: 60,
};
const modelOf = (
  over: Partial<{ snapshots: LiveSnapshot[]; samples: WorkerSample[]; health: PlatformHealth }> = {},
): EnvironmentModelSource => ({
  config: async (id) => [prod, test].find((c) => c.envId === id) ?? null,
  dags: async () => [],
  snapshots: async (_id, from, to) => (over.snapshots ?? snapshots).filter((s) => s.at >= from && s.at < to),
  workerSamples: async (_id, from, to) => (over.samples ?? samples).filter((s) => s.at >= from && s.at < to),
  platformHealth: async () => over.health ?? health,
});
const deps = (over: Partial<AlertDeps> = {}): AlertDeps => ({
  store: storeOf(slowStarts),
  model: modelOf(),
  clock: { now: () => NOW },
  ...over,
});
const query = { envIds: ['acme-prod'], sources: ['DEMO' as const] };
const rule = (rules: readonly AlertRule[], id: string, env = 'acme-prod') => {
  const r = rules.find((x) => x.id === id && x.env_id === env);
  if (!r) throw new Error(`no ${id} for ${env}`);
  return r;
};
const PACK = Array.from({ length: 19 }, (_, i) => `AL-${String(i + 1).padStart(2, '0')}`);

describe('getAlerts use case (FR-ALRT-01/02/06)', () => {
  it('FR-ALRT-02: lists the 19 rules of the default pack once per environment, with runbooks and export flags', async () => {
    const a = await getAlerts(deps(), { ...query, envIds: ['acme-prod', 'acme-test'] });
    expect(a.rules.filter((r) => r.env_id === 'acme-prod').map((r) => r.id)).toEqual(PACK);
    expect(a.rules.filter((r) => r.env_id === 'acme-test').map((r) => r.id)).toEqual(PACK);
    expect(new Set(a.rules.map((r) => `${r.id}|${r.env_id}`)).size).toBe(a.rules.length);
    expect(rule(a.rules, 'AL-05')).toMatchObject({
      name: 'Tasks queued while workers are at maximum',
      runbook: 'rb-01',
      export_cloud_monitoring: 'partial',
    });
    expect(rule(a.rules, 'AL-06').export_cloud_monitoring).toBe('no');
    expect(rule(a.rules, 'AL-19')).toMatchObject({ runbook: 'rb-04', export_cloud_monitoring: 'yes' });
    expect(a.sources).toEqual(['DEMO']);
  });

  it('FR-ALRT-02: severity follows the tier (prod / non-prod)', async () => {
    const a = await getAlerts(deps(), { ...query, envIds: ['acme-prod', 'acme-test'] });
    expect(rule(a.rules, 'AL-01').severity).toBe('critical');
    expect(rule(a.rules, 'AL-01', 'acme-test').severity).toBe('warning');
    expect(rule(a.rules, 'AL-05').severity).toBe('warning');
    expect(rule(a.rules, 'AL-05', 'acme-test').severity).toBe('info');
    expect(rule(a.rules, 'AL-17').severity).toBe('info');
  });

  it('FR-ALRT-01 AL-05: fires after workers at max with ≥ 10 queued for 15 min and resolves after 10 min clear', async () => {
    const a = await getAlerts(deps(), query);
    expect(rule(a.rules, 'AL-05')).toMatchObject({
      state: 'resolved',
      since: iso(NOW - 10 * MIN),
      for_seconds: 900,
      threshold: 10,
      value: 0,
      fired_count_24h: 1,
    });
    const events = a.events.filter((e) => e.rule_id === 'AL-05');
    expect(events.map((e) => [e.kind, e.at, e.value])).toEqual([
      ['resolved', iso(NOW - 10 * MIN), 0],
      ['fired', iso(NOW - 25 * MIN), 12],
    ]);
    expect(events[0]).toMatchObject({ env_id: 'acme-prod', severity: 'warning' });
  });

  it('FR-ALRT-01 AL-15: fires when a pool has had no open slots with work waiting for 30 min', async () => {
    const a = await getAlerts(deps(), query);
    const r = rule(a.rules, 'AL-15');
    expect(r).toMatchObject({
      state: 'firing',
      since: iso(NOW - 15 * MIN),
      threshold: 30,
      value: 45,
      unit: 'min',
    });
    expect(r.summary).toContain('external_api');
  });

  it('FR-ALRT-01 AL-06 / HM-001: fires when the p95 queue wait over 15 min reaches 10 min', async () => {
    const a = await getAlerts(deps(), query);
    expect(rule(a.rules, 'AL-06')).toMatchObject({
      state: 'firing',
      since: iso(NOW - 10 * MIN),
      threshold: 600,
      value: 720,
      unit: 's',
    });
  });

  it('FR-ALRT-01: platform-health readings drive AL-01, AL-02, AL-04, AL-10, AL-18 and AL-19', async () => {
    const a = await getAlerts(deps(), query);
    expect(rule(a.rules, 'AL-01')).toMatchObject({ state: 'firing', value: 85, threshold: 90, unit: '%' });
    expect(rule(a.rules, 'AL-02')).toMatchObject({ state: 'inactive', value: 95 });
    expect(rule(a.rules, 'AL-04')).toMatchObject({
      state: 'firing',
      value: 2,
      threshold: 0,
      fired_count_24h: 1,
    });
    expect(rule(a.rules, 'AL-10')).toMatchObject({ state: 'inactive', value: 50, threshold: 80 });
    expect(rule(a.rules, 'AL-18')).toMatchObject({ state: 'inactive', value: 99, threshold: 95 });
    expect(rule(a.rules, 'AL-19')).toMatchObject({
      state: 'firing',
      value: 3,
      threshold: 1,
      since: iso(NOW),
    });
    expect(a.events.some((e) => e.rule_id === 'AL-19' && e.kind === 'fired' && e.at === iso(NOW))).toBe(true);
  });

  it('§16.2: a health reading that is not collected leaves its rule unknown', async () => {
    const a = await getAlerts(deps({ model: modelOf({ health: { ...health, importErrors: null } }) }), query);
    const r = rule(a.rules, 'AL-04');
    expect(r).toMatchObject({ state: 'unknown', value: null, since: null, fired_count_24h: 0 });
    expect(r.summary).toMatch(/not collected/);
  });

  it('FR-ALRT-02: rules whose source this version does not collect are listed as unknown, never guessed', async () => {
    const a = await getAlerts(deps(), query);
    for (const id of ['AL-03', 'AL-08', 'AL-11', 'AL-12', 'AL-13', 'AL-14', 'AL-16']) {
      const r = rule(a.rules, id);
      expect(r.state, id).toBe('unknown');
      expect(r.value, id).toBeNull();
      expect(r.summary, id).toMatch(/not (collected|configured) in this version/);
    }
    expect(rule(a.rules, 'AL-13')).toMatchObject({ for_seconds: 900, threshold: 90, unit: '%' });
  });

  it('§8.9: AL-09 stays unknown until the same-hour baseline covers 6 of the previous 7 days', async () => {
    const a = await getAlerts(deps(), query);
    const r = rule(a.rules, 'AL-09');
    expect(r.state).toBe('unknown');
    expect(r.summary).toMatch(/7 days/);
  });

  it('FR-ALRT-01 AL-09: fires when failures over 1 h reach 3 × the same-hour median of the previous 7 days', async () => {
    const history = Array.from({ length: 8 * 24 }, (_, h) => tryAt(NOW - 8 * DAY + h * HOUR, 5_000));
    const baseline = Array.from({ length: 7 }, (_, d) =>
      tryAt(NOW - (d + 1) * DAY - 30 * MIN, 5_000, 'failed'),
    );
    const spike = Array.from({ length: 5 }, (_, i) => tryAt(NOW - 31 * MIN + i * MIN, 5_000, 'failed'));
    const a = await getAlerts(deps({ store: storeOf([...history, ...baseline, ...spike]) }), query);
    expect(rule(a.rules, 'AL-09')).toMatchObject({ state: 'firing', value: 5, threshold: 3, for_seconds: 0 });
  });

  it('§16.2 AL-17: stale collection fires AL-17 and moves snapshot-based rules to unknown', async () => {
    const until = (cut: number) => snapshots.filter((s) => s.at <= cut);
    const a = await getAlerts(deps({ model: modelOf({ snapshots: until(NOW - 15 * MIN) }) }), query);
    expect(rule(a.rules, 'AL-17')).toMatchObject({ state: 'firing', since: iso(NOW - 5 * MIN), value: 15 });
    expect(rule(a.rules, 'AL-15').state).toBe('unknown');
    expect(rule(a.rules, 'AL-05').state).toBe('resolved');
  });

  it('FR-ALRT-06: events of the last 24 h, newest first, with unique ids; data as of the latest collection', async () => {
    const a = await getAlerts(deps(), query);
    const times = a.events.map((e) => Date.parse(e.at));
    expect(times).toEqual([...times].sort((x, y) => y - x));
    expect(times.every((t) => t >= NOW - DAY && t <= NOW)).toBe(true);
    expect(new Set(a.events.map((e) => e.id)).size).toBe(a.events.length);
    expect(a.data_as_of).toBe(iso(NOW));
  });

  it('lists every rule as unknown for an environment without collected configuration', async () => {
    const a = await getAlerts(deps(), { ...query, envIds: ['acme-nope'] });
    expect(a.rules).toHaveLength(19);
    expect(a.rules.every((r) => r.state === 'unknown')).toBe(true);
  });
});
