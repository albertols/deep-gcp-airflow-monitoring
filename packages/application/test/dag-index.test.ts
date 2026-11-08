import { describe, expect, it } from 'vitest';
import type { DagMeta } from '@dcam/domain';
import type { EnvironmentModelSource } from '@dcam/ports';
import { getDagIndex } from '../src/index';

const dag = (dagId: string, team: string, paused = false): DagMeta => ({
  dagId,
  fileloc: `/home/airflow/gcs/dags/${dagId}.py`,
  owners: ['acme'],
  tags: [],
  team,
  schedule: '@daily',
  maxActiveTasks: 16,
  maxActiveRuns: 16,
  catchup: false,
  paused,
});

const unused = () => Promise.reject(new Error('the DAG index reads the inventory only'));
const model = (dags: DagMeta[]): EnvironmentModelSource => ({
  config: unused,
  dags: async (envId) => (envId === 'acme-prod' ? dags : []),
  snapshots: unused,
  workerSamples: unused,
  platformHealth: unused,
});

describe('FR-UI-03 DAG index for the command palette', () => {
  it('FR-UI-03: lists every DAG of the inventory with its team and paused flag, sorted by ID', async () => {
    const index = await getDagIndex(
      { model: model([dag('acme_orders_daily', 'finance'), dag('acme_billing', 'finance', true)]) },
      { envId: 'acme-prod' },
    );
    expect(index).toEqual({
      env_id: 'acme-prod',
      dags: [
        { dag_id: 'acme_billing', team: 'finance', paused: true },
        { dag_id: 'acme_orders_daily', team: 'finance', paused: false },
      ],
    });
  });

  it('FR-UI-03: an environment without an inventory yet has no DAGs, not an error', async () => {
    expect(await getDagIndex({ model: model([]) }, { envId: 'acme-dev' })).toEqual({
      env_id: 'acme-dev',
      dags: [],
    });
  });

  it('FR-UI-03 / NFR-PERF: sorts 5,000 DAGs by code point, the same order in every locale', async () => {
    const many = Array.from({ length: 5_000 }, (_, i) => dag(`acme_${(i * 7919) % 5_000}`, 'acme'));
    const index = await getDagIndex(
      { model: model([...many, dag('Acme_upper', 'acme')]) },
      { envId: 'acme-prod' },
    );
    expect(index.dags).toHaveLength(5_001);
    expect(index.dags[0]?.dag_id).toBe('Acme_upper');
    const ids = index.dags.map((d) => d.dag_id);
    expect(ids).toEqual([...ids].sort());
  });
});
