import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Alerts, Fleet, Meta } from '@dcam/contracts';
import type { ConfigIssue } from '@dcam/ports';
import { buildApp, createSetupWorkspace } from '../src/index';
import { conforms } from './contract';

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const HOST = '127.0.0.1:8787';
const CONFIG = '/home/acme/deep-gcp-airflow-monitoring/dcam.config.yaml';
const ISSUES: readonly ConfigIssue[] = [
  {
    path: 'environments.0.projectId',
    message: 'Required.',
    fixHint: 'Set projectId to the Google Cloud project of the environment, for example acme-data-prod.',
  },
  {
    path: '',
    message: 'The file is not valid YAML.',
    fixHint: 'Check the indentation near line 4.',
  },
];

let app: FastifyInstance;
beforeAll(async () => {
  const ws = await createSetupWorkspace({ configPath: CONFIG, issues: ISSUES, now: () => NOW });
  app = await buildApp({ ...ws, version: '0.0.0-test', allowedHosts: [HOST] });
});
afterAll(async () => {
  await app.close();
});
const get = (url: string) => app.inject({ method: 'GET', url, headers: { host: HOST } });

describe('setup mode (FR-SETUP-02)', () => {
  it('FR-SETUP-02: GET /api/v1/meta reports live mode, no environments and every issue with its fix hint', async () => {
    const res = await get('/api/v1/meta');
    expect(res.statusCode).toBe(200);
    const body = res.json<Meta>();
    expect(conforms('Meta', body)).toBe(true);
    expect(body).toMatchObject({ mode: 'live', environments: [] });
    expect(body.setup).toEqual({
      config_path: CONFIG,
      issues: [
        {
          path: 'environments.0.projectId',
          message: 'Required.',
          fix_hint:
            'Set projectId to the Google Cloud project of the environment, for example acme-data-prod.',
        },
        { path: '', message: 'The file is not valid YAML.', fix_hint: 'Check the indentation near line 4.' },
      ],
    });
  });

  it('FR-SETUP-02: a missing configuration file is reported with a null path', async () => {
    const ws = await createSetupWorkspace({ configPath: null, issues: [], now: () => NOW });
    const none = await buildApp({ ...ws, version: '0.0.0-test', allowedHosts: [HOST] });
    try {
      const res = await none.inject({ method: 'GET', url: '/api/v1/meta', headers: { host: HOST } });
      expect(conforms('Meta', res.json())).toBe(true);
      expect(res.json<Meta>().setup).toEqual({ config_path: null, issues: [] });
    } finally {
      await none.close();
    }
  });

  it('FR-SETUP-02: the UI stays available: health, fleet and alerts answer with zero environments', async () => {
    expect((await get('/api/v1/health')).json()).toEqual({ status: 'ok' });

    const fleet = await get('/api/v1/fleet');
    expect(fleet.statusCode).toBe(200);
    expect(conforms('Fleet', fleet.json())).toBe(true);
    expect(fleet.json<Fleet>().environments).toEqual([]);

    const alerts = await get('/api/v1/alerts');
    expect(alerts.statusCode).toBe(200);
    expect(conforms('Alerts', alerts.json())).toBe(true);
    expect(alerts.json<Alerts>()).toMatchObject({ rules: [], events: [] });
  });

  it.each(['overview', 'dags', 'dags/acme_orders_daily', 'bottlenecks', 'findings'])(
    'FR-SETUP-02: environment route %s is a 404 problem, because no environment is configured',
    async (path) => {
      const res = await get(`/api/v1/environments/acme-prod/${path}`);
      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(conforms('Problem', res.json())).toBe(true);
    },
  );

  it('FR-SETUP-02: an environment filter on alerts is a 404 problem too', async () => {
    const res = await get('/api/v1/alerts?env_id=acme-prod');
    expect(res.statusCode).toBe(404);
  });

  it('FR-SETUP-02: the setup workspace has no environments, an empty store and an empty model', async () => {
    const ws = await createSetupWorkspace({ configPath: null, issues: [], now: () => NOW });
    expect(ws.mode).toBe('live');
    expect(ws.environments).toEqual([]);
    expect(await ws.model.config('acme-prod')).toBeNull();
    expect(await ws.model.dags('acme-prod')).toEqual([]);
    expect(await ws.store.countTaskTries('acme-prod')).toBe(0);
    expect(ws.clock.now()).toBe(NOW);
  });
});
