import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DagIndex, DagLeague } from '@dcam/contracts';
import { buildApp, createDemoWorkspace } from '../src/index';
import { conforms } from './contract';

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);

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

describe('FR-UI-03 GET /api/v1/environments/{env_id}/dag-index', () => {
  it('FR-UI-03: lists every DAG the league knows, sorted by ID, and conforms to DagIndex', async () => {
    const res = await get(`${ENV}/acme-prod/dag-index`);
    expect(res.statusCode).toBe(200);
    const index = res.json<DagIndex>();
    expect(conforms('DagIndex', index)).toBe(true);
    expect(index.env_id).toBe('acme-prod');
    const ids = index.dags.map((d) => d.dag_id);
    expect(ids).toEqual([...ids].sort());
    const league = (await get(`${ENV}/acme-prod/dags`)).json<DagLeague>();
    expect(new Set(ids)).toEqual(new Set(league.rows.map((r) => r.dag_id)));
    expect(index.dags.some((d) => d.paused)).toBe(true); // the demo has paused DAGs
  });

  it('FR-UI-03: an unknown environment is a 404 problem with a fix hint', async () => {
    const res = await get(`${ENV}/acme-nope/dag-index`);
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });
});
