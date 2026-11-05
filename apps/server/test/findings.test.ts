import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';
import type { FastifyInstance } from 'fastify';
import type { Finding, Findings } from '@dcam/contracts';
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
const findings = async (envId: string) =>
  (await get(`/api/v1/environments/${envId}/findings`)).json<Findings>();
const keys = (f: Findings) => f.findings.map((x) => `${x.rule_id} ${x.scope.kind}:${x.scope.id}`);

describe('GET /api/v1/environments/{env_id}/findings (FR-ADV-01..04)', { timeout: 60_000 }, () => {
  it.each(['acme-prod', 'acme-test', 'acme-dev'])(
    'ADR-0003: conforms to the contract for %s',
    async (envId) => {
      const res = await get(`/api/v1/environments/${envId}/findings`);
      expect(res.statusCode).toBe(200);
      expect(conforms('Findings', res.json())).toBe(true);
    },
  );

  // The load-normalised demo keeps prod's workers below the REC-CAP-01 condition (≥ 15 queued while at
  // max_count for 15 min); the rule itself is covered by the domain tests.
  it('FR-ADV-01: acme-prod shows the starved pool, the capped fan-out DAG, schedule collisions and the poke sensor', async () => {
    const f = await findings('acme-prod');
    expect(keys(f)).toEqual(
      expect.arrayContaining([
        'REC-SCHED-01 environment:acme-prod',
        'REC-CONC-02 pool:external_api',
        'REC-DAG-01 dag:customer_360_rebuild',
        'REC-DAG-05 task:partner_feed_wait/wait_for_1_1',
      ]),
    );
    expect(new Set(keys(f)).size).toBe(f.findings.length);
    expect(f.sources).toEqual(['DEMO']);
  });

  it('FR-ADV-01: acme-test shows that global parallelism binds below worker capacity', async () => {
    const f = await findings('acme-test');
    const conc = f.findings.find((x) => x.rule_id === 'REC-CONC-01');
    expect(conc?.tier_weight).toBe(0.6);
    expect(conc?.remediation.map((r) => r.code).join('\n')).toContain('core-parallelism=48');
  });

  it('FR-ADV-04: findings are ranked critical first, then by priority score, affected DAGs and recency', async () => {
    for (const envId of ['acme-prod', 'acme-test', 'acme-dev']) {
      const list = (await findings(envId)).findings;
      const order = (a: Finding, b: Finding) =>
        Number(b.severity === 'critical') - Number(a.severity === 'critical') ||
        b.priority_score - a.priority_score ||
        b.affected_dags.length - a.affected_dags.length ||
        Date.parse(b.detected_at) - Date.parse(a.detected_at);
      for (let i = 1; i < list.length; i++)
        expect(order(list[i - 1] as Finding, list[i] as Finding)).toBeLessThanOrEqual(0);
      for (const x of list)
        expect(x.priority_score).toBeCloseTo((x.tier_weight * x.impact * x.confidence) / x.effort, 2);
    }
  });

  it('FR-ADV-03: snippets are copy-only text with placeholders, and the endpoint only reads', async () => {
    const f = await findings('acme-test');
    const conc = f.findings.find((x) => x.rule_id === 'REC-CONC-01');
    expect(conc?.remediation.map((r) => r.kind)).toEqual(['gcloud', 'terraform']);
    expect(conc?.remediation[0]?.code).toContain('--location LOCATION');
    const post = await app.inject({
      method: 'POST',
      url: '/api/v1/environments/acme-prod/findings',
      headers: { host: '127.0.0.1:8787' },
    });
    expect(post.statusCode).toBe(404);
  });

  it('answers unknown environments with a 404 problem', async () => {
    const res = await get('/api/v1/environments/acme-nope/findings');
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });
});
