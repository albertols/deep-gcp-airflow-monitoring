import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { createServer, type Server } from 'node:http';
import { GuardError, createGuardedClient, networkModeFromEnv, type GuardedRequest } from '../src/index';

const AIRFLOW = 'https://abc123-dot-europe-west1.composer.googleusercontent.com';

function setup(network: 'any' | 'loopback-only' = 'any') {
  const transport = vi.fn(async () => new Response('{}', { status: 200 }));
  const onRejected = vi.fn();
  const client = createGuardedClient({ network, transport, onRejected });
  return { client, transport, onRejected };
}

async function expectRejected(req: GuardedRequest, code: GuardError['code'], network: 'any' | 'loopback-only' = 'any') {
  const { client, transport, onRejected } = setup(network);
  await expect(client.request(req)).rejects.toMatchObject({ name: 'GuardError', code });
  expect(transport).not.toHaveBeenCalled();
  expect(onRejected).toHaveBeenCalledOnce();
}

describe('NFR-SEC-04 read-only guarantee (spec §18.2)', () => {
  it('allows Airflow reads used by the collectors', async () => {
    const { client, transport } = setup();
    for (const path of [
      '/api/v1/dags?limit=100&offset=0',
      '/api/v1/dags/orders_daily/details',
      '/api/v1/dags/~/dagRuns/~/taskInstances?state=queued&limit=100',
      '/api/v1/dags/orders_daily/dagRuns/scheduled__2026-11-01/taskInstances/load/tries',
      '/api/v1/pools',
      '/api/v1/importErrors',
      '/api/v1/dagWarnings',
      '/api/v1/eventLogs?after=2026-11-01T00:00:00Z',
      '/api/v1/health',
      '/api/v1/version',
      '/api/v1/providers?limit=1',
    ]) {
      await client.request({ method: 'GET', url: `${AIRFLOW}${path}` });
    }
    expect(transport).toHaveBeenCalledTimes(11);
  });

  it('rejects Airflow writes: pause, trigger, clear, set state, delete', async () => {
    await expectRejected({ method: 'PATCH', url: `${AIRFLOW}/api/v1/dags/orders_daily` }, 'not-allowlisted');
    await expectRejected({ method: 'POST', url: `${AIRFLOW}/api/v1/dags/orders_daily/dagRuns`, body: {} }, 'not-allowlisted');
    await expectRejected({ method: 'POST', url: `${AIRFLOW}/api/v1/dags/orders_daily/clearTaskInstances`, body: {} }, 'not-allowlisted');
    await expectRejected({ method: 'DELETE', url: `${AIRFLOW}/api/v1/dags/orders_daily` }, 'not-allowlisted');
  });

  it('rejects Airflow reads DCAM must never make: configuration, connections, variables, XCom', async () => {
    for (const path of ['/api/v1/config', '/api/v1/connections', '/api/v1/variables/secret', '/api/v1/dags/d/dagRuns/r/taskInstances/t/xcomEntries']) {
      await expectRejected({ method: 'GET', url: `${AIRFLOW}${path}` }, 'not-allowlisted');
    }
  });

  it('rejects any non-GET Airflow request (property)', async () => {
    const { client, transport } = setup();
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('POST', 'PUT', 'PATCH', 'DELETE'),
        fc.array(fc.stringMatching(/^[A-Za-z0-9_~.-]{1,12}$/), { maxLength: 6 }),
        async (method, segments) => {
          const url = `${AIRFLOW}/api/v1/${segments.join('/')}`;
          await expect(client.request({ method, url, body: {} })).rejects.toBeInstanceOf(GuardError);
        },
      ),
    );
    expect(transport).not.toHaveBeenCalled();
  }, 30_000);

  it('rejects encoded path separators that the server would decode into forbidden routes (property)', async () => {
    for (const path of [
      '/api/v1/dags/d/dagRuns/r/taskInstances/t%2FxcomEntries',
      '/api/v1/dags/d/dagRuns/r/taskInstances/t%2fxcomEntries%2Fsecret_key',
      '/api/v2/dags/d/dagRuns/r/taskInstances/t%2FxcomEntries',
      '/api/v1/dags/d%2FdagRuns%2Fr%2FtaskInstances%2Ft%2FxcomEntries',
      '/api/v1/dags/..%2Fconfig',
      '/api/v1/pools/x%5C..%5Cvariables',
    ]) {
      await expectRejected({ method: 'GET', url: `${AIRFLOW}${path}` }, 'not-allowlisted');
    }
    const { client, transport } = setup();
    await fc.assert(
      fc.asyncProperty(fc.constantFrom('%2F', '%2f', '%5C', '%5c'), fc.constantFrom('config', 'xcomEntries', 'variables', 'connections'), async (sep, target) => {
        await expect(client.request({ method: 'GET', url: `${AIRFLOW}/api/v1/dags/d${sep}${target}` })).rejects.toBeInstanceOf(GuardError);
      }),
    );
    expect(transport).not.toHaveBeenCalled();
  });

  it('still accepts encoded characters that are legitimate inside IDs', async () => {
    const { client, transport } = setup();
    await client.request({ method: 'GET', url: `${AIRFLOW}/api/v1/dags/orders_daily/dagRuns/scheduled__2026-11-01T00%3A00%3A00%2B00%3A00/taskInstances` });
    await client.request({ method: 'GET', url: 'https://storage.googleapis.com/storage/v1/b/bucket/o/dags%2Forders.py' });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('allows Google read endpoints and rejects their write counterparts', async () => {
    const { client, transport } = setup();
    await client.request({ method: 'GET', url: 'https://monitoring.googleapis.com/v3/projects/acme-data-prod/timeSeries?filter=x' });
    await client.request({ method: 'GET', url: 'https://monitoring.googleapis.com/v3/projects/acme-data-prod/metricDescriptors' });
    await client.request({ method: 'GET', url: 'https://composer.googleapis.com/v1/projects/acme-data-prod/locations/europe-west1/environments/acme-prod' });
    await client.request({ method: 'GET', url: 'https://composer.googleapis.com/v1/projects/acme-data-prod/locations/europe-west1/environments/acme-prod/workloads' });
    await client.request({ method: 'GET', url: 'https://storage.googleapis.com/storage/v1/b/europe-west1-acme-prod-bucket/o?prefix=dags%2F' });
    expect(transport).toHaveBeenCalledTimes(5);
    await expectRejected({ method: 'PATCH', url: 'https://composer.googleapis.com/v1/projects/p/locations/l/environments/e', body: {} }, 'not-allowlisted');
    await expectRejected({ method: 'POST', url: 'https://monitoring.googleapis.com/v3/projects/p/alertPolicies', body: {} }, 'not-allowlisted');
    await expectRejected({ method: 'POST', url: 'https://storage.googleapis.com/upload/storage/v1/b/bucket/o', body: {} }, 'not-allowlisted');
  });

  it('allows Cloud Logging entries:list only with a valid read body', async () => {
    const { client, transport } = setup();
    await client.request({
      method: 'POST',
      url: 'https://logging.googleapis.com/v2/entries:list',
      body: { resourceNames: ['projects/acme-data-prod'], filter: 'resource.type="cloud_composer_environment"', pageSize: 100 },
    });
    expect(transport).toHaveBeenCalledOnce();
    await expectRejected({ method: 'POST', url: 'https://logging.googleapis.com/v2/entries:list', body: { entries: [{}] } }, 'invalid-body');
    await expectRejected({ method: 'POST', url: 'https://logging.googleapis.com/v2/entries:write', body: { entries: [] } }, 'not-allowlisted');
  });

  it('rejects GET requests with a body and method-override headers', async () => {
    await expectRejected({ method: 'GET', url: `${AIRFLOW}/api/v1/pools`, body: { slots: 0 } }, 'invalid-body');
    await expectRejected({ method: 'GET', url: `${AIRFLOW}/api/v1/pools`, headers: { 'X-HTTP-Method-Override': 'PATCH' } }, 'forbidden-header');
  });

  it('rejects unknown hosts and non-HTTPS Google calls', async () => {
    await expectRejected({ method: 'GET', url: 'https://example.com/api/v1/pools' }, 'unknown-host');
    await expectRejected({ method: 'GET', url: 'http://monitoring.googleapis.com/v3/projects/p/timeSeries' }, 'insecure-scheme');
  });

  it('DCAM_NETWORK=loopback-only rejects every non-loopback host', async () => {
    await expectRejected({ method: 'GET', url: 'https://monitoring.googleapis.com/v3/projects/p/timeSeries' }, 'non-loopback', 'loopback-only');
  });

  it('routes emulator endpoints on loopback through the same allowlist', async () => {
    const transport = vi.fn(async () => new Response('{}'));
    const client = createGuardedClient({
      network: 'loopback-only',
      transport,
      hosts: { airflow: ['127.0.0.1:8080'], monitoring: ['127.0.0.1:9090'] },
    });
    await client.request({ method: 'GET', url: 'http://127.0.0.1:8080/api/v1/pools' });
    await client.request({ method: 'GET', url: 'http://127.0.0.1:9090/v3/projects/emu/timeSeries' });
    await expect(client.request({ method: 'PATCH', url: 'http://127.0.0.1:8080/api/v1/dags/d' })).rejects.toBeInstanceOf(GuardError);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('rejects credentials embedded in the URL', async () => {
    await expectRejected({ method: 'GET', url: 'https://user:pw@abc.composer.googleusercontent.com/api/v1/pools' }, 'credentials-in-url');
  });

  it('validates the Cloud Logging list body strictly', async () => {
    const url = 'https://logging.googleapis.com/v2/entries:list';
    for (const body of [{ resourceNames: [] }, { resourceNames: [1] }, [{ resourceNames: ['projects/p'] }], { resourceNames: ['projects/p'], extra: 1 }]) {
      await expectRejected({ method: 'POST', url, body }, 'invalid-body');
    }
  });

  it('can only narrow the allowlist, never widen it', () => {
    expect(() => createGuardedClient({ network: 'any', allowlistIds: ['airflow.v1.pools', 'airflow.v1.nope'] })).toThrow(/Unknown allowlist entry/);
  });

  it('DCAM_NETWORK fails closed on unrecognised values', () => {
    expect(networkModeFromEnv({})).toBe('any');
    expect(networkModeFromEnv({ DCAM_NETWORK: 'loopback-only' })).toBe('loopback-only');
    expect(() => networkModeFromEnv({ DCAM_NETWORK: 'Loopback-Only' })).toThrow(/DCAM_NETWORK/);
  });
});

describe('NFR-SEC-04 redirects never bypass the guard', () => {
  let server: Server;
  let port = 0;
  const seen: string[] = [];
  const start = () =>
    new Promise<void>((resolve) => {
      server = createServer((req, res) => {
        seen.push(`${req.method} ${req.url}`);
        if (req.url === '/api/v1/pools') res.writeHead(302, { location: '/api/v1/config' }).end();
        else if (req.url === '/v2/entries:list') res.writeHead(307, { location: '/v2/entries:write' }).end();
        else res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      }).listen(0, '127.0.0.1', () => {
        port = (server.address() as { port: number }).port;
        resolve();
      });
    });

  it('rejects 3xx responses instead of following them, with the real fetch transport', async () => {
    await start();
    try {
      const onRejected = vi.fn();
      const airflow = createGuardedClient({ network: 'loopback-only', hosts: { airflow: [`127.0.0.1:${port}`] }, onRejected });
      const logging = createGuardedClient({ network: 'loopback-only', hosts: { logging: [`127.0.0.1:${port}`] }, onRejected });
      await expect(
        airflow.request({ method: 'GET', url: `http://127.0.0.1:${port}/api/v1/pools`, headers: { authorization: 'Bearer t' } }),
      ).rejects.toMatchObject({ code: 'redirect' });
      await expect(
        logging.request({ method: 'POST', url: `http://127.0.0.1:${port}/v2/entries:list`, body: { resourceNames: ['projects/p'] } }),
      ).rejects.toMatchObject({ code: 'redirect' });
      expect(seen).toEqual(['GET /api/v1/pools', 'POST /v2/entries:list']);
      expect(onRejected).toHaveBeenCalledTimes(2);
    } finally {
      server.close();
    }
  });
});
