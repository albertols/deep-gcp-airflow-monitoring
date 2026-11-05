/**
 * Demo scenarios for the fictitious "acme" organisation (spec §20.6). Each environment tells stories
 * DCAM should reveal:
 *
 * - acme-prod: a nightly batch window at 01:30 UTC keeps workers at `max_count` with tasks queued for
 *   about an hour (REC-CAP-01, AL-05), a 4-slot `external_api` pool starves (REC-CONC-02), a fan-out
 *   DAG is capped by `max_active_tasks` (REC-DAG-01), a poke-mode sensor holds slots (REC-DAG-05),
 *   schedules collide on minute 0 (REC-SCHED-01), and one DAG is flaky.
 * - acme-test: `parallelism` is below worker capacity and binds first (REC-CONC-01).
 * - acme-dev: quiet and healthy.
 *
 * Settings are illustrative, not recommendations.
 */
import type { DagMeta, EnvironmentConfig } from '@dcam/domain';
import type { DagBlueprint, Scenario } from './simulator';

export type AcmeEnvironment = 'acme-prod' | 'acme-test' | 'acme-dev';

const MIN = 60_000;
const IMAGE = 'composer-3-airflow-2.11.1-build.22';

const DOMAINS: ReadonlyArray<readonly [string, string]> = [
  ['orders', 'finance-data'],
  ['billing', 'finance-data'],
  ['payments', 'finance-data'],
  ['finance', 'finance-data'],
  ['customer_360', 'customer'],
  ['crm_sync', 'customer'],
  ['marketing', 'customer'],
  ['clickstream', 'customer'],
  ['inventory', 'supply-chain'],
  ['logistics', 'supply-chain'],
  ['pricing', 'supply-chain'],
  ['ml_features', 'ml-platform'],
  ['fraud', 'ml-platform'],
  ['search_index', 'ml-platform'],
  ['reporting', 'analytics'],
];
const SUFFIXES = ['daily', 'hourly', 'ingest', 'export', 'refresh', 'aggregate', 'dq_checks', 'snapshot'];
const OPERATORS = [
  'PythonOperator',
  'BigQueryInsertJobOperator',
  'GCSToBigQueryOperator',
  'DataflowStartFlexTemplateOperator',
];

interface Blueprint {
  readonly dagId: string;
  readonly team: string;
  readonly domain: string;
  readonly hourly: boolean;
  readonly offsetMinutes: number;
  readonly layers: readonly number[];
  readonly medianTaskMs: number;
  readonly pool: string;
  readonly poolSlots?: number;
  readonly operator?: string;
  readonly failureRate?: number;
  readonly cpu?: number;
  readonly maxActiveTasks?: number;
  readonly sensorWaitMs?: number;
  readonly paused?: boolean;
}

function blueprint(b: Blueprint, config: EnvironmentConfig): DagBlueprint {
  const minute = b.offsetMinutes % 60;
  const hour = Math.floor(b.offsetMinutes / 60);
  const meta: DagMeta = {
    dagId: b.dagId,
    fileloc: `/home/airflow/gcs/dags/${b.team}/${b.dagId}.py`,
    owners: [`${b.team}-oncall`],
    tags: [b.domain, b.hourly ? 'hourly' : 'daily', `team:${b.team}`],
    team: b.team,
    schedule: b.hourly ? `${minute} * * * *` : `${minute} ${hour} * * *`,
    maxActiveTasks: b.maxActiveTasks ?? config.maxActiveTasksPerDag,
    maxActiveRuns: config.maxActiveRunsPerDag,
    catchup: false,
    paused: b.paused ?? false,
  };
  return {
    meta,
    periodMinutes: b.hourly ? 60 : 1_440,
    offsetMinutes: b.offsetMinutes,
    layers: b.layers,
    medianTaskMs: b.medianTaskMs,
    pool: b.pool,
    poolSlots: b.poolSlots ?? 1,
    operator: b.operator ?? 'PythonOperator',
    failureRate: b.failureRate ?? 0.02,
    cpu: b.cpu ?? 0.04,
    ...(b.sensorWaitMs === undefined ? {} : { sensorWaitMs: b.sensorWaitMs }),
  };
}

/** Background DAGs: mostly light, a few heavy, schedules clustered on round minutes. */
/** Mean of the simulator's log-normal task duration (σ = 0.5) relative to its median. */
const LOG_NORMAL_MEAN = Math.exp(0.5 ** 2 / 2);

/** Expected executor slot-hours per day of a blueprint. */
function expectedSlotHoursPerDay(b: DagBlueprint): number {
  if (b.meta.paused) return 0;
  const runsPerDay = 1_440 / b.periodMinutes;
  const tasks = b.layers.reduce((s, n) => s + n, 0);
  return (runsPerDay * tasks * b.medianTaskMs * LOG_NORMAL_MEAN) / 3_600_000;
}

/**
 * Background DAGs: mostly light, a few heavy fan-out DAGs (mostly daily), schedules clustered on
 * round minutes. Task durations are scaled so the set's expected load is `targetSlotHoursPerDay`,
 * which keeps every seed's environment busy but sustainable; bursts still come from collisions.
 */
function generated(
  random: () => number,
  count: number,
  config: EnvironmentConfig,
  pools: readonly string[],
  heavyShare: number,
  targetSlotHoursPerDay: number,
): DagBlueprint[] {
  const out: DagBlueprint[] = [];
  for (let i = 0; i < count; i++) {
    const [domain, team] = DOMAINS[i % DOMAINS.length] as readonly [string, string];
    const name = `${domain}_${SUFFIXES[Math.floor(i / DOMAINS.length) % SUFFIXES.length]}`;
    const dagId = i < DOMAINS.length * SUFFIXES.length ? name : `${name}_${i}`;
    const heavy = random() < heavyShare;
    const hourly = random() < (heavy ? 0.2 : 0.5);
    const roundMinute = random() < 0.6;
    const minute = roundMinute ? 0 : Math.floor(random() * 12) * 5;
    const hour = random() < 0.4 ? Math.floor(random() * 3) : Math.floor(random() * 24);
    const width = heavy ? 4 + Math.floor(random() * 9) : 1;
    const depth = heavy ? 3 : 1 + Math.floor(random() * 4);
    const layers = heavy ? [1, width, 1] : Array.from({ length: depth }, () => 1);
    out.push(
      blueprint(
        {
          dagId,
          team,
          domain,
          hourly,
          offsetMinutes: hourly ? minute : hour * 60 + minute,
          layers,
          medianTaskMs: heavy ? (6 + random() * 18) * MIN : (0.5 + random() * 4) * MIN,
          // Heavy fan-out DAGs stay in the default pool so small pools are not overrun by chance.
          pool: heavy ? 'default_pool' : (pools[Math.floor(random() * pools.length)] as string),
          poolSlots: random() < 0.08 ? 2 : 1,
          operator: OPERATORS[Math.floor(random() * OPERATORS.length)] as string,
          cpu: heavy ? 0.06 + random() * 0.06 : 0.02 + random() * 0.03,
          paused: random() < 0.02,
        },
        config,
      ),
    );
  }
  const expected = out.reduce((s, b) => s + expectedSlotHoursPerDay(b), 0);
  const scale = expected > 0 ? targetSlotHoursPerDay / expected : 1;
  return out.map((b) => ({ ...b, medianTaskMs: b.medianTaskMs * scale }));
}

/** Prod's nightly batch window (01:30 UTC): domain and owning team of each rebuild DAG. */
const NIGHTLY_BATCH: ReadonlyArray<readonly [string, string]> = [
  ['orders', 'finance-data'],
  ['billing', 'finance-data'],
  ['inventory', 'supply-chain'],
  ['clickstream', 'customer'],
  ['ml_features', 'ml-platform'],
];

const PROD: EnvironmentConfig = {
  envId: 'acme-prod',
  tier: 'prod',
  composerImage: IMAGE,
  airflowVersion: '2.11.1',
  parallelism: 96,
  schedulers: 2,
  maxActiveTasksPerDag: 16,
  maxActiveRunsPerDag: 25,
  workerConcurrency: 12,
  minWorkers: 2,
  maxWorkers: 6,
  pools: [
    { name: 'default_pool', slots: 128 },
    { name: 'etl', slots: 24 },
    { name: 'ml', slots: 8 },
    { name: 'external_api', slots: 4 },
  ],
};

const TEST: EnvironmentConfig = {
  envId: 'acme-test',
  tier: 'test',
  composerImage: IMAGE,
  airflowVersion: '2.11.1',
  parallelism: 24,
  schedulers: 1,
  maxActiveTasksPerDag: 16,
  maxActiveRunsPerDag: 25,
  workerConcurrency: 8,
  minWorkers: 1,
  maxWorkers: 6,
  pools: [
    { name: 'default_pool', slots: 128 },
    { name: 'etl', slots: 16 },
  ],
};

const DEV: EnvironmentConfig = {
  envId: 'acme-dev',
  tier: 'dev',
  composerImage: IMAGE,
  airflowVersion: '2.11.1',
  parallelism: 32,
  schedulers: 1,
  maxActiveTasksPerDag: 16,
  maxActiveRunsPerDag: 25,
  workerConcurrency: 8,
  minWorkers: 1,
  maxWorkers: 3,
  pools: [{ name: 'default_pool', slots: 128 }],
};

export function acmeScenario(env: AcmeEnvironment): Scenario {
  switch (env) {
    case 'acme-prod':
      return {
        config: PROD,
        workerCpu: 2,
        platformHealth: {
          envHealthyRatio: 0.99,
          dbHealthyRatio: 1,
          heartbeatCompleteness: 0.98,
          webServerHealthyRatio: 1,
          dbCpuMemoryMax: 0.64,
          zombies24h: 0,
          workerRestarts24h: 3,
          importErrors: 0,
          parseLoopP95Seconds: 96,
        },
        dags: (random) => [
          ...generated(
            random,
            186,
            PROD,
            ['default_pool', 'default_pool', 'default_pool', 'default_pool', 'etl'],
            0.12,
            780,
          ),
          // The nightly batch window: five wide rebuilds at 01:30 UTC ask for more task slots than six
          // workers have, so workers sit at max_count with tasks queued for about an hour every night.
          ...NIGHTLY_BATCH.map(([domain, team]) =>
            blueprint(
              {
                dagId: `${domain}_nightly_rebuild`,
                team,
                domain,
                hourly: false,
                offsetMinutes: 90,
                layers: [1, 16, 1],
                medianTaskMs: 25 * MIN,
                pool: 'default_pool',
                operator: 'BigQueryInsertJobOperator',
                cpu: 0.08,
              },
              PROD,
            ),
          ),
          blueprint(
            {
              dagId: 'customer_360_rebuild',
              team: 'customer',
              domain: 'customer_360',
              hourly: true,
              offsetMinutes: 0,
              layers: [1, 12, 1],
              medianTaskMs: 6 * MIN,
              pool: 'default_pool',
              maxActiveTasks: 4,
              cpu: 0.15,
            },
            PROD,
          ),
          ...['crm', 'shipping', 'tax', 'fx_rates', 'geo', 'weather', 'ads', 'reviews'].map((partner, i) =>
            blueprint(
              {
                dagId: `partner_${partner}_sync`,
                team: i < 4 ? 'finance-data' : 'customer',
                domain: 'partner_api',
                hourly: true,
                offsetMinutes: i % 3 === 0 ? 5 : 0,
                layers: [2, 2],
                medianTaskMs: 3 * MIN,
                pool: 'external_api',
                operator: 'HttpOperator',
                cpu: 0.03,
              },
              PROD,
            ),
          ),
          blueprint(
            {
              dagId: 'partner_feed_wait',
              team: 'supply-chain',
              domain: 'partner_api',
              hourly: true,
              offsetMinutes: 10,
              layers: [1, 2],
              medianTaskMs: 2 * MIN,
              pool: 'default_pool',
              sensorWaitMs: 35 * MIN,
            },
            PROD,
          ),
          blueprint(
            {
              dagId: 'fraud_scoring_hourly',
              team: 'ml-platform',
              domain: 'fraud',
              hourly: true,
              offsetMinutes: 15,
              layers: [1, 3, 1],
              medianTaskMs: 4 * MIN,
              pool: 'ml',
              failureRate: 0.18,
              cpu: 0.4,
            },
            PROD,
          ),
        ],
      };
    case 'acme-test':
      return {
        config: TEST,
        workerCpu: 2,
        platformHealth: {
          envHealthyRatio: 0.97,
          dbHealthyRatio: 0.99,
          heartbeatCompleteness: 0.93,
          webServerHealthyRatio: 1,
          // Several non-critical checks fail: a "degraded" environment for the fleet view (HM-028).
          dbCpuMemoryMax: 0.86,
          zombies24h: 3,
          workerRestarts24h: 2,
          importErrors: 2,
          parseLoopP95Seconds: 140,
        },
        dags: (random) =>
          generated(random, 80, TEST, ['default_pool', 'default_pool', 'default_pool', 'etl'], 0.15, 300),
      };
    case 'acme-dev':
      return {
        config: DEV,
        workerCpu: 2,
        platformHealth: {
          envHealthyRatio: 1,
          dbHealthyRatio: 1,
          heartbeatCompleteness: 1,
          webServerHealthyRatio: null,
          dbCpuMemoryMax: 0.21,
          zombies24h: 0,
          workerRestarts24h: 0,
          importErrors: 0,
          parseLoopP95Seconds: 31,
        },
        dags: (random) => generated(random, 40, DEV, ['default_pool'], 0.05, 100),
      };
  }
}
