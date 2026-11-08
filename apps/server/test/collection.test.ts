import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Collection } from '@dcam/contracts';
import { buildApp, createDemoWorkspace, createSetupWorkspace, type Workspace } from '../src/index';
import { conforms } from './contract';

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const HOST = '127.0.0.1:8787';
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

/** What the collection engine reports for one fictitious environment. */
const LIVE: Collection = {
  mode: 'live',
  generated_at: at(0),
  environments: [
    {
      env_id: 'acme-prod',
      profile: 'standard',
      reduced_fidelity: true,
      failing: true,
      collectors: [
        {
          id: 'af.live',
          source: 'SRC-AF-API',
          state: 'failing',
          cadence_seconds: 30,
          last_attempt_at: at(1),
          last_success_at: at(5),
          next_run_at: at(-1),
          lag_seconds: 300,
          consecutive_failures: 3,
          error_rate_1h: 0.25,
          last_error: {
            kind: 'unauthenticated',
            message: 'The Airflow web server rejected the access token.',
            fix_hint: 'gcloud auth application-default login',
            at: at(1),
          },
        },
        {
          id: 'mon.core',
          source: 'SRC-MON',
          state: 'waiting',
          cadence_seconds: 60,
          last_attempt_at: null,
          last_success_at: null,
          next_run_at: at(-1),
          lag_seconds: null,
          consecutive_failures: 0,
          error_rate_1h: null,
          last_error: null,
        },
      ],
      footprint: [
        {
          api: 'airflow',
          budget_per_minute: 12,
          requests_1h: 540,
          requests_24h: 12_960,
          errors_24h: 4,
          bytes_24h: 52_428_800,
          p95_latency_ms: 180,
        },
      ],
      series_24h: 1_440,
    },
  ],
};

const apps: FastifyInstance[] = [];
async function appFor(ws: Workspace) {
  const app = await buildApp({ ...ws, version: '0.0.0-test', allowedHosts: [HOST] });
  apps.push(app);
  return (url: string) => app.inject({ method: 'GET', url, headers: { host: HOST } });
}
afterAll(async () => {
  await Promise.all(apps.map((a) => a.close()));
});

describe('GET /api/v1/collection (FR-COLL-11, FR-SELF-01, HM-030)', { timeout: 60_000 }, () => {
  let demo: Awaited<ReturnType<typeof appFor>>;
  beforeAll(async () => {
    demo = await appFor(await createDemoWorkspace({ now: () => NOW, hours: 1 }));
  }, 60_000);

  it('FR-SELF-01: demo mode has no collectors, so the response is empty and conforms to the contract', async () => {
    const res = await demo('/api/v1/collection');
    expect(res.statusCode).toBe(200);
    expect(conforms('Collection', res.json())).toBe(true);
    expect(res.json()).toEqual({ mode: 'demo', generated_at: at(0), environments: [] });
  });

  it('FR-COLL-11 / HM-030: live mode returns the engine status, computed on every request', async () => {
    const setup = await createSetupWorkspace({ configPath: null, issues: [], now: () => NOW });
    let calls = 0;
    const live: Workspace = {
      mode: 'live',
      environments: [{ env_id: 'acme-prod', display_name: 'acme-prod', tier: 'prod' }],
      store: setup.store,
      model: setup.model,
      clock: setup.clock,
      collection: () => {
        calls += 1;
        return LIVE;
      },
    };
    const get = await appFor(live);
    const res = await get('/api/v1/collection');
    expect(res.statusCode).toBe(200);
    expect(conforms('Collection', res.json())).toBe(true);
    expect(res.json()).toEqual(LIVE);
    await get('/api/v1/collection');
    expect(calls).toBe(2);
  });

  it('FR-SETUP-02: setup mode answers with an empty live collection', async () => {
    const get = await appFor(
      await createSetupWorkspace({ configPath: '/home/acme/dcam.config.yaml', issues: [], now: () => NOW }),
    );
    const res = await get('/api/v1/collection');
    expect(res.statusCode).toBe(200);
    expect(conforms('Collection', res.json())).toBe(true);
    expect(res.json()).toEqual({ mode: 'live', generated_at: at(0), environments: [] });
  });
});
