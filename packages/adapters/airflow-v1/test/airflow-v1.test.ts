import { afterEach, describe, expect, it, vi } from 'vitest';
import { SourceError, type ReadOnlyHttp } from '@dcam/ports';
import { createGuardedClient, GuardError } from '@dcam/http-guard';
import { createAirflowV1Api } from '../src/index';
import { fakeHttp, fakeTokens, fixtureJson, routes, type Reply, type SentRequest } from './fake-http';

const COMPOSER = 'https://acme123-dot-europe-west1.composer.googleusercontent.com';
const EMULATOR = 'http://127.0.0.1:8080';

const FIXTURES: Record<string, Reply> = {
  '/api/v1/version': { body: fixtureJson('version.json') },
  '/api/v1/health': { body: fixtureJson('health.json') },
  '/api/v1/dags': { body: fixtureJson('dags.json') },
  '/api/v1/pools': { body: fixtureJson('pools.json') },
  '/api/v1/importErrors': { body: fixtureJson('import-errors.json') },
  '/api/v1/providers': { body: fixtureJson('providers.json') },
  '/api/v1/dags/~/dagRuns/~/taskInstances': { body: fixtureJson('task-instances.json') },
};

function bearerApi(table: Parameters<typeof routes>[0] = FIXTURES, opts: { timeoutMs?: number } = {}) {
  const { http, sent } = fakeHttp(routes(table));
  const tokens = fakeTokens('acme-token-1', 'acme-token-2');
  const api = createAirflowV1Api({ http, baseUrl: COMPOSER, auth: { kind: 'bearer', tokens }, ...opts });
  return { api, sent, tokens };
}

/** An API whose every request is answered with `reply`. */
function answering(reply: Reply | ((req: SentRequest) => Reply)) {
  const { http, sent } = fakeHttp((req) => (typeof reply === 'function' ? reply(req) : reply));
  const tokens = fakeTokens('acme-token-1', 'acme-token-2');
  const api = createAirflowV1Api({ http, baseUrl: COMPOSER, auth: { kind: 'bearer', tokens } });
  return { api, sent, tokens };
}

async function failure(promise: Promise<unknown>): Promise<SourceError> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(SourceError);
  return error as SourceError;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('FR-COLL-08 Airflow REST API v1 adapter: requests', () => {
  it('FR-COLL-08: every call is a GET under {baseUrl}/api/v1 with a bearer token and no Google quota header', async () => {
    const { api, sent } = bearerApi();
    await api.version();
    await api.health();
    await api.dags({ limit: 100, offset: 0 });
    await api.pools();
    await api.importErrorCount();
    await api.taskInstances({ limit: 100, offset: 0 });
    await api.canReadProviders();
    expect(sent).toHaveLength(7);
    for (const req of sent) {
      expect(req.method).toBe('GET');
      expect(req.url.origin).toBe(COMPOSER);
      expect(req.url.pathname.startsWith('/api/v1/')).toBe(true);
      expect(req.headers).toEqual({ accept: 'application/json', authorization: 'Bearer acme-token-1' });
    }
  });

  it('FR-COLL-08: joins a base URL with a trailing slash without doubling it', async () => {
    const { http, sent } = fakeHttp(routes(FIXTURES));
    const api = createAirflowV1Api({
      http,
      baseUrl: `${COMPOSER}/`,
      auth: { kind: 'bearer', tokens: fakeTokens('acme-token') },
    });
    await api.version();
    expect(sent[0]?.url.toString()).toBe(`${COMPOSER}/api/v1/version`);
  });

  it('FR-COLL-08: passes a per-request timeout, 20 s unless configured', async () => {
    const byDefault = bearerApi();
    await byDefault.api.version();
    expect(byDefault.sent[0]?.timeoutMs).toBe(20_000);
    const configured = bearerApi(FIXTURES, { timeoutMs: 5_000 });
    await configured.api.version();
    expect(configured.sent[0]?.timeoutMs).toBe(5_000);
  });

  it('FR-COLL-08: rejects a base URL that is not an http or https URL', () => {
    const { http } = fakeHttp(routes(FIXTURES));
    const tokens = fakeTokens('acme-token');
    expect(() =>
      createAirflowV1Api({ http, baseUrl: 'not a url', auth: { kind: 'bearer', tokens } }),
    ).toThrow(/baseUrl/);
    expect(() =>
      createAirflowV1Api({ http, baseUrl: 'ftp://127.0.0.1/', auth: { kind: 'bearer', tokens } }),
    ).toThrow(/http/);
  });
});

describe('FR-EMU-02 basic authentication on loopback only', () => {
  const basic = { kind: 'basic', username: 'acme_viewer', password: 'pä:ss' } as const;

  it('FR-EMU-02: refuses basic authentication for a non-loopback Airflow URL at construction', () => {
    const { http, sent } = fakeHttp(routes(FIXTURES));
    for (const baseUrl of [COMPOSER, 'http://10.0.0.8:8080', 'http://127.0.0.1.acme.example:8080']) {
      expect(() => createAirflowV1Api({ http, baseUrl, auth: basic })).toThrow(/loopback/);
    }
    expect(sent).toHaveLength(0);
  });

  it('FR-EMU-02: sends an RFC 7617 Basic header (UTF-8) to loopback URLs', async () => {
    for (const baseUrl of [EMULATOR, 'http://localhost:8080', 'http://[::1]:8080']) {
      const { http, sent } = fakeHttp(routes(FIXTURES));
      const api = createAirflowV1Api({ http, baseUrl, auth: basic });
      await api.version();
      const expected = `Basic ${Buffer.from('acme_viewer:pä:ss', 'utf8').toString('base64')}`;
      expect(sent[0]?.headers['authorization']).toBe(expected);
    }
  });

  it('FR-EMU-02: a 401 with basic authentication says to check the credentials', async () => {
    const { http } = fakeHttp(() => ({ status: 401, body: { title: 'Unauthorized', status: 401 } }));
    const api = createAirflowV1Api({ http, baseUrl: EMULATOR, auth: basic });
    const error = await failure(api.version());
    expect(error.kind).toBe('unauthenticated');
    expect(error.details.fixHint).toMatch(/user name and password/);
  });

  it('FR-EMU-02: a 403 with basic authentication says to check the credentials first (2.11.1 answers 403 for a wrong password)', async () => {
    const { http } = fakeHttp(() => ({ status: 403, body: { title: 'Forbidden', status: 403 } }));
    const api = createAirflowV1Api({ http, baseUrl: EMULATOR, auth: basic });
    const error = await failure(api.pools());
    expect(error.kind).toBe('forbidden');
    expect(error.details.fixHint).toMatch(/user name and password/);
    expect(error.details.fixHint).toMatch(/Viewer/);
  });
});

describe('FR-COLL-08 version and health', () => {
  it('FR-COLL-08: version() returns the Airflow version (adapter selection)', async () => {
    const { api, sent } = bearerApi();
    await expect(api.version()).resolves.toStrictEqual({ version: '2.11.1' });
    expect(sent[0]?.url.pathname).toBe('/api/v1/version');
  });

  it('FR-COLL-08: health() maps metadatabase and scheduler status and the heartbeat to epoch ms', async () => {
    const { api } = bearerApi();
    await expect(api.health()).resolves.toStrictEqual({
      metadatabase: 'healthy',
      scheduler: { status: 'healthy', latestHeartbeat: Date.UTC(2026, 10, 5, 21, 59, 58, 123) },
    });
  });

  it('FR-COLL-08: health() reports null for a scheduler that never sent a heartbeat', async () => {
    const { api } = bearerApi({
      '/api/v1/health': {
        body: {
          metadatabase: { status: 'unhealthy' },
          scheduler: { status: 'unhealthy', latest_scheduler_heartbeat: null },
        },
      },
    });
    await expect(api.health()).resolves.toStrictEqual({
      metadatabase: 'unhealthy',
      scheduler: { status: 'unhealthy', latestHeartbeat: null },
    });
  });
});

describe('FR-COLL-08 DAG inventory', () => {
  it('FR-COLL-08: dags() sends limit and offset and returns the page with total_entries', async () => {
    const { api, sent } = bearerApi();
    const page = await api.dags({ limit: 100, offset: 200 });
    expect(sent[0]?.url.pathname).toBe('/api/v1/dags');
    expect([...(sent[0]?.url.searchParams.entries() ?? [])]).toEqual([
      ['limit', '100'],
      ['offset', '200'],
    ]);
    expect(page.total).toBe(2003);
    expect(page.items).toHaveLength(5);
    expect(page.items[0]).toStrictEqual({
      dagId: 'acme_orders_fan_out',
      fileloc: '/home/airflow/gcs/dags/acme_orders_fan_out.py',
      owners: ['acme-data', 'acme-ops'],
      tags: ['acme', 'fan-out'],
      schedule: '*/10 * * * *',
      paused: false,
      active: true,
      maxActiveTasks: 16,
      maxActiveRuns: 1,
    });
  });

  it('FR-COLL-08: maps every schedule_interval shape of the 2.11.1 OpenAPI spec to the text Airflow shows', async () => {
    const { api } = bearerApi();
    const { items } = await api.dags({ limit: 100, offset: 0 });
    expect(items.map((d) => [d.dagId, d.schedule])).toEqual([
      ['acme_orders_fan_out', '*/10 * * * *'],
      // TimeDelta: Python's str(timedelta), which is the delta timetable's summary.
      ['acme_partner_sensor', '1 day, 2:30:00'],
      // RelativeDelta: dateutil's repr, likewise.
      ['acme_monthly_report', 'relativedelta(months=+1)'],
      ['acme_manual_backfill', null],
      // Dataset-triggered and custom timetables arrive as a CronExpression holding the summary.
      ['acme_orders_on_dataset', 'Dataset'],
    ]);
    expect(items[2]).toMatchObject({ paused: true, tags: [], maxActiveTasks: null, maxActiveRuns: null });
  });

  it('FR-COLL-08: formats timedeltas and relativedeltas exactly as Python does', async () => {
    const dag = (schedule_interval: unknown) => ({
      dag_id: 'acme_x',
      fileloc: '/dags/acme_x.py',
      owners: [],
      is_paused: false,
      is_active: true,
      schedule_interval,
      timetable_description: 'acme description',
      tags: [],
      max_active_tasks: 16,
      max_active_runs: 16,
    });
    const shapes: Array<[unknown, string | null]> = [
      [{ __type: 'TimeDelta', days: 0, seconds: 420, microseconds: 0 }, '0:07:00'],
      [{ __type: 'TimeDelta', days: 2, seconds: 0, microseconds: 0 }, '2 days, 0:00:00'],
      [{ __type: 'TimeDelta', days: 0, seconds: 59, microseconds: 1500 }, '0:00:59.001500'],
      [{ __type: 'TimeDelta', days: -1, seconds: 86399, microseconds: 0 }, '-1 day, 23:59:59'],
      [
        {
          __type: 'RelativeDelta',
          years: 0,
          months: 0,
          days: -3,
          leapdays: 0,
          hours: 6,
          minutes: 0,
          seconds: 0,
          microseconds: 0,
          year: null,
          month: null,
          day: 1,
          hour: 4,
          minute: null,
          second: null,
          microsecond: null,
        },
        'relativedelta(days=-3, hours=+6, day=1, hour=4)',
      ],
      [{ __type: 'CronExpression', value: '@daily' }, '@daily'],
      // Not in the 2.11.1 spec: fall back to Airflow's own description rather than fail the page.
      [{ __type: 'AcmeFutureType', value: 1 }, 'acme description'],
    ];
    const { api } = bearerApi({
      '/api/v1/dags': { body: { dags: shapes.map(([s]) => dag(s)), total_entries: shapes.length } },
    });
    const { items } = await api.dags({ limit: 100, offset: 0 });
    expect(items.map((d) => d.schedule)).toEqual(shapes.map(([, text]) => text));
  });

  it('FR-COLL-08: uses timetable_description when the response has no schedule_interval at all', async () => {
    const { api } = bearerApi({
      '/api/v1/dags': {
        body: {
          dags: [
            {
              dag_id: 'acme_x',
              fileloc: '/dags/acme_x.py',
              owners: [],
              is_paused: false,
              is_active: true,
              timetable_description: 'At 05:00 on Monday',
              tags: [],
              max_active_tasks: 16,
              max_active_runs: 16,
            },
          ],
          total_entries: 1,
        },
      },
    });
    const { items } = await api.dags({ limit: 1, offset: 0 });
    expect(items[0]?.schedule).toBe('At 05:00 on Monday');
  });

  it('FR-COLL-08: refuses a page size above 100 or a negative offset without sending anything (Appendix B.1)', async () => {
    const { api, sent } = bearerApi();
    await expect(api.dags({ limit: 101, offset: 0 })).rejects.toThrow(RangeError);
    await expect(api.dags({ limit: 0, offset: 0 })).rejects.toThrow(RangeError);
    await expect(api.dags({ limit: 10, offset: -1 })).rejects.toThrow(RangeError);
    expect(sent).toHaveLength(0);
  });
});

describe('FR-COLL-08 pools and import errors', () => {
  it('FR-COLL-08: pools() maps running, queued, open, scheduled and deferred slots', async () => {
    const { api, sent } = bearerApi();
    const pools = await api.pools();
    expect(sent[0]?.url.searchParams.get('limit')).toBe('100');
    expect(pools).toStrictEqual([
      {
        name: 'acme_small_pool',
        slots: 2,
        runningSlots: 1,
        queuedSlots: 1,
        openSlots: 0,
        scheduledSlots: 4,
        deferredSlots: 0,
      },
      {
        name: 'default_pool',
        slots: 128,
        runningSlots: 4,
        queuedSlots: 2,
        openSlots: 122,
        scheduledSlots: 22,
        deferredSlots: 0,
      },
    ]);
  });

  it('FR-COLL-08: pools() reports null scheduled and deferred slots when the API omits them', async () => {
    const { api } = bearerApi({
      '/api/v1/pools': {
        body: {
          pools: [{ name: 'acme_pool', slots: 4, running_slots: 1, queued_slots: 0, open_slots: 3 }],
          total_entries: 1,
        },
      },
    });
    await expect(api.pools()).resolves.toStrictEqual([
      {
        name: 'acme_pool',
        slots: 4,
        runningSlots: 1,
        queuedSlots: 0,
        openSlots: 3,
        scheduledSlots: null,
        deferredSlots: null,
      },
    ]);
  });

  it('FR-COLL-08: pools() pages through /pools 100 at a time until total_entries', async () => {
    const pool = (i: number) => ({
      name: `acme_pool_${i}`,
      slots: 1,
      running_slots: 0,
      queued_slots: 0,
      open_slots: 1,
      scheduled_slots: 0,
      deferred_slots: 0,
    });
    const { api, sent } = bearerApi({
      '/api/v1/pools': (req) => {
        const offset = Number(req.url.searchParams.get('offset'));
        const count = Math.max(0, Math.min(100, 150 - offset));
        return {
          body: { pools: Array.from({ length: count }, (_, i) => pool(offset + i)), total_entries: 150 },
        };
      },
    });
    const pools = await api.pools();
    expect(pools).toHaveLength(150);
    expect(new Set(pools.map((p) => p.name)).size).toBe(150);
    expect(sent.map((r) => [r.url.searchParams.get('limit'), r.url.searchParams.get('offset')])).toEqual([
      ['100', '0'],
      ['100', '100'],
    ]);
  });

  it('FR-COLL-08: pools() stops on an empty page even if total_entries promises more', async () => {
    const { api, sent } = bearerApi({ '/api/v1/pools': { body: { pools: [], total_entries: 500 } } });
    await expect(api.pools()).resolves.toEqual([]);
    expect(sent).toHaveLength(1);
  });

  it('FR-COLL-08: pools() stops after 50 pages when the server ignores offset', async () => {
    const { api, sent } = bearerApi({
      '/api/v1/pools': {
        body: {
          pools: [{ name: 'acme_pool', slots: 4, running_slots: 1, queued_slots: 0, open_slots: 3 }],
          total_entries: 100_000,
        },
      },
    });
    const pools = await api.pools();
    expect(sent).toHaveLength(50);
    expect(pools).toHaveLength(1);
  });

  it('FR-COLL-08: importErrorCount() reads total_entries with limit=1', async () => {
    const { api, sent } = bearerApi();
    await expect(api.importErrorCount()).resolves.toBe(3);
    expect(sent[0]?.url.pathname).toBe('/api/v1/importErrors');
    expect(sent[0]?.url.searchParams.get('limit')).toBe('1');
  });
});

describe('FR-COLL-08 task instances', () => {
  it('FR-COLL-08: queries /dags/~/dagRuns/~/taskInstances with repeated state and a closed updated_at window', async () => {
    const { api, sent } = bearerApi();
    await api.taskInstances({
      states: ['success', 'failed', 'upstream_failed', 'skipped'],
      updatedFrom: Date.UTC(2026, 10, 5, 21, 0, 0),
      updatedTo: Date.UTC(2026, 10, 5, 21, 5, 0, 500),
      limit: 100,
      offset: 300,
    });
    const url = sent[0]?.url;
    expect(url?.pathname).toBe('/api/v1/dags/~/dagRuns/~/taskInstances');
    expect(url?.searchParams.getAll('state')).toEqual(['success', 'failed', 'upstream_failed', 'skipped']);
    expect(url?.searchParams.get('updated_at_gte')).toBe('2026-11-05T21:00:00.000Z');
    expect(url?.searchParams.get('updated_at_lte')).toBe('2026-11-05T21:05:00.500Z');
    expect(url?.searchParams.get('limit')).toBe('100');
    expect(url?.searchParams.get('offset')).toBe('300');
  });

  it('FR-COLL-08: leaves out the filters a query does not set', async () => {
    const { api, sent } = bearerApi();
    await api.taskInstances({ limit: 50, offset: 0 });
    expect([...(sent[0]?.url.searchParams.keys() ?? [])]).toEqual(['limit', 'offset']);
  });

  it('FR-COLL-08: maps task instances with times in epoch ms and an empty hostname as null', async () => {
    const { api } = bearerApi();
    const page = await api.taskInstances({ limit: 100, offset: 0 });
    expect(page.total).toBe(431);
    expect(page.items).toStrictEqual([
      {
        dagId: 'acme_orders_fan_out',
        runId: 'scheduled__2026-11-05T21:40:00+00:00',
        taskId: 'acme_load_shard_07',
        mapIndex: -1,
        tryNumber: 1,
        state: 'success',
        pool: 'default_pool',
        poolSlots: 1,
        priorityWeight: 3,
        operator: 'PythonOperator',
        queue: 'default',
        hostname: 'acme-worker-1',
        queuedAt: Date.UTC(2026, 10, 5, 21, 50, 1),
        startAt: Date.UTC(2026, 10, 5, 21, 50, 3, 250),
        endAt: Date.UTC(2026, 10, 5, 21, 50, 9, 750),
      },
      {
        dagId: 'acme_partner_sensor',
        runId: 'manual__2026-11-05T21:30:00+00:00',
        taskId: 'acme_wait_for_partner_file',
        mapIndex: 3,
        tryNumber: 2,
        state: 'deferred',
        pool: 'acme_small_pool',
        poolSlots: 2,
        priorityWeight: null,
        operator: null,
        queue: null,
        hostname: null,
        queuedAt: null,
        startAt: null,
        endAt: null,
      },
    ]);
  });

  it('FR-COLL-08: drops rendered_fields, sla_miss, trigger, triggerer_job and notes at the boundary (§7.1 rule 4)', async () => {
    const { api } = bearerApi();
    const page = await api.taskInstances({ limit: 100, offset: 0 });
    const text = JSON.stringify(page);
    for (const leaked of [
      'acme-rendered-secret',
      'acme-trigger-kwargs',
      'acme operator note',
      'acme-triggerer-1',
    ])
      expect(text).not.toContain(leaked);
    for (const key of ['rendered_fields', 'renderedFields', 'sla_miss', 'trigger', 'triggerer_job', 'note'])
      expect(page.items[0]).not.toHaveProperty(key);
  });

  it('FR-COLL-08: keeps a task instance whose state is null (not yet scheduled)', async () => {
    const row = {
      ...(fixtureJson('task-instances.json') as { task_instances: Record<string, unknown>[] })
        .task_instances[0],
      state: null,
    };
    const { api } = bearerApi({
      '/api/v1/dags/~/dagRuns/~/taskInstances': { body: { task_instances: [row], total_entries: 1 } },
    });
    const page = await api.taskInstances({ limit: 100, offset: 0 });
    expect(page.items[0]?.state).toBeNull();
  });

  it('FR-COLL-08: refuses a task instance page size above 100 (Appendix B.1)', async () => {
    const { api, sent } = bearerApi();
    await expect(api.taskInstances({ limit: 1000, offset: 0 })).rejects.toThrow(RangeError);
    expect(sent).toHaveLength(0);
  });

  it('FR-COLL-08: refuses an updated_at bound outside the range of a date', async () => {
    const { api, sent } = bearerApi();
    await expect(api.taskInstances({ updatedFrom: 9e15, limit: 100, offset: 0 })).rejects.toThrow(RangeError);
    await expect(api.taskInstances({ updatedTo: Number.NaN, limit: 100, offset: 0 })).rejects.toThrow(
      RangeError,
    );
    expect(sent).toHaveLength(0);
  });
});

describe('FR-COLL-08 privilege probe (§18.3)', () => {
  it('FR-COLL-08: canReadProviders() is true on 200: the identity has Op or higher', async () => {
    const { api, sent } = bearerApi();
    await expect(api.canReadProviders()).resolves.toBe(true);
    expect(sent[0]?.url.pathname).toBe('/api/v1/providers');
  });

  it('FR-COLL-08: canReadProviders() is false on 403: Viewer cannot read providers', async () => {
    const { api } = answering({ status: 403, body: { title: 'Forbidden', status: 403 } });
    await expect(api.canReadProviders()).resolves.toBe(false);
  });

  it('FR-COLL-08: canReadProviders() still fails on 401', async () => {
    const { api } = answering({ status: 401, body: { title: 'Unauthorized', status: 401 } });
    expect((await failure(api.canReadProviders())).kind).toBe('unauthenticated');
  });
});

describe('FR-COLL-08 errors as SourceError', () => {
  it('FR-COLL-08: 401 is unauthenticated and invalidates the cached bearer token', async () => {
    const { api, tokens } = answering({ status: 401, body: { title: 'Unauthorized', status: 401 } });
    const error = await failure(api.pools());
    expect(error).toMatchObject({ kind: 'unauthenticated', transient: false, details: { status: 401 } });
    expect(error.details.fixHint).toMatch(/gcloud auth application-default login/);
    expect(tokens.calls.invalidate).toBe(1);
  });

  it('FR-COLL-08: the next call after a 401 uses a fresh token', async () => {
    let first = true;
    const { api, sent } = answering(() => {
      if (first) {
        first = false;
        return { status: 401, body: { title: 'Unauthorized', status: 401 } };
      }
      return { body: { version: '2.11.1', git_version: null } };
    });
    await failure(api.version());
    await api.version();
    expect(sent.map((r) => r.headers['authorization'])).toEqual([
      'Bearer acme-token-1',
      'Bearer acme-token-2',
    ]);
  });

  it('FR-COLL-08: 403 is forbidden and says to ask for the Airflow Viewer role', async () => {
    const { api, tokens } = answering({ status: 403, body: { title: 'Forbidden', status: 403 } });
    const error = await failure(api.dags({ limit: 100, offset: 0 }));
    expect(error).toMatchObject({ kind: 'forbidden', details: { status: 403 } });
    expect(error.details.fixHint).toMatch(/administrator/);
    expect(error.details.fixHint).toMatch(/Viewer/);
    expect(tokens.calls.invalidate).toBe(0);
  });

  it('FR-COLL-08: 404 is not-found and mentions Airflow 3, which has no /api/v1', async () => {
    const { api } = answering({ status: 404, body: { title: 'Not Found', status: 404 } });
    const error = await failure(api.version());
    expect(error).toMatchObject({ kind: 'not-found', details: { status: 404 } });
    expect(error.details.fixHint).toMatch(/Airflow 3/);
  });

  it('FR-COLL-06: 429 is rate-limited and carries Retry-After in seconds as milliseconds', async () => {
    const { api } = answering({ status: 429, headers: { 'Retry-After': '30' }, body: '' });
    const error = await failure(api.health());
    expect(error).toMatchObject({
      kind: 'rate-limited',
      transient: true,
      details: { status: 429, retryAfterMs: 30_000 },
    });
  });

  it('FR-COLL-06: Retry-After as an HTTP date is measured from now', async () => {
    const { http } = fakeHttp(() => ({
      status: 503,
      headers: { 'retry-after': 'Thu, 05 Nov 2026 22:01:00 GMT' },
      body: '<html>acme-body-secret</html>',
    }));
    const api = createAirflowV1Api({
      http,
      baseUrl: COMPOSER,
      auth: { kind: 'bearer', tokens: fakeTokens('acme-token') },
      now: () => Date.UTC(2026, 10, 5, 22, 0, 0),
    });
    const error = await failure(api.health());
    expect(error).toMatchObject({ kind: 'unavailable', details: { status: 503, retryAfterMs: 60_000 } });
  });

  it('FR-COLL-06: 429 without Retry-After has no retryAfterMs', async () => {
    const { api } = answering({ status: 429, body: '' });
    const error = await failure(api.health());
    expect(error.details.retryAfterMs).toBeUndefined();
  });

  it.each([500, 502, 503, 504])('FR-COLL-06: %i is unavailable and transient', async (status) => {
    const { api } = answering({ status, body: 'acme-body-secret' });
    const error = await failure(api.pools());
    expect(error).toMatchObject({ kind: 'unavailable', transient: true, details: { status } });
  });

  it('FR-COLL-08: another 4xx (DCAM sent a request the API refused) is invalid-response', async () => {
    const { api } = answering({
      status: 400,
      body: { title: 'Bad Request', detail: 'acme-body-secret', status: 400 },
    });
    const error = await failure(api.importErrorCount());
    expect(error).toMatchObject({ kind: 'invalid-response', details: { status: 400 } });
  });

  it('FR-COLL-08: a body that is not JSON is invalid-response', async () => {
    const { api } = answering({ status: 200, body: '<html>acme-body-secret sign in</html>' });
    const error = await failure(api.version());
    expect(error).toMatchObject({ kind: 'invalid-response', details: { status: 200 } });
  });

  it('FR-COLL-08: a body that does not match the schema is invalid-response and names the field, not the value', async () => {
    const { api } = answering({
      body: { task_instances: [{ dag_id: 'acme-body-secret' }], total_entries: 1 },
    });
    const error = await failure(api.taskInstances({ limit: 100, offset: 0 }));
    expect(error.kind).toBe('invalid-response');
    expect(error.message).toMatch(/task_instances\.0\.dag_run_id/);
    expect(error.message).not.toContain('acme-body-secret');
  });

  it('FR-COLL-08: an unparseable timestamp is invalid-response', async () => {
    const { api } = answering({
      body: {
        metadatabase: { status: 'healthy' },
        scheduler: { status: 'healthy', latest_scheduler_heartbeat: 'acme-not-a-time' },
      },
    });
    expect((await failure(api.health())).kind).toBe('invalid-response');
  });

  it('FR-COLL-08: error messages never contain response bodies, and nothing is logged', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const replies: Reply[] = [
      { status: 400, body: { title: 'Bad Request', detail: 'acme-body-secret', status: 400 } },
      { status: 403, body: { title: 'Forbidden', detail: 'acme-body-secret', status: 403 } },
      { status: 500, body: 'acme-body-secret' },
      { status: 200, body: 'acme-body-secret' },
      { status: 200, body: { version: 42, detail: 'acme-body-secret' } },
    ];
    for (const reply of replies) {
      const { api } = answering(reply);
      const error = await failure(api.version());
      expect(JSON.stringify({ message: error.message, details: error.details })).not.toContain(
        'acme-body-secret',
      );
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe('FR-COLL-08 transport failures', () => {
  it('FR-COLL-08: a redirect refused by the guard is unauthenticated with a sign-in hint', async () => {
    const http = createGuardedClient({
      network: 'any',
      transport: async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://accounts.google.com/o/oauth2/auth' },
        }),
    });
    const tokens = fakeTokens('t');
    const api = createAirflowV1Api({ http, baseUrl: COMPOSER, auth: { kind: 'bearer', tokens } });
    const error = await failure(api.version());
    expect(error.kind).toBe('unauthenticated');
    expect(error.message).toMatch(/redirect/i);
    // FR-AUTH-01: the rejected token is not reused after the user signs in again.
    expect(tokens.calls.invalidate).toBe(1);
    expect(error.details.fixHint).toMatch(/sign-in/);
  });

  it('FR-COLL-08: any other guard rejection is a guard error', async () => {
    const { http } = fakeHttp(() => {
      throw new GuardError('not-allowlisted', 'GET /api/v1/config is not an allowed read');
    });
    const api = createAirflowV1Api({
      http,
      baseUrl: COMPOSER,
      auth: { kind: 'bearer', tokens: fakeTokens('t') },
    });
    const error = await failure(api.version());
    expect(error.kind).toBe('guard');
    expect(error.transient).toBe(false);
  });

  it('FR-COLL-08: a SourceError from the client (timeout, network) passes through unchanged', async () => {
    const original = new SourceError('timeout', 'GET timed out after 20000 ms');
    const { http } = fakeHttp(() => {
      throw original;
    });
    const api = createAirflowV1Api({
      http,
      baseUrl: COMPOSER,
      auth: { kind: 'bearer', tokens: fakeTokens('t') },
    });
    await expect(api.version()).rejects.toBe(original);
  });

  it('FR-COLL-08: a failure while reading the body is a transport failure, not invalid-response', async () => {
    const reading = (error: unknown) => {
      const http: ReadOnlyHttp = {
        request: async () => ({
          status: 200,
          headers: { get: () => null },
          text: async () => {
            throw error;
          },
        }),
      };
      return createAirflowV1Api({
        http,
        baseUrl: COMPOSER,
        auth: { kind: 'bearer', tokens: fakeTokens('t') },
      });
    };
    const timeout = new SourceError('timeout', 'GET timed out after 20000 ms');
    await expect(reading(timeout).pools()).rejects.toBe(timeout);
    const reset = await failure(reading(new TypeError('terminated')).version());
    expect(reset).toMatchObject({ kind: 'network', transient: true });
  });

  it('FR-COLL-08: a raw fetch failure is network, an abort is timeout', async () => {
    const throwing = (error: unknown) => {
      const { http } = fakeHttp(() => {
        throw error;
      });
      return createAirflowV1Api({
        http,
        baseUrl: COMPOSER,
        auth: { kind: 'bearer', tokens: fakeTokens('t') },
      });
    };
    expect((await failure(throwing(new TypeError('fetch failed')).version())).kind).toBe('network');
    expect(
      (await failure(throwing(new DOMException('The operation timed out.', 'TimeoutError')).version())).kind,
    ).toBe('timeout');
  });

  it('FR-COLL-08: a failure to get a token is unauthenticated and sends nothing', async () => {
    const { http, sent } = fakeHttp(routes(FIXTURES));
    const api = createAirflowV1Api({
      http,
      baseUrl: COMPOSER,
      auth: {
        kind: 'bearer',
        tokens: {
          accessToken: async () => {
            throw new SourceError('unauthenticated', 'no credentials', {
              fixHint: 'Run gcloud auth application-default login.',
            });
          },
          invalidate: () => undefined,
        },
      },
    });
    expect((await failure(api.version())).kind).toBe('unauthenticated');
    expect(sent).toHaveLength(0);
  });
});
