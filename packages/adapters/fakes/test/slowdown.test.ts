import { describe, expect, it } from 'vitest';
import { percentile } from '@dcam/domain';
import { acmeScenario, simulateEnvironment, type DagBlueprint, type Scenario } from '../src/index';

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const HOUR = 3_600_000;
const SINCE = NOW - 18 * HOUR;

const prod = acmeScenario('acme-prod');
const ranking: DagBlueprint = {
  meta: {
    dagId: 'acme_ranking',
    fileloc: '/home/airflow/gcs/dags/ml-platform/acme_ranking.py',
    owners: ['ml-platform-oncall'],
    tags: [],
    team: 'ml-platform',
    schedule: '20 * * * *',
    maxActiveTasks: 16,
    maxActiveRuns: 25,
    catchup: false,
    paused: false,
  },
  periodMinutes: 60,
  offsetMinutes: 20,
  layers: [1, 2, 1],
  medianTaskMs: 3 * 60_000,
  pool: 'default_pool',
  poolSlots: 1,
  operator: 'BigQueryInsertJobOperator',
  failureRate: 0,
  cpu: 0.05,
  slowdown: { taskIds: ['task_2_1'], factor: 2.5, hoursBeforeNow: 18 },
};
const oneDag: Scenario = { ...prod, dags: () => [ranking] };

const medianMinutes = (
  tries: ReturnType<typeof simulateEnvironment>['tries'],
  taskId: string,
  after: boolean,
) =>
  percentile(
    tries
      .filter((t) => t.taskId === taskId && t.startAt !== null && t.endAt !== null)
      .filter((t) => (t.startAt as number) >= SINCE === after)
      .map((t) => ((t.endAt as number) - (t.startAt as number)) / 60_000),
    0.5,
  ) ?? NaN;

describe('FR-EMU-03 / HM-016 a step change in task duration', () => {
  const { tries } = simulateEnvironment({ seed: 3, now: NOW, hours: 48, scenario: oneDag });

  it('FR-EMU-03: the named tasks take `factor` × longer from the slowdown on; the others do not change', () => {
    const slowed = medianMinutes(tries, 'task_2_1', true) / medianMinutes(tries, 'task_2_1', false);
    const sibling = medianMinutes(tries, 'task_2_2', true) / medianMinutes(tries, 'task_2_2', false);
    expect(slowed).toBeGreaterThan(1.8);
    expect(slowed).toBeLessThan(3.4);
    expect(sibling).toBeGreaterThan(0.6);
    expect(sibling).toBeLessThan(1.6);
  });

  it('FR-EMU-01: a slowdown draws no extra random numbers, so it changes no other try', () => {
    const plain = simulateEnvironment({
      seed: 3,
      now: NOW,
      hours: 48,
      scenario: {
        ...prod,
        dags: () => [{ ...ranking, slowdown: { taskIds: ['task_2_1'], factor: 1, hoursBeforeNow: 18 } }],
      },
    });
    const before = (t: { startAt: number | null }) => t.startAt !== null && t.startAt < SINCE - 2 * HOUR;
    expect(tries.filter(before)).toEqual(plain.tries.filter(before));
  });

  it('FR-EMU-03 acme-prod: the demo has a DAG whose task got slower 20 h ago, steady before', () => {
    const story = prod.dags(() => 0.5).find((d) => d.slowdown !== undefined);
    expect(story?.meta.dagId).toBe('search_ranking_refresh');
    expect(story?.slowdown).toMatchObject({ hoursBeforeNow: 20 });
    expect(story?.durationSigma).toBeLessThan(0.5);
    expect(story?.slowdown?.factor).toBeGreaterThanOrEqual(2);
  });
});
