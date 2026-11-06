import { describe, expect, it } from 'vitest';
import { afInventoryCollector } from '../../src/index';
import {
  Budget,
  composerEntry,
  dag,
  emulatorEntry,
  fakeContext,
  FakeAirflow,
  H,
  MemoryStore,
  T0,
} from './collectors-harness';

const manyDags = (n: number) =>
  Array.from({ length: n }, (_, i) => dag({ dagId: `acme_dag_${String(i).padStart(4, '0')}` }));
const shared = { airflowBaseUrl: 'https://acme-composer-prod.example.test' };

describe('FR-COLL-08 af.inventory: version', () => {
  it('FR-COLL-08: reads GET /version into the shared state once a day', async () => {
    const airflow = new FakeAirflow();
    const collector = afInventoryCollector();
    const ctx = fakeContext({ airflow, shared });
    await collector.collect(ctx);
    expect(ctx.shared.airflowVersion).toBe('2.11.1');
    ctx.advance(H);
    await collector.collect(ctx);
    expect(airflow.calls.filter((c) => c === 'version')).toHaveLength(1);
    ctx.advance(24 * H);
    await collector.collect(ctx);
    expect(airflow.calls.filter((c) => c === 'version')).toHaveLength(2);
  });

  it('FR-COLL-08: an Airflow 3 environment is reported as unsupported until M4', async () => {
    const airflow = new FakeAirflow({ version: '3.1.8', dags: manyDags(3) });
    const store = new MemoryStore();
    const ctx = fakeContext({ airflow, store, shared });
    await expect(afInventoryCollector().collect(ctx)).rejects.toMatchObject({
      kind: 'unsupported',
      message: 'Airflow 3 environments are supported from M4',
    });
    expect(ctx.shared.airflowVersion).toBe('3.1.8');
    expect(airflow.calls).toEqual(['version']);
    expect(await store.dags('acme-prod')).toEqual([]);
  });
});

describe('FR-COLL-06 af.inventory: DAG paging within the budget', () => {
  it('FR-COLL-06: pages /dags 100 at a time, stops at maxRequestsPerCycle and resumes next cycle', async () => {
    const airflow = new FakeAirflow({ dags: manyDags(2_000) });
    const store = new MemoryStore();
    const collector = afInventoryCollector();
    const max = collector.manifest.maxRequestsPerCycle;
    const ctx = fakeContext({ airflow, store, shared });

    await collector.collect(ctx);
    expect(airflow.calls.length).toBeLessThanOrEqual(max);
    expect(ctx.fidelity).toHaveLength(1);
    const afterFirst = (await store.dags('acme-prod')).length;
    expect(afterFirst).toBeGreaterThan(0);
    expect(afterFirst).toBeLessThan(2_000);

    let cycles = 1;
    while ((await store.dags('acme-prod')).length < 2_000 && cycles < 10) {
      ctx.advance(10 * 60_000);
      await collector.collect(ctx);
      cycles++;
    }
    const pages = airflow.calls.filter((c) => c.startsWith('dags:'));
    expect(pages).toHaveLength(20);
    expect(new Set(pages).size).toBe(20);
    expect((await store.dags('acme-prod')).length).toBe(2_000);
  });

  it('FR-COLL-06: a server that returns pages smaller than 100 skips no DAG (spec §7.5, VC-11 open)', async () => {
    const airflow = new FakeAirflow({ dags: manyDags(2_000) });
    airflow.pageCap = 50;
    const store = new MemoryStore();
    const collector = afInventoryCollector();
    const ctx = fakeContext({ airflow, store, shared });
    // Until the pass is complete, every cycle reports that the listing continues.
    for (let cycles = 0; cycles < 10; cycles++) {
      const notes = ctx.fidelity.length;
      await collector.collect(ctx);
      ctx.advance(10 * 60_000);
      if (ctx.fidelity.length === notes) break;
    }
    const offsets = airflow.calls.filter((c) => c.startsWith('dags:')).map((c) => Number(c.slice(5)));
    expect(offsets).toEqual(Array.from({ length: 40 }, (_, i) => i * 50));
    expect((await store.dags('acme-prod')).length).toBe(2_000);
  });

  it('FR-COLL-06: an exhausted budget mid-listing keeps what was read and reports reduced fidelity', async () => {
    const airflow = new FakeAirflow({ dags: manyDags(450) }, new Budget('airflow', 4));
    const store = new MemoryStore();
    const ctx = fakeContext({ airflow, store, shared });
    const result = await afInventoryCollector().collect(ctx);
    // version, import errors and two pages fit in the budget of 4.
    expect((await store.dags('acme-prod')).length).toBe(200);
    expect(ctx.fidelity).toHaveLength(1);
    expect(result.dataAsOf).toBe(T0);
  });

  it('FR-COLL-03: a complete listing replaces the DAG set, so deleted and inactive DAGs drop out', async () => {
    const airflow = new FakeAirflow({ dags: manyDags(3) });
    const store = new MemoryStore();
    const collector = afInventoryCollector();
    const ctx = fakeContext({ airflow, store, shared });
    await collector.collect(ctx);
    expect((await store.dags('acme-prod')).map((d) => d.dagId)).toEqual([
      'acme_dag_0000',
      'acme_dag_0001',
      'acme_dag_0002',
    ]);
    airflow.data.dags = [dag({ dagId: 'acme_dag_0000' }), dag({ dagId: 'acme_dag_0002', active: false })];
    ctx.advance(10 * 60_000);
    await collector.collect(ctx);
    expect((await store.dags('acme-prod')).map((d) => d.dagId)).toEqual(['acme_dag_0000']);
    expect(ctx.fidelity).toEqual([]);
  });
});

describe('FR-DAGX-08 af.inventory: DAG metadata as the signals read it', () => {
  it('FR-DAGX-08: maps team, unscheduled DAGs, default limits and catchup', async () => {
    const airflow = new FakeAirflow({
      dags: [
        dag({ dagId: 'acme_tagged', tags: ['orders', 'team:finance-data'], owners: ['someone'] }),
        dag({ dagId: 'acme_owned', tags: [], owners: ['airflow', 'customer'] }),
        dag({ dagId: 'acme_orphan', tags: [], owners: ['airflow'], schedule: null }),
        dag({ dagId: 'acme_defaults', maxActiveTasks: null, maxActiveRuns: null, paused: true }),
      ],
    });
    const store = new MemoryStore();
    await afInventoryCollector().collect(fakeContext({ airflow, store, shared }));
    const byId = new Map((await store.dags('acme-prod')).map((d) => [d.dagId, d]));
    expect(byId.get('acme_tagged')?.team).toBe('finance-data');
    expect(byId.get('acme_owned')?.team).toBe('customer');
    expect(byId.get('acme_orphan')).toMatchObject({ team: 'unassigned', schedule: 'None' });
    expect(byId.get('acme_defaults')).toMatchObject({
      maxActiveTasks: 16,
      maxActiveRuns: 25,
      catchup: true,
      paused: true,
    });
    expect(byId.get('acme_tagged')).toEqual({
      dagId: 'acme_tagged',
      fileloc: '/home/airflow/gcs/dags/orders/acme_orders_daily.py',
      owners: ['someone'],
      tags: ['orders', 'team:finance-data'],
      team: 'finance-data',
      schedule: '0 2 * * *',
      maxActiveTasks: 16,
      maxActiveRuns: 25,
      catchup: true,
      paused: false,
    });
  });

  it('FR-DAGX-08: DAGs without their own limits take the emulator limits from the configuration', async () => {
    const airflow = new FakeAirflow({ dags: [dag({ maxActiveTasks: null, maxActiveRuns: null })] });
    const store = new MemoryStore();
    await afInventoryCollector().collect(fakeContext({ env: emulatorEntry, airflow, store }));
    expect((await store.dags('acme-emulator'))[0]).toMatchObject({ maxActiveTasks: 16, maxActiveRuns: 16 });
  });
});

describe('HM-028 af.inventory: import errors', () => {
  it('HM-028: stores the import error count without touching the other health inputs', async () => {
    const airflow = new FakeAirflow({ importErrors: 3 });
    const store = new MemoryStore();
    const before = await store.platformHealth('acme-prod');
    await store.savePlatformHealth('acme-prod', { ...before, envHealthyRatio: 0.98 });
    await afInventoryCollector().collect(fakeContext({ airflow, store, shared }));
    expect(await store.platformHealth('acme-prod')).toMatchObject({ importErrors: 3, envHealthyRatio: 0.98 });
  });

  it('FR-COLL-01: declares a background Airflow collector for Composer and self-managed Airflow', () => {
    expect(afInventoryCollector().manifest).toMatchObject({
      id: 'af.inventory',
      source: 'SRC-AF-API',
      api: 'airflow',
      cadence: 'airflowInventory',
      priority: 'background',
      outputs: ['dags', 'health'],
      sourceKinds: ['composer', 'airflow'],
    });
    expect(composerEntry.source.kind).toBe('composer');
  });
});
