import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Capacity, Forecast } from '@dcam/contracts';
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
const hourOf = (iso: string) => new Date(iso).getUTCHours() + new Date(iso).getUTCMinutes() / 60;

describe('GET /api/v1/environments/{env_id}/capacity (FR-ENV-02, FR-DAGX-06)', { timeout: 120_000 }, () => {
  it.each(['1h', '6h', '24h', '7d'])('ADR-0003: conforms to the contract for range %s', async (range) => {
    const res = await get(`/api/v1/environments/acme-prod/capacity?range=${range}`);
    expect(res.statusCode).toBe(200);
    expect(conforms('Capacity', res.json())).toBe(true);
  });

  it('FR-ENV-02 / FR-EMU-01: the demo highlights the 01:30 UTC batch window as capacity-bound', async () => {
    const c = (await get('/api/v1/environments/acme-prod/capacity')).json<Capacity>();
    expect(c.sources).toEqual(['DEMO']);
    expect(c.capacity_bound.evaluated).toBe(true);
    // The batch's 16-wide layers queue once its first tasks finish, from about 02:00.
    const nightly = c.capacity_bound.periods.find(
      (p) => p.start.startsWith('2026-11-05T0') && hourOf(p.start) >= 1.5 && hourOf(p.start) < 3,
    );
    expect(nightly?.minutes).toBeGreaterThanOrEqual(15);
    expect(nightly?.workers).toBe(c.limits.max_workers);
    expect(nightly?.queued_peak).toBeGreaterThanOrEqual(c.capacity_bound.min_queued);
    expect(c.slots_source).toBe('monitoring');
    expect(c.scale_events.up).toBeGreaterThan(0);
    expect(c.dag_load.dags).toHaveLength(20);
  });

  it('NFR-DATA-03: over 7 days the demo’s 48 hours leave the older hours as gaps, not zeros', async () => {
    const c = (await get('/api/v1/environments/acme-prod/capacity?range=7d')).json<Capacity>();
    expect(c.series[0]).toMatchObject({
      observed_minutes: 0,
      workers_mean: null,
      capacity_bound_minutes: null,
    });
    expect(c.heatmap.cells[0]).toMatchObject({ observed_minutes: 0, utilisation_mean: null });
    expect(c.dag_load.covered_hours.every((h) => h >= 1)).toBe(true);
  });

  it('answers unknown environments with 404, and global presets outside 1 h to 7 days with 400 (FR-UI-01)', async () => {
    expect((await get('/api/v1/environments/acme-nope/capacity')).statusCode).toBe(404);
    for (const range of ['15m', '30d', '90d']) {
      const bad = await get(`/api/v1/environments/acme-prod/capacity?range=${range}`);
      expect(bad.statusCode).toBe(400);
      expect(bad.headers['content-type']).toContain('application/problem+json');
      expect(bad.json<{ fix_hint: string }>().fix_hint).toBe('Use one of 1h, 6h, 24h or 7d.');
    }
    // The other pages take every preset, 7 days included.
    expect((await get('/api/v1/environments/acme-prod/bottlenecks?range=7d')).statusCode).toBe(200);
  });
});

describe('GET /api/v1/environments/{env_id}/forecast (HM-010, FR-BOTL-05)', { timeout: 120_000 }, () => {
  it.each(['acme-prod', 'acme-test', 'acme-dev'])(
    'ADR-0003: conforms to the contract for %s',
    async (env) => {
      const res = await get(`/api/v1/environments/${env}/forecast`);
      expect(res.statusCode).toBe(200);
      expect(conforms('Forecast', res.json())).toBe(true);
    },
  );

  it('HM-010 / FR-EMU-01: the demo forecast shows the 01:30 UTC batch window, and says it is low confidence', async () => {
    const f = (await get('/api/v1/environments/acme-prod/forecast')).json<Forecast>();
    expect(f.sources).toEqual(['DEMO']);
    expect(f.evaluated).toBe(true);
    expect(f.horizon).toEqual({ from: '2026-11-05T12:00:00.000Z', to: '2026-11-06T12:00:00.000Z' });
    const nightly = f.saturation.windows.find(
      (w) => w.start.startsWith('2026-11-06T0') && hourOf(w.start) >= 1.5 && hourOf(w.start) < 3,
    );
    expect(nightly).toBeDefined();
    expect(nightly?.capacity_slots).toBe(72);
    expect(nightly?.top_dags.some((d) => d.dag_id.endsWith('_nightly_rebuild'))).toBe(true);
    expect(nightly?.low_confidence).toBe(true);
    expect(f.history.days).toBeLessThan(f.history.min_days);
    expect(f.confidence.level).toBe('low');
    expect(f.confidence.summary).toMatch(/^Low confidence: /);
  });

  it('answers unknown environments with 404', async () => {
    expect((await get('/api/v1/environments/acme-nope/forecast')).statusCode).toBe(404);
  });
});
