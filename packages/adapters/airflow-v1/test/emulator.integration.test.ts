/**
 * The airflow-v1 adapter against the local Airflow 2.11.1 emulator (tools/emulator, FR-EMU-02).
 * Opt-in: `pnpm emulator:up`, then `pnpm emulator:test` (sets DCAM_EMULATOR=1). Requests go through the
 * real guarded client with the emulator registered as a loopback Airflow host, so DCAM_NETWORK=
 * loopback-only still holds.
 */
import { describe, expect, it } from 'vitest';
import { createGuardedClient, networkModeFromEnv } from '@dcam/http-guard';
import { SourceError, type AirflowApi, type AirflowTaskInstance } from '@dcam/ports';
import { createAirflowV1Api } from '../src/index';

const env = process.env;
const enabled = env['DCAM_EMULATOR'] === '1';
const baseUrl = env['DCAM_EMULATOR_URL'] ?? 'http://127.0.0.1:8080';
// Defaults match tools/emulator/docker-compose.yaml.
const viewer = {
  username: env['DCAM_EMULATOR_USER'] ?? 'acme_viewer',
  password: env['DCAM_EMULATOR_PASSWORD'] ?? 'acme_viewer',
};
const admin = {
  username: env['DCAM_EMULATOR_ADMIN_USER'] ?? 'airflow',
  password: env['DCAM_EMULATOR_ADMIN_PASSWORD'] ?? 'airflow',
};

const ACME_DAGS = [
  'acme_ledger_small_pool',
  'acme_manual_backfill',
  'acme_orders_fan_out',
  'acme_partner_sensor',
];
const NON_TERMINAL = ['scheduled', 'queued', 'running'];
const FINISHED = ['success', 'failed', 'upstream_failed', 'skipped'];

function airflow(user: { username: string; password: string }): AirflowApi {
  const http = createGuardedClient({
    network: networkModeFromEnv(env),
    hosts: { airflow: [new URL(baseUrl).host] },
  });
  return createAirflowV1Api({ http, baseUrl, auth: { kind: 'basic', ...user } });
}

/** Polls until `probe` returns a value: the emulator's DAGs produce data within minutes of start-up. */
async function eventually<T>(
  what: string,
  probe: () => Promise<T | undefined>,
  timeoutMs = 540_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

function expectWellFormed(ti: AirflowTaskInstance): void {
  expect(ti.dagId).toMatch(/^acme_/);
  expect(ti.taskId).toMatch(/^acme_/);
  expect(ti.runId.length).toBeGreaterThan(0);
  expect(Number.isInteger(ti.tryNumber)).toBe(true);
  expect(ti.mapIndex).toBe(-1);
  expect(['default_pool', 'acme_small_pool']).toContain(ti.pool);
  expect(Object.keys(ti).sort()).toEqual(
    [
      'dagId',
      'runId',
      'taskId',
      'mapIndex',
      'tryNumber',
      'state',
      'pool',
      'poolSlots',
      'priorityWeight',
      'operator',
      'queue',
      'hostname',
      'queuedAt',
      'startAt',
      'endAt',
    ].sort(),
  );
}

describe.skipIf(!enabled)('FR-EMU-02 airflow-v1 adapter against the Airflow 2.11.1 emulator', () => {
  const api = airflow(viewer);

  it('FR-EMU-02: reads the version', async () => {
    await expect(api.version()).resolves.toEqual({ version: '2.11.1' });
  });

  it('FR-EMU-02: reads health: metadatabase and scheduler healthy, heartbeat recent', async () => {
    const health = await eventually('a healthy scheduler', async () => {
      const h = await api.health();
      return h.scheduler.status === 'healthy' ? h : undefined;
    });
    expect(health.metadatabase).toBe('healthy');
    expect(Date.now() - (health.scheduler.latestHeartbeat ?? 0)).toBeLessThan(120_000);
  });

  it('FR-EMU-02: lists the acme DAGs with their schedules, page by page', async () => {
    const first = await eventually('the acme DAGs to be parsed', async () => {
      const page = await api.dags({ limit: 100, offset: 0 });
      const ids = page.items.map((d) => d.dagId);
      return ACME_DAGS.every((id) => ids.includes(id)) ? page : undefined;
    });
    const byId = new Map(first.items.map((d) => [d.dagId, d]));
    expect(byId.get('acme_orders_fan_out')).toMatchObject({
      schedule: '*/10 * * * *',
      paused: false,
      active: true,
      owners: ['acme-data'],
      tags: expect.arrayContaining(['acme', 'fan-out']),
      maxActiveRuns: 1,
      maxActiveTasks: 16,
    });
    expect(byId.get('acme_ledger_small_pool')?.schedule).toBe('0:07:00');
    expect(byId.get('acme_manual_backfill')?.schedule).toBeNull();
    expect(byId.get('acme_partner_sensor')?.fileloc).toBe('/opt/airflow/dags/acme_partner_sensor.py');
    // The broken file has no DAG; paging returns every DAG exactly once.
    expect(byId.has('acme_broken')).toBe(false);
    const paged = [
      ...(await api.dags({ limit: 2, offset: 0 })).items,
      ...(await api.dags({ limit: 2, offset: 2 })).items,
    ].map((d) => d.dagId);
    expect(new Set(paged).size).toBe(paged.length);
    expect(first.total).toBe(first.items.length);
  });

  it('FR-EMU-02: lists the pools, including acme_small_pool with 2 slots', async () => {
    const pools = await api.pools();
    expect(pools.find((p) => p.name === 'acme_small_pool')).toMatchObject({ slots: 2 });
    const pool = pools.find((p) => p.name === 'default_pool');
    expect(pool?.slots).toBe(128);
    expect(pool?.scheduledSlots).not.toBeNull();
    expect(pool?.deferredSlots).not.toBeNull();
  });

  it('FR-EMU-02: counts the import error of the deliberately broken DAG file', async () => {
    const count = await eventually('the import error', async () => {
      const n = await api.importErrorCount();
      return n >= 1 ? n : undefined;
    });
    expect(count).toBe(1);
  });

  it('FR-EMU-02: reads non-terminal task instances (scheduled, queued, running) while the DAGs run', async () => {
    const page = await eventually('waiting or running task instances', async () => {
      const p = await api.taskInstances({ states: NON_TERMINAL, limit: 100, offset: 0 });
      return p.items.length > 0 ? p : undefined;
    });
    expect(page.total).toBeGreaterThanOrEqual(page.items.length);
    for (const ti of page.items) {
      expectWellFormed(ti);
      expect(NON_TERMINAL).toContain(ti.state);
      if (ti.state === 'running') expect(ti.startAt).not.toBeNull();
    }
  });

  it('FR-EMU-02: the small pool makes work wait: it fills while tasks wait as scheduled', async () => {
    const pool = await eventually('acme_small_pool to be full with work waiting', async () => {
      const p = (await api.pools()).find((x) => x.name === 'acme_small_pool');
      return p && p.openSlots === 0 && (p.scheduledSlots ?? 0) > 0 ? p : undefined;
    });
    expect(pool.runningSlots + pool.queuedSlots).toBe(2);
  });

  it('FR-EMU-02: reads finished task instances in a closed updated_at window', async () => {
    const page = await eventually('finished task instances', async () => {
      const now = Date.now();
      const p = await api.taskInstances({
        states: FINISHED,
        updatedFrom: now - 3_600_000,
        updatedTo: now,
        limit: 100,
        offset: 0,
      });
      return p.items.length > 0 ? p : undefined;
    });
    for (const ti of page.items) {
      expectWellFormed(ti);
      expect(FINISHED).toContain(ti.state);
      // Skipped and upstream_failed task instances never reached a worker.
      if (ti.state !== 'success' && ti.state !== 'failed') continue;
      expect(ti.hostname).toBe('acme-worker-1');
      expect(ti.startAt).not.toBeNull();
      expect(ti.endAt ?? 0).toBeGreaterThanOrEqual(ti.startAt ?? 0);
      expect(ti.queuedAt ?? 0).toBeLessThanOrEqual(ti.startAt ?? 0);
    }
    // A window in the future is empty.
    const later = Date.now() + 3_600_000;
    const empty = await api.taskInstances({
      updatedFrom: later,
      updatedTo: later + 60_000,
      limit: 100,
      offset: 0,
    });
    expect(empty).toEqual({ items: [], total: 0 });
  });

  it('FR-EMU-02: privilege probe: Viewer cannot read providers, Admin can (§18.3)', async () => {
    await expect(api.canReadProviders()).resolves.toBe(false);
    await expect(airflow(admin).canReadProviders()).resolves.toBe(true);
  });

  it('FR-EMU-02: a wrong password is refused with 403 and a hint to check the credentials', async () => {
    // Not /version or /health: Airflow 2.11.1 serves those without authentication
    // (no requires_access decorator in api_connexion/endpoints/{version,health}_endpoint.py). A wrong
    // password gets 403 PermissionDenied, not 401, from Airflow 2.11.1 with the FAB provider 1.5.4.
    const error: unknown = await airflow({ username: viewer.username, password: 'acme-wrong' })
      .pools()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SourceError);
    expect(error).toMatchObject({ kind: 'forbidden', details: { status: 403 } });
    expect((error as SourceError).details.fixHint).toMatch(/user name and password/);
  });
});
