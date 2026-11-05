import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';
import type { FastifyInstance } from 'fastify';
import { buildApp, createDemoWorkspace } from '../src/index';

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const spec = parse(readFileSync(fileURLToPath(import.meta.resolve('@dcam/contracts/openapi.yaml')), 'utf8')) as Record<string, unknown>;
const ajv = new Ajv2020({ strict: false });
addFormats.default(ajv);
ajv.addSchema({ ...spec, $id: 'dcam' });
const conforms = (schema: string, body: unknown) => {
  const validate = ajv.getSchema(`dcam#/components/schemas/${schema}`);
  if (!validate) throw new Error(`no schema ${schema}`);
  const ok = validate(body);
  return ok ? true : validate.errors;
};

let app: FastifyInstance;
beforeAll(async () => {
  const workspace = await createDemoWorkspace({ now: () => NOW });
  app = await buildApp({ ...workspace, version: '0.0.0-test', allowedHosts: ['127.0.0.1:8787', 'localhost:8787'] });
});
afterAll(async () => {
  await app.close();
});

const get = (url: string, host = '127.0.0.1:8787') => app.inject({ method: 'GET', url, headers: { host } });

describe('ADR-0003 contract: responses conform to openapi.yaml', () => {
  it('GET /api/v1/health', async () => {
    const res = await get('/api/v1/health');
    expect(res.statusCode).toBe(200);
    expect(conforms('Health', res.json())).toBe(true);
  });

  it('FR-EMU-01: GET /api/v1/meta reports demo mode and the demo environments', async () => {
    const res = await get('/api/v1/meta');
    expect(conforms('Meta', res.json())).toBe(true);
    expect(res.json()).toMatchObject({
      mode: 'demo',
      environments: expect.arrayContaining([expect.objectContaining({ env_id: 'acme-prod', tier: 'prod' })]),
    });
  });

  it('HM-003: GET /api/v1/environments/acme-prod/overview', async () => {
    const res = await get('/api/v1/environments/acme-prod/overview?range=24h');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(conforms('EnvironmentOverview', body)).toBe(true);
    expect(body.top_dags.length).toBe(10);
    expect(body.pareto_80_dag_count).toBeGreaterThan(0);
    expect(body.sources).toEqual(['DEMO']);
  });

  it('returns RFC 9457 problems for an unknown environment and a bad range', async () => {
    const missing = await get('/api/v1/environments/nope/overview');
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['content-type']).toContain('application/problem+json');
    expect(conforms('Problem', missing.json())).toBe(true);
    const bad = await get('/api/v1/environments/acme-prod/overview?range=99y');
    expect(bad.statusCode).toBe(400);
    expect(conforms('Problem', bad.json())).toBe(true);
  });
});

describe('NFR-SEC-02 local web security', () => {
  it('NFR-SEC-02: rejects requests whose Host header is not DCAM (DNS rebinding)', async () => {
    const res = await get('/api/v1/health', 'evil.example:8787');
    expect(res.statusCode).toBe(403);
  });

  it('NFR-SEC-02: sends a strict Content Security Policy and nosniff', async () => {
    const res = await get('/api/v1/health');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['content-security-policy']).not.toContain('unsafe-eval');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('static UI hosting', () => {
  it('serves files added after start-up, falls back to index.html for routes, and 404s missing assets', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'dcam-web-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>DCAM</title>');
    const workspace = await createDemoWorkspace({ now: () => NOW });
    const web = await buildApp({ ...workspace, version: 't', allowedHosts: ['127.0.0.1:8787'], staticDir: dir });
    try {
      mkdirSync(join(dir, 'assets'));
      writeFileSync(join(dir, 'assets', 'index-new.js'), 'console.log(1)');
      const asset = await web.inject({ method: 'GET', url: '/assets/index-new.js', headers: { host: '127.0.0.1:8787' } });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers['content-type']).toContain('javascript');
      const route = await web.inject({ method: 'GET', url: '/league-table', headers: { host: '127.0.0.1:8787' } });
      expect(route.statusCode).toBe(200);
      expect(route.headers['content-type']).toContain('text/html');
      const missing = await web.inject({ method: 'GET', url: '/assets/gone.js', headers: { host: '127.0.0.1:8787' } });
      expect(missing.statusCode).toBe(404);
    } finally {
      await web.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
