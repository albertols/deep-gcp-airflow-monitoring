import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type {
  Bottlenecks,
  DagComparison,
  DagDetail,
  DagLeague,
  Findings,
  RunComparison,
} from '@dcam/contracts';
import { buildApp, createDemoWorkspace } from '../src/index';
import { conforms } from './contract';

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const ENV = '/api/v1/environments';

let app: FastifyInstance;
// Building the demo workspace simulates 48 h for three environments; allow for loaded CI runners.
beforeAll(async () => {
  const workspace = await createDemoWorkspace({ now: () => NOW });
  app = await buildApp({ ...workspace, version: '0.0.0-test', allowedHosts: ['127.0.0.1:8787'] });
}, 120_000);
afterAll(async () => {
  await app.close();
});
const get = (url: string) => app.inject({ method: 'GET', url, headers: { host: '127.0.0.1:8787' } });
const q = encodeURIComponent;

describe(
  'FR-DAGD-05 / FR-DAGD-06 DAG detail concurrency and impact on the demo',
  { timeout: 120_000 },
  () => {
    it('FR-DAGD-05 / REC-DAG-01: the fan-out DAG capped by max_active_tasks raises REC-DAG-01 and links the finding', async () => {
      const res = await get(`${ENV}/acme-prod/dags/customer_360_rebuild`);
      expect(res.statusCode).toBe(200);
      const detail = res.json<DagDetail>();
      expect(conforms('DagDetail', detail)).toBe(true);
      const { findings } = (await get(`${ENV}/acme-prod/findings`)).json<Findings>();
      const finding = findings.find(
        (f) => f.rule_id === 'REC-DAG-01' && f.scope.id === 'customer_360_rebuild',
      );
      expect(finding).toBeDefined();
      const c = detail.concurrency;
      expect(c).toMatchObject({ max_active_tasks: 4, limit_scope: 'dag', bucket_seconds: 900 });
      expect(c?.self_throttling).toMatchObject({ raises_rec_dag_01: true, finding_id: finding?.id });
      expect(c?.self_throttling.at_limit_share).toBeGreaterThanOrEqual(0.1);
      expect(detail.stats.self_throttled_ratio).toBe(c?.self_throttling.at_limit_share);
      expect(c?.peak_in_flight).toBeLessThanOrEqual(4);
      expect(detail.findings.map((f) => f.id)).toContain(finding?.id);
    });

    it('FR-DAGD-06 / HM-017: the noisy neighbour has the score the bottlenecks page shows, with confidence', async () => {
      const detail = (await get(`${ENV}/acme-prod/dags/search_index_rebuild`)).json<DagDetail>();
      expect(conforms('DagDetail', detail)).toBe(true);
      const page = (await get(`${ENV}/acme-prod/bottlenecks`)).json<Bottlenecks>();
      const item = page.noisy_neighbours?.items.find((x) => x.dag_id === 'search_index_rebuild');
      const nn = detail.impact?.noisy_neighbour;
      expect(nn?.status).toBe('associated');
      expect(nn?.score).toEqual(item);
      expect(nn?.score?.confidence).toMatch(/^(high|medium)$/);
      expect(detail.impact?.slots_source).toBe('monitoring');
      // The rebuild runs every 3 hours: some buckets hold a large share of the load, most none.
      const shares = (detail.impact?.series ?? []).map((b) => b.share ?? 0);
      expect(Math.max(...shares)).toBeGreaterThan(0.2);
    });

    it.each(['1h', '6h'])(
      'FR-DAGD-05 / FR-DAGD-06: the %s detail conforms with series of the range buckets',
      async (range) => {
        const detail = (
          await get(`${ENV}/acme-prod/dags/customer_360_rebuild?range=${range}`)
        ).json<DagDetail>();
        expect(conforms('DagDetail', detail)).toBe(true);
        const buckets = range === '1h' ? 60 : 72;
        expect(detail.concurrency?.series).toHaveLength(buckets);
        expect(detail.impact?.series).toHaveLength(buckets);
      },
    );
  },
);

describe('FR-DAGD-09 GET …/dags/{dag_id}/runs/compare on the demo', { timeout: 120_000 }, () => {
  const url = (a: string, b: string, extra = '') =>
    `${ENV}/acme-prod/dags/search_ranking_refresh/runs/compare?a=${q(a)}&b=${q(b)}${extra}`;

  it('FR-DAGD-09: the task that got 3 × slower 20 h ago explains most of the difference and ranks first', async () => {
    const detail = (await get(`${ENV}/acme-prod/dags/search_ranking_refresh`)).json<DagDetail>();
    const finished = detail.runs.filter((r) => r.state !== 'running');
    const a = finished[0]?.run_id ?? '';
    const b = finished.at(-1)?.run_id ?? '';
    const res = await get(url(a, b));
    expect(res.statusCode).toBe(200);
    const c = res.json<RunComparison>();
    expect(conforms('RunComparison', c)).toBe(true);
    expect(c).toMatchObject({ method: 'HM-007/timing', ranking: 'critical_path', sources: ['DEMO'] });
    expect(c.tasks[0]?.task_id).toBe('task_2_1');
    expect(c.tasks[0]?.contribution_seconds ?? 0).toBeGreaterThan(
      0.5 * (c.duration_delta_seconds ?? Infinity),
    );
    const sum = c.tasks.reduce((s, t) => s + (t.contribution_seconds ?? 0), 0);
    expect(sum).toBeCloseTo(c.explained_seconds ?? NaN, 6);
  });

  it('FR-DAGD-09: problems for missing or unknown runs, an unknown DAG and a bad range', async () => {
    const detail = (await get(`${ENV}/acme-prod/dags/search_ranking_refresh`)).json<DagDetail>();
    const a = detail.runs[0]?.run_id ?? '';
    for (const [path, status] of [
      [`${ENV}/acme-prod/dags/search_ranking_refresh/runs/compare?a=${q(a)}`, 400],
      [url(a, 'manual__nope'), 404],
      [url(a, a, '&range=2d'), 400],
      [`${ENV}/acme-prod/dags/no_such_dag/runs/compare?a=x&b=y`, 404],
      [`${ENV}/nope/dags/search_ranking_refresh/runs/compare?a=x&b=y`, 404],
    ] as const) {
      const res = await get(path);
      expect(res.statusCode, path).toBe(status);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(conforms('Problem', res.json())).toBe(true);
    }
  });
});

describe('FR-DAGD-08 GET /api/v1/compare/dags on the demo', { timeout: 120_000 }, () => {
  const dagsOf = async (env: string) => (await get(`${ENV}/${env}/dags`)).json<DagLeague>().rows;

  it.each(['24h', '7d'])(
    'FR-DAGD-08: DAGs from two environments over %s conform, with each capacity context',
    async (range) => {
      const testDag = (await dagsOf('acme-test'))[0]?.dag_id ?? '';
      const items = `acme-prod:customer_360_rebuild,acme-test:${testDag},acme-prod:search_index_rebuild`;
      const res = await get(`/api/v1/compare/dags?dags=${q(items)}&range=${range}`);
      expect(res.statusCode).toBe(200);
      const c = res.json<DagComparison>();
      expect(conforms('DagComparison', c)).toBe(true);
      expect(c.time_zone).toBe('UTC');
      expect(c.dags.map((d) => `${d.env_id}:${d.dag_id}`).join(',')).toBe(items);
      expect(c.environments.map((e) => [e.env_id, e.worker_slots, e.parallelism])).toEqual([
        ['acme-prod', 72, 192],
        ['acme-test', 48, 24],
      ]);
      for (const d of c.dags) {
        expect(d.hourly_profile).toHaveLength(24);
        expect(d.duration_histogram.reduce((a, b) => a + b, 0)).toBe(d.duration.samples);
      }
      // The demo holds 48 hours: a 7-day comparison says how little of it is covered.
      const coverage = c.environments[0]?.coverage ?? NaN;
      if (range === '7d') expect(coverage).toBeLessThan(0.35);
      else expect(coverage).toBe(1);
    },
  );

  it('FR-DAGD-08: problems for too few, too many, repeated or malformed DAGs, unknown ones and a bad range', async () => {
    for (const [query, status] of [
      ['', 400],
      ['dags=acme-prod:orders_daily', 400],
      ['dags=a:1,a:2,a:3,a:4,a:5', 400],
      ['dags=acme-prod:customer_360_rebuild,acme-prod:customer_360_rebuild', 400],
      ['dags=acme-prod,acme-test:x', 400],
      ['dags=acme-prod:customer_360_rebuild,acme-nope:x', 404],
      ['dags=acme-prod:customer_360_rebuild,acme-test:no_such_dag', 404],
      ['dags=acme-prod:customer_360_rebuild,acme-prod:search_index_rebuild&range=1y', 400],
    ] as const) {
      const res = await get(`/api/v1/compare/dags?${query}`);
      expect(res.statusCode, query).toBe(status);
      expect(conforms('Problem', res.json())).toBe(true);
    }
  });
});
