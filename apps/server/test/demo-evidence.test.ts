import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Bottlenecks } from '@dcam/contracts';
import { buildApp, createDemoWorkspace } from '../src/index';
import { conforms } from './contract';

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);

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

describe('the demo shows the M3 "why is work waiting" evidence (FR-EMU-01)', { timeout: 120_000 }, () => {
  it('HM-017 / FR-ENV-08 / HM-023: a noisy neighbour, a starved pool over time and priority bands in acme-prod', async () => {
    const b = (await get('/api/v1/environments/acme-prod/bottlenecks')).json<Bottlenecks>();
    expect(conforms('Bottlenecks', b)).toBe(true);
    expect(b.noisy_neighbours?.evaluated).toBe(true);
    const story = b.noisy_neighbours?.items.find((x) => x.dag_id === 'search_index_rebuild');
    expect(story?.effect_seconds).toBeGreaterThan(0);
    expect(story?.affected_tries).toBeGreaterThanOrEqual(200);
    const api = b.pools.find((p) => p.name === 'external_api');
    expect(api?.starved_series?.some((m) => (m ?? 0) > 0)).toBe(true);
    expect(api?.top_dags?.[0]?.dag_id).toMatch(/^partner_/);
    const pool = b.reasons.find((r) => r.id === 'pool-exhausted');
    expect(pool?.top_pools?.[0]?.pool).toBe('external_api');
    expect(b.priority_fairness?.pools.some((p) => p.bands.length > 1)).toBe(true);
  });
});
