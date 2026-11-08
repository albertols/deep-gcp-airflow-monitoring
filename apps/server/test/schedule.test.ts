import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Schedule } from '@dcam/contracts';
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

describe('GET /api/v1/environments/{env_id}/schedule (FR-BOTL-03, HM-009)', { timeout: 120_000 }, () => {
  it.each(['1h', '6h', '24h'])('ADR-0003: conforms to the contract for range %s', async (range) => {
    const res = await get(`/api/v1/environments/acme-prod/schedule?range=${range}`);
    expect(res.statusCode).toBe(200);
    expect(conforms('Schedule', res.json())).toBe(true);
  });

  it('FR-BOTL-03 / FR-EMU-01: the demo schedules collide on minute 0, above the REC-SCHED-01 threshold', async () => {
    const s = (await get('/api/v1/environments/acme-prod/schedule')).json<Schedule>();
    expect(s.collision.busiest_minute).toBe(0);
    expect(s.collision.index).toBeGreaterThanOrEqual(s.collision.threshold);
    expect(s.top_minutes[0]?.minute).toBe(0);
    expect(s.top_schedules[0]?.dags).toBeGreaterThan(1);
    expect(s.actual.runs).toBeGreaterThan(0);
    expect(s.sources).toEqual(['DEMO']);
  });

  it('answers unknown environments with 404 and bad ranges with 400 problems', async () => {
    expect((await get('/api/v1/environments/acme-nope/schedule')).statusCode).toBe(404);
    const bad = await get('/api/v1/environments/acme-prod/schedule?range=1y');
    expect(bad.statusCode).toBe(400);
    expect(bad.headers['content-type']).toContain('application/problem+json');
  });
});
