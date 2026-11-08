import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';
import type { FastifyInstance } from 'fastify';
import type { DagDetail, DagLeague, Findings } from '@dcam/contracts';
import { buildApp, createDemoWorkspace } from '../src/index';

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const spec = parse(
  readFileSync(fileURLToPath(import.meta.resolve('@dcam/contracts/openapi.yaml')), 'utf8'),
) as Record<string, unknown>;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats.default(ajv);
ajv.addSchema({ ...spec, $id: 'dcam' });
const conforms = (schema: string, body: unknown) => {
  const validate = ajv.getSchema(`dcam#/components/schemas/${schema}`);
  if (!validate) throw new Error(`no schema ${schema}`);
  return validate(body) ? true : validate.errors?.slice(0, 5);
};

let app: FastifyInstance;
beforeAll(async () => {
  const workspace = await createDemoWorkspace({ now: () => NOW });
  app = await buildApp({ ...workspace, version: '0.0.0-test', allowedHosts: ['127.0.0.1:8787'] });
}, 120_000);
afterAll(async () => {
  await app.close();
});

const get = (url: string) => app.inject({ method: 'GET', url, headers: { host: '127.0.0.1:8787' } });
const ENV = '/api/v1/environments';

describe('FR-DAGX-01..03 GET /api/v1/environments/{env_id}/dags', () => {
  it.each(['15m', '1h', '6h', '24h', '7d', '30d', '90d'])(
    'FR-DAGX-02 / FR-UI-01: the %s league conforms to DagLeague',
    async (range) => {
      const res = await get(`${ENV}/acme-prod/dags?range=${range}`);
      expect(res.statusCode).toBe(200);
      expect(conforms('DagLeague', res.json())).toBe(true);
    },
  );

  it('FR-UI-01 / §8.1: a range longer than the demo history says how much of it has data', async () => {
    const league = (await get(`${ENV}/acme-prod/dags?range=7d`)).json<DagLeague>();
    // The demo simulates 48 h (runs in flight at its start began a little earlier): about 2 of the 7 days,
    // and nothing of the previous 7 days.
    expect(league.coverage).toBeGreaterThan(0.28);
    expect(league.coverage).toBeLessThan(0.3);
    expect(league.previous_coverage).toBe(0);
  });

  it('FR-DAGX-02 / FR-DAGX-03: every known DAG, ranked by share, with Pareto and Gini', async () => {
    const league = (await get(`${ENV}/acme-prod/dags`)).json<DagLeague>();
    expect(league.sources).toEqual(['DEMO']);
    expect(league.dag_count).toBe(league.rows.length);
    expect(league.active_dag_count).toBeGreaterThan(0);
    expect(league.active_dag_count).toBeLessThan(league.dag_count); // paused demo DAGs never run
    const shares = league.rows.map((r) => r.share);
    expect(shares).toEqual([...shares].sort((a, b) => b - a));
    expect(league.pareto_80_dag_count).toBeGreaterThan(0);
    expect(league.pareto_80_dag_count).toBeLessThan(league.active_dag_count);
    expect(league.gini).toBeGreaterThan(0.3);
    const sum = league.rows.reduce((s, r) => s + r.executor_slot_seconds, 0);
    expect(sum).toBeCloseTo(league.total_executor_slot_seconds, 3);
  });

  it('HM-015: the demo story of a flaky DAG shows in its flaky rate', async () => {
    const league = (await get(`${ENV}/acme-prod/dags`)).json<DagLeague>();
    const flaky = league.rows.find((r) => r.dag_id === 'fraud_scoring_hourly');
    expect(flaky?.flaky_rate).toBeGreaterThan(0.05);
    expect(flaky?.retries).toBeGreaterThan(0);
  });

  it('FR-DAGX-02: open findings per DAG count the advisor findings that name the DAG', async () => {
    const league = (await get(`${ENV}/acme-prod/dags`)).json<DagLeague>();
    const { findings } = (await get(`${ENV}/acme-prod/findings`)).json<Findings>();
    const named = (dagId: string) => findings.filter((f) => f.affected_dags.includes(dagId)).length;
    for (const row of league.rows) expect(row.open_findings, row.dag_id).toBe(named(row.dag_id));
    expect(league.rows.find((r) => r.dag_id === 'customer_360_rebuild')?.open_findings).toBeGreaterThan(0);
  });

  it('returns RFC 9457 problems for an unknown environment and a bad range', async () => {
    const missing = await get(`${ENV}/nope/dags`);
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['content-type']).toContain('application/problem+json');
    expect(conforms('Problem', missing.json())).toBe(true);
    const bad = await get(`${ENV}/acme-prod/dags?range=2d`);
    expect(bad.statusCode).toBe(400);
    expect(conforms('Problem', bad.json())).toBe(true);
    expect(bad.json<{ fix_hint: string }>().fix_hint).toBe('Use one of 15m, 1h, 6h, 24h, 7d, 30d or 90d.');
  });
});

describe('FR-DAGD-01..04 GET /api/v1/environments/{env_id}/dags/{dag_id}', () => {
  it.each(['15m', '7d', '90d'])(
    'FR-DAGD-01 / FR-UI-01: the %s detail conforms to DagDetail',
    async (range) => {
      const res = await get(`${ENV}/acme-prod/dags/customer_360_rebuild?range=${range}`);
      expect(res.statusCode).toBe(200);
      expect(conforms('DagDetail', res.json())).toBe(true);
    },
  );

  it('FR-DAGD-01: conforms to DagDetail with every limit that can throttle the DAG', async () => {
    const res = await get(`${ENV}/acme-prod/dags/customer_360_rebuild?range=24h`);
    expect(res.statusCode).toBe(200);
    const detail = res.json<DagDetail>();
    expect(conforms('DagDetail', detail)).toBe(true);
    expect(detail.meta.limits).toMatchObject({
      max_active_tasks: 4,
      parallelism: 192,
      worker_slots: 72,
      pools: [{ name: 'default_pool', slots: 128, pool_slots: 1 }],
    });
  });

  it('HM-005: the fan-out DAG capped by max_active_tasks is self-throttled', async () => {
    const detail = (await get(`${ENV}/acme-prod/dags/customer_360_rebuild`)).json<DagDetail>();
    expect(detail.stats.self_throttled_ratio).toBeGreaterThan(0.1);
    expect(detail.runs.length).toBeGreaterThan(20);
    expect(detail.tasks[0]?.contribution_seconds).toBeGreaterThanOrEqual(
      detail.tasks.at(-1)?.contribution_seconds ?? 0,
    );
  });

  it('FR-DAGD-03: the Gantt shows the latest run, or the one asked for', async () => {
    const latest = (await get(`${ENV}/acme-prod/dags/orders_daily`)).json<DagDetail>();
    expect(latest.gantt.run_id).toBe(latest.runs.at(-1)?.run_id ?? null);
    const first = latest.runs[0];
    if (!first) return;
    const res = await get(`${ENV}/acme-prod/dags/orders_daily?run_id=${encodeURIComponent(first.run_id)}`);
    expect(res.statusCode).toBe(200);
    const detail = res.json<DagDetail>();
    expect(conforms('DagDetail', detail)).toBe(true);
    expect(detail.gantt.run_id).toBe(first.run_id);
    expect(detail.gantt.rows.length).toBeGreaterThan(0);
  });

  it('returns 404 problems for an unknown environment, DAG or run, and 400 for a bad range', async () => {
    for (const url of [
      `${ENV}/nope/dags/orders_daily`,
      `${ENV}/acme-prod/dags/no_such_dag`,
      `${ENV}/acme-prod/dags/orders_daily?run_id=no_such_run`,
    ]) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(404);
      expect(conforms('Problem', res.json())).toBe(true);
    }
    const bad = await get(`${ENV}/acme-prod/dags/orders_daily?range=2h`);
    expect(bad.statusCode).toBe(400);
    expect(conforms('Problem', bad.json())).toBe(true);
  });
});

describe('HM-016 / HM-015 / HM-007 demo stories in DAG detail', () => {
  it.each(['1h', '6h', '24h'])(
    'FR-TASK-01: the %s detail with baseline, reliability and critical path conforms',
    async (range) => {
      const res = await get(`${ENV}/acme-prod/dags/search_ranking_refresh?range=${range}`);
      expect(res.statusCode).toBe(200);
      expect(conforms('DagDetail', res.json())).toBe(true);
    },
  );

  it('HM-016: the task of search_ranking_refresh that got slower 20 h ago is a regression over 24 h', async () => {
    const detail = (await get(`${ENV}/acme-prod/dags/search_ranking_refresh?range=24h`)).json<DagDetail>();
    // The demo holds 48 h: the baseline covers the day before the range, not 28 days, and says so.
    expect(detail.baseline?.coverage).toBeGreaterThan(0);
    expect(detail.baseline?.coverage).toBeLessThan(0.1);
    const slowed = detail.tasks.find((t) => t.task_id === 'task_2_1');
    expect(slowed?.duration_regression).toMatchObject({ status: 'regression' });
    expect(slowed?.duration_regression?.ratio).toBeGreaterThan(1.3);
    const sibling = detail.tasks.find((t) => t.task_id === 'task_2_2');
    expect(sibling?.duration_regression?.status).toBe('within_baseline');
    // Over 6 h the task has fewer than 10 runs: too few to say.
    const short = (await get(`${ENV}/acme-prod/dags/search_ranking_refresh?range=6h`)).json<DagDetail>();
    expect(short.tasks.find((t) => t.task_id === 'task_2_1')?.duration_regression?.status).toBe('low_sample');
  });

  it('HM-015: the flaky demo DAG has flaky tasks, retries and recoveries', async () => {
    const detail = (await get(`${ENV}/acme-prod/dags/fraud_scoring_hourly?range=24h`)).json<DagDetail>();
    expect(detail.reliability?.tasks.flaky_rate).toBeGreaterThan(0.05);
    expect(detail.reliability?.tasks.retried).toBeGreaterThan(0);
    expect(detail.reliability?.tasks.recoveries).toBeGreaterThan(0);
    expect(detail.reliability?.tasks.mttr_seconds).toBeGreaterThan(60);
  });

  it('HM-007: the Gantt run of a fan-out DAG has a critical path through its layers', async () => {
    const detail = (await get(`${ENV}/acme-prod/dags/customer_360_rebuild?range=24h`)).json<DagDetail>();
    const path = detail.gantt.critical_path;
    expect(path?.method).toBe('timing');
    const tasks = path?.row_indexes.map((i) => detail.gantt.rows[i]?.task_id) ?? [];
    expect(tasks[0]).toBe('task_1_1');
    expect(tasks.at(-1)).toBe('task_3_1');
    const run = detail.runs.find((r) => r.run_id === detail.gantt.run_id);
    expect(path?.duration_seconds).toBeCloseTo(run?.duration_seconds as number, 3);
  });
});
