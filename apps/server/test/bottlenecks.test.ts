import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';
import type { FastifyInstance } from 'fastify';
import type { Bottlenecks } from '@dcam/contracts';
import { buildApp, createDemoWorkspace } from '../src/index';

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const spec = parse(
  readFileSync(fileURLToPath(import.meta.resolve('@dcam/contracts/openapi.yaml')), 'utf8'),
) as Record<string, unknown>;
const ajv = new Ajv2020({ strict: false });
addFormats.default(ajv);
ajv.addSchema({ ...spec, $id: 'dcam' });
const conforms = (schema: string, body: unknown) => {
  const validate = ajv.getSchema(`dcam#/components/schemas/${schema}`);
  if (!validate) throw new Error(`no schema ${schema}`);
  return validate(body) ? true : validate.errors;
};

let app: FastifyInstance;
// Building the demo workspace simulates 48 h for three environments; allow for loaded CI runners.
beforeAll(async () => {
  const workspace = await createDemoWorkspace({ now: () => NOW });
  app = await buildApp({ ...workspace, version: '0.0.0-test', allowedHosts: ['127.0.0.1:8787'] });
}, 60_000);
afterAll(async () => {
  await app.close();
});
const get = (url: string) => app.inject({ method: 'GET', url, headers: { host: '127.0.0.1:8787' } });

describe('GET /api/v1/environments/{env_id}/bottlenecks (FR-BOTL-01, HM-006)', { timeout: 60_000 }, () => {
  it.each([
    ['15m', 60, 15],
    ['1h', 60, 60],
    ['6h', 300, 72],
    ['24h', 900, 96],
    ['7d', 3_600, 168],
    ['30d', 10_800, 240],
    ['90d', 21_600, 360],
  ])(
    'ADR-0003 / NFR-PERF-06: range %s conforms to the contract with %i-second buckets (%i points)',
    async (range, bucketSeconds, points) => {
      const res = await get(`/api/v1/environments/acme-prod/bottlenecks?range=${range}`);
      expect(res.statusCode).toBe(200);
      const b = res.json<Bottlenecks>();
      expect(conforms('Bottlenecks', b)).toBe(true);
      expect(b.bucket_seconds).toBe(bucketSeconds);
      expect(b.series).toHaveLength(points);
    },
  );

  it('FR-BOTL-01: acme-prod waiting is explained by platform limits, led by the starved pool or worker capacity', async () => {
    const b = (await get('/api/v1/environments/acme-prod/bottlenecks')).json<Bottlenecks>();
    expect(b.waiting_task_seconds).toBeGreaterThan(0);
    expect(['pool-exhausted', 'executor-slots-exhausted', 'autoscaling-lag']).toContain(b.answer.reason);
    expect(b.pools.find((p) => p.name === 'external_api')?.starved_minutes).toBeGreaterThan(0);
    expect(b.capacity.minutes_at_max_workers).toBeGreaterThan(0);
    expect(b.sensors[0]?.dag_id).toBe('partner_feed_wait');
  });

  it('FR-BOTL-01: acme-test waiting is led by global parallelism', async () => {
    const b = (await get('/api/v1/environments/acme-test/bottlenecks')).json<Bottlenecks>();
    expect(b.answer.reason).toBe('parallelism');
  });

  it('answers unknown environments with 404 and bad ranges with 400 problems', async () => {
    expect((await get('/api/v1/environments/acme-nope/bottlenecks')).statusCode).toBe(404);
    const bad = await get('/api/v1/environments/acme-prod/bottlenecks?range=2d');
    expect(bad.statusCode).toBe(400);
    expect(bad.headers['content-type']).toContain('application/problem+json');
  });
});
