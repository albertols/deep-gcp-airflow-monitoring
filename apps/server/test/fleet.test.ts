import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';
import type { FastifyInstance } from 'fastify';
import type { Fleet } from '@dcam/contracts';
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

describe('GET /api/v1/fleet (FR-FLEET-01/02, HM-028)', { timeout: 60_000 }, () => {
  it('ADR-0003: conforms to the contract, one card per demo environment', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/fleet',
      headers: { host: '127.0.0.1:8787' },
    });
    expect(res.statusCode).toBe(200);
    expect(conforms('Fleet', res.json())).toBe(true);
    expect(res.json<Fleet>().environments.map((e) => e.env_id)).toEqual([
      'acme-prod',
      'acme-test',
      'acme-dev',
    ]);
  });

  it('FR-EMU-03: the demo shows a healthy, a degraded and a partially observed environment', async () => {
    const fleet = (
      await app.inject({ method: 'GET', url: '/api/v1/fleet', headers: { host: '127.0.0.1:8787' } })
    ).json<Fleet>();
    const byId = new Map(fleet.environments.map((e) => [e.env_id, e]));
    expect(byId.get('acme-prod')?.health).toMatchObject({ label: 'healthy', score: 95 });
    expect(byId.get('acme-test')?.health).toMatchObject({ label: 'degraded', score: 75 });
    expect(byId.get('acme-dev')?.health).toMatchObject({ label: 'healthy', evaluated: 8, total: 9 });
    expect(byId.get('acme-prod')?.slot_seconds_24h).toBeGreaterThan(0);
  });
});
