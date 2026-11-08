import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';
import type { FastifyInstance } from 'fastify';
import type { AlertRule, Alerts } from '@dcam/contracts';
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
let all: Alerts;
// Building the demo workspace simulates 48 h for three environments; allow for loaded CI runners.
beforeAll(async () => {
  const workspace = await createDemoWorkspace({ now: () => NOW });
  app = await buildApp({ ...workspace, version: '0.0.0-test', allowedHosts: ['127.0.0.1:8787'] });
  all = (await get('/api/v1/alerts')).json<Alerts>();
}, 60_000);
afterAll(async () => {
  await app.close();
});
const get = (url: string) => app.inject({ method: 'GET', url, headers: { host: '127.0.0.1:8787' } });
const rule = (env: string, id: string): AlertRule => {
  const r = all.rules.find((x) => x.env_id === env && x.id === id);
  if (!r) throw new Error(`no ${id} for ${env}`);
  return r;
};
const firing = (env: string) =>
  all.rules.filter((r) => r.env_id === env && r.state === 'firing').map((r) => r.id);

describe('GET /api/v1/alerts (FR-ALRT-01/02/06)', { timeout: 60_000 }, () => {
  it('ADR-0003: conforms to the contract for all environments and for one', async () => {
    const res = await get('/api/v1/alerts');
    expect(res.statusCode).toBe(200);
    expect(conforms('Alerts', res.json())).toBe(true);
    const one = await get('/api/v1/alerts?env_id=acme-test');
    expect(one.statusCode).toBe(200);
    const body = one.json<Alerts>();
    expect(conforms('Alerts', body)).toBe(true);
    expect(new Set(body.rules.map((r) => r.env_id))).toEqual(new Set(['acme-test']));
    expect(body.events.every((e) => e.env_id === 'acme-test')).toBe(true);
  });

  it('FR-ALRT-02: every environment gets the 19-rule default pack, exactly one alert per rule', () => {
    for (const env of ['acme-prod', 'acme-test', 'acme-dev']) {
      const ids = all.rules.filter((r) => r.env_id === env).map((r) => r.id);
      expect(ids, env).toHaveLength(19);
      expect(new Set(ids).size, env).toBe(19);
    }
    expect(all.sources).toEqual(['DEMO']);
  });

  it('FR-ALRT-01: acme-prod: the starved external_api pool fired AL-15; worker restarts fire AL-19', () => {
    expect(rule('acme-prod', 'AL-15').fired_count_24h).toBeGreaterThanOrEqual(1);
    expect(
      all.events.some((e) => e.env_id === 'acme-prod' && e.rule_id === 'AL-15' && e.kind === 'fired'),
    ).toBe(true);
    expect(rule('acme-prod', 'AL-19')).toMatchObject({ state: 'firing', value: 3, severity: 'warning' });
  });

  it('FR-ALRT-01: acme-prod AL-05 is evaluated from worker samples with the spec threshold and window', () => {
    const r = rule('acme-prod', 'AL-05');
    expect(r.state).not.toBe('unknown');
    expect(r).toMatchObject({ threshold: 10, for_seconds: 900, severity: 'warning' });
    expect(r.value).not.toBeNull();
  });

  it('FR-ALRT-01: acme-prod: the nightly batch window fired AL-05 (tasks queued while workers are at maximum)', () => {
    expect(rule('acme-prod', 'AL-05').fired_count_24h).toBeGreaterThanOrEqual(1);
    const fired = all.events.filter(
      (e) => e.env_id === 'acme-prod' && e.rule_id === 'AL-05' && e.kind === 'fired',
    );
    expect(fired.length).toBeGreaterThanOrEqual(1);
    // The batch window starts at 01:30 UTC; workers reach max_count and the queue builds for 15 min first.
    expect(fired.every((e) => [1, 2, 3].includes(new Date(e.at).getUTCHours()))).toBe(true);
  });

  it('FR-ALRT-01: acme-test: two import errors fire AL-04 at the non-prod severity', () => {
    expect(rule('acme-test', 'AL-04')).toMatchObject({ state: 'firing', value: 2, severity: 'info' });
    expect(rule('acme-test', 'AL-02')).toMatchObject({ state: 'inactive', value: 93 });
  });

  it('FR-ALRT-01: acme-dev is quiet: nothing is firing', () => {
    expect(firing('acme-dev')).toEqual([]);
  });

  it('§16.2: rules never evaluated are unknown, with the reason', () => {
    for (const env of ['acme-prod', 'acme-test', 'acme-dev'])
      for (const id of ['AL-03', 'AL-08', 'AL-11', 'AL-12', 'AL-13', 'AL-14', 'AL-16']) {
        const r = rule(env, id);
        expect(r.state, `${env} ${id}`).toBe('unknown');
        expect(r.value).toBeNull();
        expect(r.summary).toMatch(/not (collected|configured) in this version/);
      }
    // 48 h of demo history is too short for the 7-day same-hour failure baseline (spec §8.9).
    expect(rule('acme-prod', 'AL-09').state).toBe('unknown');
  });

  it('FR-ALRT-06: events of the last 24 h, newest first', () => {
    const times = all.events.map((e) => Date.parse(e.at));
    expect(times.length).toBeGreaterThan(0);
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(times.every((t) => t >= NOW - 24 * 3_600_000 && t <= NOW)).toBe(true);
  });

  it('answers an unknown environment with a 404 problem', async () => {
    const res = await get('/api/v1/alerts?env_id=acme-nope');
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });
});
