import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { EnvironmentModelSource } from '@dcam/ports';
import type { Findings, Fleet } from '@dcam/contracts';
import { buildApp, createDemoWorkspace } from '../src/index';

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const HOST = '127.0.0.1:8787';

let app: FastifyInstance;
// acme-dev is registered but its configuration has not been collected yet, as in M1 before the first
// composer.config cycle. Two simulated hours keep the workspace quick to build.
beforeAll(async () => {
  const ws = await createDemoWorkspace({ now: () => NOW, hours: 2 });
  const model: EnvironmentModelSource = {
    config: async (id) => (id === 'acme-dev' ? null : ws.model.config(id)),
    dags: (id) => ws.model.dags(id),
    snapshots: (id, from, to) => ws.model.snapshots(id, from, to),
    workerSamples: (id, from, to) => ws.model.workerSamples(id, from, to),
    platformHealth: (id) => ws.model.platformHealth(id),
  };
  app = await buildApp({ ...ws, model, version: '0.0.0-test', allowedHosts: [HOST] });
}, 60_000);
afterAll(async () => {
  await app.close();
});
const get = (url: string) => app.inject({ method: 'GET', url, headers: { host: HOST } });

describe(
  'an environment without collected configuration (FR-FLEET-01, FR-DAGX-02, §13.2)',
  { timeout: 60_000 },
  () => {
    it('the fleet still answers, with no findings on that card', async () => {
      const res = await get('/api/v1/fleet');
      expect(res.statusCode).toBe(200);
      const card = res.json<Fleet>().environments.find((e) => e.env_id === 'acme-dev');
      expect(card?.top_findings).toEqual([]);
    });

    it('the DAG league still answers, with no open findings', async () => {
      const res = await get('/api/v1/environments/acme-dev/dags?range=1h');
      expect(res.statusCode).toBe(200);
    });

    it('the advisor lists every rule as not evaluated, with the reason', async () => {
      const res = await get('/api/v1/environments/acme-dev/findings');
      expect(res.statusCode).toBe(200);
      const body = res.json<Findings>();
      expect(body.findings).toEqual([]);
      expect(body.data_as_of).toBeNull();
      expect(body.not_evaluated.length).toBeGreaterThan(0);
    });
  },
);
