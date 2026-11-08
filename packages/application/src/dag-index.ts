/**
 * Use case: the DAG index of one environment for the command palette (FR-UI-03). It reads the DAG
 * inventory only, never task history, so the palette can list 5,000 DAGs without the league's HM-003
 * sweep. Sorted by DAG ID in code point order, the same in every locale.
 *
 * @implements FR-UI-03, NFR-PERF
 */
import type { DagIndex } from '@dcam/contracts';
import type { EnvironmentModelSource } from '@dcam/ports';

export interface DagIndexDeps {
  readonly model: Pick<EnvironmentModelSource, 'dags'>;
}

export interface DagIndexQuery {
  readonly envId: string;
}

const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export async function getDagIndex(deps: DagIndexDeps, q: DagIndexQuery): Promise<DagIndex> {
  const dags = await deps.model.dags(q.envId);
  return {
    env_id: q.envId,
    dags: dags
      .map((d) => ({ dag_id: d.dagId, team: d.team, paused: d.paused }))
      .sort((a, b) => byCodePoint(a.dag_id, b.dag_id)),
  };
}
