import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';
import type { FastifyInstance } from 'fastify';
import type { DagDetail, DagLeague } from '@dcam/contracts';
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
  it.each(['1h', '6h', '24h'])('FR-DAGX-02: the %s league conforms to DagLeague', async (range) => {
    const res = await get(`${ENV}/acme-prod/dags?range=${range}`);
    expect(res.statusCode).toBe(200);
    expect(conforms('DagLeague', res.json())).toBe(true);
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

  it('returns RFC 9457 problems for an unknown environment and a bad range', async () => {
    const missing = await get(`${ENV}/nope/dags`);
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['content-type']).toContain('application/problem+json');
    expect(conforms('Problem', missing.json())).toBe(true);
    const bad = await get(`${ENV}/acme-prod/dags?range=7d`);
    expect(bad.statusCode).toBe(400);
    expect(conforms('Problem', bad.json())).toBe(true);
  });
});

describe('FR-DAGD-01..04 GET /api/v1/environments/{env_id}/dags/{dag_id}', () => {
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
