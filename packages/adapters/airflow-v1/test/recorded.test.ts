/**
 * Responses recorded from the Airflow 2.11.1 emulator (tools/emulator, fictitious acme DAGs; only
 * `file_token` was replaced), so the schemas are checked against real output without Docker.
 */
import { describe, expect, it } from 'vitest';
import { createAirflowV1Api } from '../src/index';
import { fakeHttp, fixtureJson, routes } from './fake-http';

const recorded = (name: string) => ({ body: fixtureJson(`emulator/${name}`) });

function emulatorApi(taskInstances: string) {
  const { http } = fakeHttp(
    routes({
      '/api/v1/health': recorded('health.json'),
      '/api/v1/dags': recorded('dags.json'),
      '/api/v1/pools': recorded('pools.json'),
      '/api/v1/dags/~/dagRuns/~/taskInstances': recorded(taskInstances),
    }),
  );
  return createAirflowV1Api({
    http,
    baseUrl: 'http://127.0.0.1:8080',
    auth: { kind: 'basic', username: 'acme_viewer', password: 'acme_viewer' },
  });
}

describe('FR-EMU-02 responses recorded from the Airflow 2.11.1 emulator', () => {
  it('FR-EMU-02: maps the recorded DAG list, including the timedelta and unscheduled DAGs', async () => {
    const { items, total } = await emulatorApi('task-instances-live.json').dags({ limit: 100, offset: 0 });
    expect(total).toBe(4);
    expect(items.map((d) => [d.dagId, d.schedule, d.owners])).toEqual([
      ['acme_ledger_small_pool', '0:07:00', ['acme-finance']],
      ['acme_manual_backfill', null, ['acme-ops']],
      ['acme_orders_fan_out', '*/10 * * * *', ['acme-data']],
      ['acme_partner_sensor', '*/5 * * * *', ['acme-data']],
    ]);
  });

  it('FR-EMU-02: maps the recorded health and pools', async () => {
    const api = emulatorApi('task-instances-live.json');
    await expect(api.health()).resolves.toEqual({
      metadatabase: 'healthy',
      scheduler: { status: 'healthy', latestHeartbeat: Date.parse('2026-11-05T23:21:59.126Z') },
    });
    const small = (await api.pools()).find((p) => p.name === 'acme_small_pool');
    expect(small).toEqual({
      name: 'acme_small_pool',
      slots: 2,
      runningSlots: 1,
      queuedSlots: 1,
      openSlots: 0,
      scheduledSlots: 0,
      deferredSlots: 0,
    });
  });

  it('FR-EMU-02: maps recorded live task instances: a queued one has no hostname and no start yet', async () => {
    const { items } = await emulatorApi('task-instances-live.json').taskInstances({ limit: 100, offset: 0 });
    expect(items.map((t) => [t.taskId, t.state, t.hostname, t.startAt === null])).toEqual([
      ['acme_post_ledger_4', 'running', 'acme-worker-1', false],
      ['acme_post_ledger_5', 'queued', null, true],
    ]);
  });

  it('FR-EMU-02: maps recorded finished task instances with microsecond times truncated to ms', async () => {
    const { items, total } = await emulatorApi('task-instances-success.json').taskInstances({
      limit: 100,
      offset: 0,
    });
    expect(total).toBe(81);
    expect(items[0]).toEqual({
      dagId: 'acme_ledger_small_pool',
      runId: 'scheduled__2026-11-05T23:06:00+00:00',
      taskId: 'acme_post_ledger_3',
      mapIndex: -1,
      tryNumber: 1,
      state: 'success',
      pool: 'acme_small_pool',
      poolSlots: 1,
      priorityWeight: 1,
      operator: 'PythonOperator',
      queue: 'default',
      hostname: 'acme-worker-1',
      queuedAt: Date.parse('2026-11-05T23:14:25.983Z'),
      startAt: Date.parse('2026-11-05T23:14:26.794Z'),
      endAt: Date.parse('2026-11-05T23:14:47.201Z'),
    });
    expect(JSON.stringify(items)).not.toContain('op_kwargs');
  });
});
