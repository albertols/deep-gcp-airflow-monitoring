import { describe, expect, it } from 'vitest';
import {
  UNKNOWN_LIMIT,
  collisionDensity,
  evaluateAdvisor,
  type AdvisorFinding,
  type DagLimitSignal,
  type DagMeta,
  type EnvironmentConfig,
  type EnvironmentSignals,
  type PoolSignal,
  type RuleId,
  type SensorSignal,
  type WaitReasonId,
  type WorkerMinutes,
} from '../src/index';

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const FROM = NOW - 24 * 3_600_000;
const MIN = 60_000;
const HOUR = 3_600_000;

const config: EnvironmentConfig = {
  envId: 'acme-prod',
  tier: 'prod',
  composerImage: 'composer-3-airflow-2.11.1-build.22',
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
    { name: 'external_api', slots: 4 },
  ],
};
const dag = (dagId: string, schedule: string, maxActiveTasks = 16): DagMeta => ({
  dagId,
  fileloc: `/home/airflow/gcs/dags/${dagId}.py`,
  owners: ['acme'],
  tags: [],
  team: 'acme',
  schedule,
  maxActiveTasks,
  maxActiveRuns: 25,
  catchup: false,
  paused: false,
});
const quiet: WorkerMinutes = {
  minutes: 0,
  queuedTaskMinutes: 0,
  queuedPeak: 0,
  cpuP95: null,
  memoryP95: null,
  utilisationMean: null,
  last: null,
};
const pool = (over: Partial<PoolSignal> = {}): PoolSignal => ({
  name: 'external_api',
  slots: 4,
  starvedMinutes: 0,
  starvedObservations: 0,
  bindingWaitingMs: 0,
  waitingWhileStarvedMs: 0,
  dagWaitingMs: new Map(),
  peakDemandSlots: 4,
  lastStarved: null,
  ...over,
});

interface Over {
  config?: Partial<EnvironmentConfig>;
  dags?: DagMeta[];
  coverage?: Partial<EnvironmentSignals['coverage']>;
  waiting?: { totalsMs?: [WaitReasonId, number][]; byReasonDag?: [WaitReasonId, [string, number][]][] };
  minutes?: [WaitReasonId, number][];
  hourWaitingMs?: number[];
  capacity?: Partial<EnvironmentSignals['capacity']>;
  workerResources?: EnvironmentSignals['workerResources'];
  pools?: PoolSignal[];
  poolSlotSeconds?: [string, number][];
  slotSecondsByDag?: [string, number][];
  dagLimits?: DagLimitSignal[];
  sensors?: SensorSignal[];
}

/** A quiet environment over the last 24 h, with full coverage; tests override what a rule reads. */
function signals(over: Over = {}): EnvironmentSignals {
  const cfg = { ...config, ...over.config };
  const dags = over.dags ?? [dag('orders_daily', '30 2 * * *')];
  const totals = new Map(over.waiting?.totalsMs ?? []);
  const hour = over.hourWaitingMs ?? new Array<number>(60).fill(0);
  return {
    config: cfg,
    dags: new Map(dags.map((d) => [d.dagId, d])),
    from: FROM,
    to: NOW,
    coverage: { snapshots: 1, samples: 1, tries: 1, ...over.coverage },
    snapshotCount: 2880,
    snapshotIntervalMs: 30_000,
    sampleCount: 1440,
    waiting: {
      totalsMs: totals,
      platformMs: [...totals].reduce((s, [r, ms]) => (r === 'normal-latency' ? s : s + ms), 0),
      byReasonDag: new Map((over.waiting?.byReasonDag ?? []).map(([r, d]) => [r, new Map(d)])),
      minutes: new Map(over.minutes ?? []),
      lastSeen: new Map((over.minutes ?? []).map(([r]) => [r, NOW - MIN])),
      byMinuteOfHour: {
        waitingMs: hour,
        minutes: hour.map((ms) => (ms > 0 ? 24 : 0)),
        last: hour.map((ms) => (ms > 0 ? NOW - HOUR : null)),
      },
    },
    capacity: {
      minutesAtMax: 0,
      capacityBoundMinutes: 0,
      bound: { ...quiet, episodes: [], demandP95: null, maxQueueWaitMs: null },
      slotsFullAtMax: quiet,
      scaleOutSuppressed: quiet,
      ...over.capacity,
    },
    workerResources: over.workerResources ?? null,
    pools: over.pools ?? [pool({ name: 'default_pool', slots: 128 }), pool()],
    poolSlotSeconds: new Map(over.poolSlotSeconds ?? [['default_pool', 1000]]),
    slotSecondsByDag: new Map(over.slotSecondsByDag ?? []),
    dagLimits: over.dagLimits ?? [],
    sensors: over.sensors ?? [],
    schedules: collisionDensity(dags),
  };
}

const run = (s: EnvironmentSignals) => evaluateAdvisor(s);
const only = (s: EnvironmentSignals, ruleId: RuleId) => run(s).findings.filter((f) => f.ruleId === ruleId);
const one = (s: EnvironmentSignals, ruleId: RuleId): AdvisorFinding => {
  const found = only(s, ruleId);
  expect(found).toHaveLength(1);
  return found[0] as AdvisorFinding;
};
const code = (f: AdvisorFinding, kind: string) => f.remediation.find((r) => r.kind === kind)?.code ?? '';

const bound = (minutes: number, over: Partial<EnvironmentSignals['capacity']['bound']> = {}) => ({
  minutesAtMax: minutes * 4,
  capacityBoundMinutes: minutes,
  bound: {
    ...quiet,
    minutes,
    queuedTaskMinutes: minutes * 40,
    queuedPeak: 72,
    cpuP95: 0.5,
    memoryP95: 0.72,
    utilisationMean: 1,
    last: NOW - 30 * MIN,
    episodes: [{ start: NOW - 2 * HOUR, end: NOW - 2 * HOUR + minutes * MIN, minutes }],
    demandP95: 100,
    maxQueueWaitMs: 14 * MIN,
    ...over,
  },
});

describe('REC-CAP-01 workers at maximum while tasks are queued', () => {
  it('REC-CAP-01: fires at 15 capacity-bound minutes in 24 h, with numbers, evidence and sizing snippets', () => {
    const f = one(
      signals({
        capacity: bound(30),
        waiting: { byReasonDag: [['executor-slots-exhausted', [['orders_daily', 600_000]]]] },
        minutes: [['executor-slots-exhausted', 30]],
      }),
      'REC-CAP-01',
    );
    expect(f).toMatchObject({
      id: 'acme-prod:REC-CAP-01:environment:acme-prod',
      severity: 'warning',
      category: 'capacity',
      scope: { kind: 'environment', id: 'acme-prod' },
      effort: 2,
      tierWeight: 1,
      impact: 3,
      confidence: 1,
      priorityScore: 1.5,
      affectedDags: ['orders_daily'],
      detectedAt: NOW - 30 * MIN,
    });
    expect(f.observation).toContain('maximum of 6 for 30 min');
    expect(f.observation).toContain('up to 72 tasks were queued');
    expect(f.impactText).toContain('20 task-hours');
    expect(f.action).toMatch(/raise max_count from 6 to 9/);
    expect(f.why).toMatch(/max\(10, 20% of 72 worker slots\) = 15/);
    expect(f.evidence).toContainEqual({
      label: 'Capacity-bound minutes in 24 h',
      value: '30 min',
      threshold: '≥ 15 min (critical at ≥ 120 min)',
      source: 'SRC-MON',
    });
    expect(code(f, 'gcloud')).toContain('gcloud composer environments update acme-prod');
    expect(code(f, 'gcloud')).toContain('--location LOCATION');
    expect(code(f, 'gcloud')).toContain('--max-workers 9');
    expect(code(f, 'terraform')).toMatch(/workloads_config \{[\s\S]*worker \{[\s\S]*max_count = 9/);
    expect(f.links.docs.length).toBeGreaterThan(0);
    expect(f.risks).toContain('Higher maximum increases peak cost.');
  });

  it('REC-CAP-01: becomes critical at 120 capacity-bound minutes', () => {
    expect(one(signals({ capacity: bound(120) }), 'REC-CAP-01').severity).toBe('critical');
  });

  it('REC-CAP-01: stays quiet below 15 minutes, and below 60 minutes on development tiers', () => {
    expect(only(signals({ capacity: bound(14) }), 'REC-CAP-01')).toEqual([]);
    expect(only(signals({ config: { tier: 'dev' }, capacity: bound(59) }), 'REC-CAP-01')).toEqual([]);
    const dev = one(signals({ config: { tier: 'dev' }, capacity: bound(60) }), 'REC-CAP-01');
    expect(dev.tierWeight).toBe(0.3);
  });

  it('REC-CAP-01: inhibits REC-CAP-05 for the environment', () => {
    const result = run(
      signals({
        capacity: { ...bound(30), slotsFullAtMax: { ...quiet, minutes: 30, cpuP95: 0.1, memoryP95: 0.2 } },
      }),
    );
    expect(result.findings.map((f) => f.ruleId)).toContain('REC-CAP-01');
    expect(result.findings.map((f) => f.ruleId)).not.toContain('REC-CAP-05');
    expect(result.inhibited).toContainEqual({ ruleId: 'REC-CAP-05', scopeId: 'acme-prod', by: 'REC-CAP-01' });
  });
});

describe('REC-CAP-05 under-packed workers', () => {
  const full = (cpuP95: number, memoryP95: number): Partial<EnvironmentSignals['capacity']> => ({
    slotsFullAtMax: { ...quiet, minutes: 20, queuedTaskMinutes: 200, cpuP95, memoryP95, last: NOW },
  });

  it('REC-CAP-05: raises worker_concurrency within 1–24 when slots are full but CPU and memory idle', () => {
    const f = one(signals({ config: { workerConcurrency: 8 }, capacity: full(0.2, 0.3) }), 'REC-CAP-05');
    expect(f.effort).toBe(1);
    expect(f.action).toContain('from 8 to 12');
    expect(code(f, 'gcloud')).toContain('--update-airflow-configs=celery-worker_concurrency=12');
    expect(code(f, 'terraform')).toContain('"celery-worker_concurrency" = "12"');
  });

  it('REC-CAP-05: stays quiet when memory is at 40 % or concurrency is already 24', () => {
    expect(only(signals({ capacity: full(0.2, 0.4) }), 'REC-CAP-05')).toEqual([]);
    expect(
      only(signals({ config: { workerConcurrency: 24 }, capacity: full(0.2, 0.3) }), 'REC-CAP-05'),
    ).toEqual([]);
  });
});

describe('REC-CAP-08 scale-out suppressed by high worker_concurrency', () => {
  const suppressed: Partial<EnvironmentSignals['capacity']> = {
    scaleOutSuppressed: {
      ...quiet,
      minutes: 45,
      cpuP95: 0.93,
      memoryP95: 0.6,
      utilisationMean: 0.9,
      last: NOW,
    },
  };

  it('REC-CAP-08: records insufficient data while worker size is not collected', () => {
    const result = run(signals({ config: { workerConcurrency: 16 }, capacity: suppressed }));
    expect(result.findings.some((f) => f.ruleId === 'REC-CAP-08')).toBe(false);
    expect(result.insufficient.map((i) => i.ruleId)).toContain('REC-CAP-08');
  });

  it('REC-CAP-08: lowers worker_concurrency to the documented guidance for the worker size', () => {
    const f = one(
      signals({
        config: { workerConcurrency: 16 },
        capacity: suppressed,
        workerResources: { cpu: 1, memoryGb: 4 },
      }),
      'REC-CAP-08',
    );
    expect(f.action).toContain('from 16 to 12');
    expect(code(f, 'gcloud')).toContain('celery-worker_concurrency=12');
  });

  it('REC-CAP-08: stays quiet when worker_concurrency is within the guidance', () => {
    const s = signals({
      config: { workerConcurrency: 12 },
      capacity: suppressed,
      workerResources: { cpu: 1, memoryGb: 4 },
    });
    expect(only(s, 'REC-CAP-08')).toEqual([]);
  });
});

describe('REC-CONC-01 global parallelism is binding', () => {
  const test = { tier: 'test' as const, parallelism: 24, schedulers: 1, workerConcurrency: 8, maxWorkers: 6 };

  it('REC-CONC-01: raises core.parallelism to worker capacity when parallelism explains ≥ 20 % of waiting', () => {
    const f = one(
      signals({
        config: test,
        waiting: {
          totalsMs: [
            ['parallelism', 20 * HOUR],
            ['pool-exhausted', 80 * HOUR],
          ],
        },
        minutes: [['parallelism', 600]],
      }),
      'REC-CONC-01',
    );
    expect(f).toMatchObject({ effort: 1, tierWeight: 0.6, impact: 3, category: 'concurrency' });
    expect(f.observation).toContain('24');
    expect(f.observation).toContain('48 worker slots');
    expect(f.action).toContain('from 24 to 48');
    expect(code(f, 'gcloud')).toContain('--update-airflow-configs=core-parallelism=48');
    expect(code(f, 'terraform')).toContain('"core-parallelism" = "48"');
  });

  it('REC-CONC-01: stays quiet below a 20 % share, or when parallelism covers worker capacity', () => {
    const waiting = {
      totalsMs: [
        ['parallelism', 19 * HOUR],
        ['pool-exhausted', 81 * HOUR],
      ] as [WaitReasonId, number][],
    };
    expect(only(signals({ config: test, waiting, minutes: [['parallelism', 600]] }), 'REC-CONC-01')).toEqual(
      [],
    );
    const enough = { totalsMs: [['parallelism', 50 * HOUR]] as [WaitReasonId, number][] };
    expect(
      only(
        signals({ config: { ...test, parallelism: 48 }, waiting: enough, minutes: [['parallelism', 600]] }),
        'REC-CONC-01',
      ),
    ).toEqual([]);
  });

  it('REC-CONC-01 / HM-032: proposes no parallelism while worker_concurrency is not known', () => {
    const waiting = { totalsMs: [['parallelism', 50 * HOUR]] as [WaitReasonId, number][] };
    const unknownSlots = {
      ...test,
      workerConcurrency: UNKNOWN_LIMIT,
      limitSources: { workerConcurrency: 'unknown' as const },
    };
    expect(
      only(signals({ config: unknownSlots, waiting, minutes: [['parallelism', 600]] }), 'REC-CONC-01'),
    ).toEqual([]);
  });
});

describe('REC-CONC-02 pool starvation', () => {
  const starved = (minutes: number, over: Partial<PoolSignal> = {}) =>
    pool({
      starvedMinutes: minutes,
      starvedObservations: minutes * 2,
      bindingWaitingMs: 50 * HOUR,
      waitingWhileStarvedMs: 60 * HOUR,
      dagWaitingMs: new Map([
        ['partner_crm_sync', 40 * HOUR],
        ['partner_tax_sync', 20 * HOUR],
      ]),
      peakDemandSlots: 16,
      lastStarved: NOW - MIN,
      ...over,
    });

  it('REC-CONC-02: fires per pool at 30 starved minutes per day, proposing more slots', () => {
    const f = one(
      signals({ pools: [pool({ name: 'default_pool', slots: 128 }), starved(30)] }),
      'REC-CONC-02',
    );
    expect(f).toMatchObject({
      id: 'acme-prod:REC-CONC-02:pool:external_api',
      scope: { kind: 'pool', id: 'external_api' },
      affectedDags: ['partner_crm_sync', 'partner_tax_sync'],
      impact: 3,
    });
    expect(f.observation).toContain('external_api');
    expect(f.observation).toContain('30 min');
    expect(f.action).toContain('from 4 to 8');
    expect(code(f, 'gcloud')).toContain('gcloud composer environments run acme-prod');
    expect(code(f, 'gcloud')).toContain('pools set -- external_api 8');
  });

  it('REC-CONC-02: stays quiet at 29 starved minutes', () => {
    expect(only(signals({ pools: [starved(29)] }), 'REC-CONC-02')).toEqual([]);
  });

  it('REC-CONC-02: says when an earlier limit held the work first', () => {
    const f = one(signals({ pools: [starved(120, { bindingWaitingMs: 0 })] }), 'REC-CONC-02');
    expect(f.impactText).toMatch(/earlier limit/);
  });
});

describe('REC-CONC-03 default_pool overload', () => {
  const starvedDefault = pool({
    name: 'default_pool',
    slots: 128,
    starvedMinutes: 40,
    starvedObservations: 80,
  });

  it('REC-CONC-03: fires when ≥ 70 % of slot-seconds run in default_pool and it starves', () => {
    const f = one(
      signals({
        pools: [starvedDefault],
        poolSlotSeconds: [
          ['default_pool', 70],
          ['etl', 30],
        ],
      }),
      'REC-CONC-03',
    );
    expect(f).toMatchObject({ scope: { kind: 'pool', id: 'default_pool' }, effort: 5 });
  });

  it('REC-CONC-03: stays quiet at a 69 % share', () => {
    expect(
      only(
        signals({
          pools: [starvedDefault],
          poolSlotSeconds: [
            ['default_pool', 69],
            ['etl', 31],
          ],
        }),
        'REC-CONC-03',
      ),
    ).toEqual([]);
  });
});

describe('REC-DAG-01 DAG throttled by max_active_tasks', () => {
  const limited = (atLimit: number, over: Partial<DagLimitSignal> = {}): DagLimitSignal => ({
    dagId: 'customer_360_rebuild',
    limit: 4,
    limitIsDefault: false,
    activeObservations: 1000,
    atLimitObservations: atLimit,
    ownWaitingMs: 30 * HOUR,
    peakDemand: 12,
    headroomObservations: atLimit,
    lastAtLimit: NOW - MIN,
    ...over,
  });
  const dags = [dag('customer_360_rebuild', '0 * * * *', 4)];

  it('REC-DAG-01: fires at 10 % of active time at the limit, with a DAG diff to the observed peak', () => {
    const f = one(signals({ dags, dagLimits: [limited(100)] }), 'REC-DAG-01');
    expect(f).toMatchObject({
      scope: { kind: 'dag', id: 'customer_360_rebuild' },
      effort: 3,
      affectedDags: ['customer_360_rebuild'],
      category: 'dag',
    });
    expect(f.observation).toContain('limit of 4');
    expect(f.observation).toContain('10%');
    expect(code(f, 'dag-diff')).toContain('-    max_active_tasks=4,');
    expect(code(f, 'dag-diff')).toContain('+    max_active_tasks=12,');
    expect(f.action).toMatch(/free worker slots/);
  });

  it('REC-DAG-01: asks to add capacity first when the environment had no headroom', () => {
    const f = one(signals({ dags, dagLimits: [limited(400, { headroomObservations: 40 })] }), 'REC-DAG-01');
    expect(f.action).toMatch(/only once the environment has headroom/);
  });

  it('REC-DAG-01: stays quiet below 10 %', () => {
    expect(only(signals({ dags, dagLimits: [limited(99)] }), 'REC-DAG-01')).toEqual([]);
  });
});

describe('REC-DAG-05 sensor slot waste', () => {
  const sensor = (slotSeconds: number, mode: SensorSignal['mode'] = 'poke'): SensorSignal => ({
    dagId: 'partner_feed_wait',
    taskId: 'wait_for_feed',
    operator: 'ExternalTaskSensor',
    mode,
    slotSeconds,
    tries: 24,
    last: NOW - MIN,
  });
  const dags = [dag('partner_feed_wait', '10 * * * *')];

  it('REC-DAG-05: fires for a poke-mode sensor at 1 slot-hour per day, with reschedule and deferrable diffs', () => {
    const f = one(signals({ dags, sensors: [sensor(3600)] }), 'REC-DAG-05');
    expect(f).toMatchObject({
      scope: { kind: 'task', id: 'partner_feed_wait/wait_for_feed' },
      effort: 3,
      impact: 2,
      affectedDags: ['partner_feed_wait'],
    });
    const diffs = f.remediation.filter((r) => r.kind === 'dag-diff').map((r) => r.code);
    expect(diffs.some((d) => d.includes('mode="reschedule"'))).toBe(true);
    expect(diffs.some((d) => d.includes('deferrable=True'))).toBe(true);
  });

  it('REC-DAG-05: stays quiet below 1 slot-hour or when the sensor already reschedules', () => {
    expect(only(signals({ dags, sensors: [sensor(3599)] }), 'REC-DAG-05')).toEqual([]);
    expect(only(signals({ dags, sensors: [sensor(36_000, 'reschedule')] }), 'REC-DAG-05')).toEqual([]);
  });
});

describe('REC-SCHED-01 schedule collisions', () => {
  const colliding = [
    dag('orders_hourly', '0 * * * *'),
    dag('billing_hourly', '0 * * * *'),
    dag('pricing_hourly', '@hourly'),
    dag('crm_hourly', '20 * * * *'),
    dag('reporting_daily', '45 6 * * *'),
  ];
  const hour = (inWindow: number, outside: number) =>
    Array.from({ length: 60 }, (_, m) => (m < 15 ? inWindow / 15 : outside / 45));

  it('REC-SCHED-01: fires when ≥ 20 % of daily starts share a minute and waiting concentrates after it', () => {
    const f = one(
      signals({
        dags: colliding,
        hourWaitingMs: hour(60 * HOUR, 20 * HOUR),
        waiting: { totalsMs: [['executor-slots-exhausted', 80 * HOUR]] },
        slotSecondsByDag: [
          ['billing_hourly', 9000],
          ['orders_hourly', 5000],
          ['pricing_hourly', 100],
        ],
      }),
      'REC-SCHED-01',
    );
    expect(f).toMatchObject({
      scope: { kind: 'environment', id: 'acme-prod' },
      effort: 5,
      category: 'scheduling',
    });
    expect(f.affectedDags).toEqual(['billing_hourly', 'orders_hourly', 'pricing_hourly']);
    expect(f.observation).toContain('minute 0');
    const diff = code(f, 'dag-diff');
    expect(diff).toContain('-    schedule="0 * * * *",');
    expect(diff).toMatch(/\+ {4}schedule="([1-9]|1[0-5]) \* \* \* \*",/);
    expect(diff).toContain('billing_hourly');
  });

  it('REC-SCHED-01: stays quiet when waiting does not concentrate after the busiest minute', () => {
    const s = signals({
      dags: colliding,
      hourWaitingMs: hour(30 * HOUR, 50 * HOUR),
      waiting: { totalsMs: [['executor-slots-exhausted', 80 * HOUR]] },
    });
    expect(only(s, 'REC-SCHED-01')).toEqual([]);
  });

  it('REC-SCHED-01: stays quiet when no minute holds 20 % of daily starts', () => {
    const spread = Array.from({ length: 6 }, (_, i) => dag(`d${i}`, `${i * 10} * * * *`));
    const s = signals({
      dags: spread,
      hourWaitingMs: hour(60 * HOUR, 20 * HOUR),
      waiting: { totalsMs: [['executor-slots-exhausted', 80 * HOUR]] },
    });
    expect(only(s, 'REC-SCHED-01')).toEqual([]);
  });
});

describe('§13.2 data quality gates and §13.4 ranking', () => {
  it('§13.2: a rule produces no finding and records insufficient data when coverage is below 80 %', () => {
    const result = run(signals({ coverage: { samples: 0.79 }, capacity: bound(200) }));
    expect(result.findings.some((f) => f.ruleId === 'REC-CAP-01')).toBe(false);
    expect(result.insufficient).toContainEqual(expect.objectContaining({ ruleId: 'REC-CAP-01' }));
  });

  it('FR-ADV-04: findings come back ranked, critical first, then by priority score', () => {
    const result = run(
      signals({
        capacity: bound(150),
        pools: [pool({ starvedMinutes: 300, starvedObservations: 600, waitingWhileStarvedMs: 500 * HOUR })],
        dags: [dag('partner_feed_wait', '10 * * * *')],
        sensors: [
          {
            dagId: 'partner_feed_wait',
            taskId: 'w',
            operator: 'HttpSensor',
            mode: 'poke',
            slotSeconds: 7200,
            tries: 30,
            last: NOW,
          },
        ],
      }),
    );
    expect(result.findings[0]?.severity).toBe('critical');
    const rest = result.findings.slice(1).map((f) => f.priorityScore);
    expect(rest).toEqual([...rest].sort((a, b) => b - a));
    expect(new Set(result.findings.map((f) => f.id)).size).toBe(result.findings.length);
  });

  it('FR-ADV-08: every finding explains itself with values, thresholds and data used', () => {
    const result = run(
      signals({ capacity: bound(30), pools: [pool({ starvedMinutes: 60, starvedObservations: 120 })] }),
    );
    for (const f of result.findings) {
      expect(f.why).toMatch(/fires when/);
      expect(f.why).toMatch(/Data used/);
      expect(f.evidence.some((e) => e.threshold !== null)).toBe(true);
      expect(f.remediation.length).toBeGreaterThan(0);
      expect(f.rollback.length).toBeGreaterThan(0);
      expect(f.verify.length).toBeGreaterThan(0);
    }
  });
});
