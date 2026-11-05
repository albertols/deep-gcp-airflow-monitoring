/**
 * Concurrency-limit and pool rules (spec §13.6 CONC): global parallelism below worker capacity, pool
 * starvation, and `default_pool` overload.
 *
 * @implements REC-CONC-01, REC-CONC-02, REC-CONC-03, HM-006
 */
import type { RuleMeasurement } from './advisor-rule';
import { RULE_THRESHOLDS, evaluated, perDay, type RuleDefinition } from './advisor-rule';
import type { EnvironmentSignals, PoolSignal } from './advisor-signals';
import {
  DOCS,
  fmtHours,
  fmtHoursOf,
  fmtInt,
  fmtMinutes,
  fmtPct,
  gcloudConfigOverride,
  gcloudPoolSet,
  plural,
  terraformConfigOverride,
} from './advisor-text';

const HOUR = 3_600_000;
const DEFAULT_POOL = 'default_pool';
const SNAPSHOTS = (s: EnvironmentSignals) =>
  `live snapshots every 30 s of pools and ready task instances (${fmtPct(s.coverage.snapshots)} of the window)`;
const topDags = (m: ReadonlyMap<string, number>, n = 3) =>
  [...m]
    .slice(0, n)
    .map(([dag, ms]) => `${dag} (${fmtHours(ms / HOUR)} task-h)`)
    .join(', ');

export const REC_CONC_01: RuleDefinition = {
  id: 'REC-CONC-01',
  title: 'Global parallelism is binding',
  category: 'concurrency',
  inputs: ['snapshots'],
  wiki: 'concurrency-stack',
  evaluate(s) {
    const t = RULE_THRESHOLDS['REC-CONC-01'];
    const { config } = s;
    const total = config.parallelism * config.schedulers;
    const capacity = config.maxWorkers * config.workerConcurrency;
    const waitingMs = s.waiting.totalsMs.get('parallelism') ?? 0;
    const share = s.waiting.platformMs > 0 ? waitingMs / s.waiting.platformMs : 0;
    if (total >= capacity || waitingMs === 0 || share < t.minWaitingShare) return evaluated([]);
    const proposed = Math.ceil(capacity / config.schedulers);
    const fullPools = s.pools.filter((p) => p.starvedMinutes > 0);
    const comment = `Raise core.parallelism of ${config.envId} from ${config.parallelism} to ${proposed} per scheduler (REC-CONC-01).`;
    const overrides = { 'core-parallelism': proposed };
    const schedulers = plural(config.schedulers, 'scheduler');
    return evaluated([
      {
        scope: { kind: 'environment', id: config.envId },
        severity: 'warning',
        impactHoursPerDay: perDay(s, waitingMs / HOUR),
        observations: s.waiting.minutes.get('parallelism') ?? 0,
        agreement: 1,
        coverage: s.coverage.snapshots,
        effort: 1,
        observation:
          `core.parallelism allows ${fmtInt(total)} running and queued task instances (${config.parallelism} per ` +
          `scheduler × ${schedulers}), below the ${fmtInt(capacity)} worker slots at max_count ` +
          `(${config.maxWorkers} workers × ${config.workerConcurrency}).`,
        impactText:
          `Global parallelism caused ${fmtPct(share)} of waiting task-time (${fmtHoursOf(waitingMs / HOUR, 'task-hour')}), ` +
          'while workers could have run more tasks.',
        action:
          `Raise core.parallelism from ${config.parallelism} to ${proposed} per scheduler, so that the total matches ` +
          'worker capacity at max_count. Pools and DAG limits become the next limits; check them after the change' +
          (fullPools.length ? ` (${fullPools.map((p) => p.name).join(', ')} also ran full).` : '.'),
        why:
          'This rule fires when core.parallelism × schedulers is below max_count × worker_concurrency and "global ' +
          `parallelism" (HM-006) explains at least ${fmtPct(t.minWaitingShare)} of waiting task-time. Here ` +
          `${fmtInt(total)} < ${fmtInt(capacity)} and the share was ${fmtPct(share)}. Parallelism applies per ` +
          `scheduler. Data used: ${SNAPSHOTS(s)}, and the environment's Airflow overrides and worker settings.`,
        evidence: [
          {
            label: 'core.parallelism × schedulers',
            value: `${config.parallelism} × ${config.schedulers} = ${fmtInt(total)}`,
            threshold: `< ${fmtInt(capacity)} worker slots at max_count`,
            source: 'SRC-COMPOSER',
          },
          {
            label: 'Share of waiting caused by global parallelism',
            value: fmtPct(share),
            threshold: `≥ ${fmtPct(t.minWaitingShare)}`,
            source: 'SRC-AF-API',
          },
          {
            label: 'Waiting on global parallelism',
            value: `${fmtHours(waitingMs / HOUR)} task-h`,
            threshold: null,
            source: 'SRC-AF-API',
          },
          ...fullPools.map((p) => ({
            label: `Pool ${p.name} also ran full`,
            value: fmtMinutes(p.starvedMinutes),
            threshold: null,
            source: 'SRC-AF-API' as const,
          })),
        ],
        remediation: [
          gcloudConfigOverride(config, comment, overrides),
          terraformConfigOverride(config, comment, overrides),
        ],
        risks: [
          'More tasks run at once: load on the metadata database, the workers and external systems rises.',
          'Pools, DAG limits and worker capacity become the next limits; review them after the change.',
        ],
        rollback: `Set core-parallelism back to ${config.parallelism}, or remove the override to return to the Composer default.`,
        verify: 'Over 7 days: waiting attributed to "global parallelism" (HM-006) should drop to near zero.',
        affectedDags: [...(s.waiting.byReasonDag.get('parallelism') ?? new Map<string, number>()).keys()],
        docs: [DOCS.airflowConfig, DOCS.overrides, DOCS.optimize],
        detectedAt: s.waiting.lastSeen.get('parallelism') ?? s.to,
      },
    ]);
  },
};

function starvation(s: EnvironmentSignals, p: PoolSignal): RuleMeasurement {
  const { config } = s;
  const t = RULE_THRESHOLDS['REC-CONC-02'];
  const proposed = Math.max(p.slots + 1, Math.min(p.peakDemandSlots, 2 * p.slots));
  const bindingHours = p.bindingWaitingMs / HOUR;
  const comment = `Raise pool ${p.name} of ${config.envId} from ${p.slots} to ${proposed} slots (REC-CONC-02).`;
  return {
    scope: { kind: 'pool', id: p.name },
    severity: 'warning',
    impactHoursPerDay: perDay(s, p.waitingWhileStarvedMs / HOUR),
    observations: p.starvedObservations,
    agreement: 1,
    coverage: s.coverage.snapshots,
    effort: 1,
    observation:
      `Pool ${p.name} had no open slots (all ${p.slots} in use) while work waited for it for ` +
      `${fmtMinutes(p.starvedMinutes)} in the last 24 h. Peak demand was ${fmtInt(p.peakDemandSlots)} slots.`,
    impactText:
      `${fmtHoursOf(p.waitingWhileStarvedMs / HOUR, 'task-hour')} waited for the pool while it had no open slots. ` +
      (bindingHours > 0
        ? `HM-006 attributed ${fmtHoursOf(bindingHours, 'task-hour')} of waiting to the pool as the binding limit ` +
          "(open slots fewer than a task's pool_slots)."
        : 'HM-006 found an earlier limit first (for example global parallelism), so the pool binds once that limit is raised.'),
    action:
      `Raise the slots of ${p.name} from ${p.slots} to ${proposed} if the systems behind it can take more ` +
      'concurrent tasks; otherwise split the pool by workload class or review pool_slots of its largest tasks. ' +
      'Change it in the Airflow UI (Admin > Pools) or with the Airflow CLI below.',
    why:
      `This rule fires when a pool has zero open slots with queued or scheduled work for at least ` +
      `${t.minStarvedMinutesPerDay} min per day. Here ${p.name} was starved for ${fmtMinutes(p.starvedMinutes)}. ` +
      `Data used: ${SNAPSHOTS(s)}.`,
    evidence: [
      {
        label: 'Minutes with no open slots and work waiting',
        value: fmtMinutes(p.starvedMinutes),
        threshold: `≥ ${t.minStarvedMinutesPerDay} min per day`,
        source: 'SRC-AF-API',
      },
      { label: 'Pool slots', value: fmtInt(p.slots), threshold: null, source: 'SRC-AF-API' },
      {
        label: 'Peak demand (running + queued + ready)',
        value: `${fmtInt(p.peakDemandSlots)} slots`,
        threshold: null,
        source: 'SRC-AF-API',
      },
      {
        label: 'Waiting for the pool while it had no open slots',
        value: `${fmtHours(p.waitingWhileStarvedMs / HOUR)} task-h`,
        threshold: null,
        source: 'SRC-AF-API',
      },
      {
        label: 'Waiting with the pool as the binding limit (HM-006)',
        value: `${fmtHours(bindingHours)} task-h`,
        threshold: null,
        source: 'SRC-AF-API',
      },
      ...(p.dagWaitingMs.size
        ? [
            {
              label: 'DAGs that waited most',
              value: topDags(p.dagWaitingMs),
              threshold: null,
              source: 'SRC-AF-API' as const,
            },
          ]
        : []),
    ],
    remediation: [gcloudPoolSet(config, comment, p.name, proposed)],
    risks: [
      `More concurrent tasks reach the systems behind ${p.name}; check their rate limits first.`,
      'Other pools and worker capacity may become the next limit.',
    ],
    rollback: `Set ${p.name} back to ${p.slots} slots with the same command.`,
    verify:
      `Over 7 days: starved minutes of ${p.name} fall below ${t.minStarvedMinutesPerDay} per day and waiting ` +
      'attributed to "pool exhausted" decreases (HM-006).',
    affectedDags: [...p.dagWaitingMs.keys()],
    docs: [DOCS.pools, DOCS.airflowCli, DOCS.gcloudRun],
    detectedAt: p.lastStarved ?? s.to,
  };
}

export const REC_CONC_02: RuleDefinition = {
  id: 'REC-CONC-02',
  title: 'Pool starvation',
  category: 'concurrency',
  inputs: ['snapshots'],
  wiki: 'pools',
  evaluate(s) {
    const t = RULE_THRESHOLDS['REC-CONC-02'];
    return evaluated(
      s.pools
        .filter((p) => p.starvedMinutes > 0 && perDay(s, p.starvedMinutes) >= t.minStarvedMinutesPerDay)
        .map((p) => starvation(s, p)),
    );
  },
};

export const REC_CONC_03: RuleDefinition = {
  id: 'REC-CONC-03',
  title: 'default_pool overload',
  category: 'concurrency',
  inputs: ['snapshots', 'tries'],
  wiki: 'pools',
  evaluate(s) {
    const t = RULE_THRESHOLDS['REC-CONC-03'];
    const { config } = s;
    const total = [...s.poolSlotSeconds.values()].reduce((a, b) => a + b, 0);
    const share = total > 0 ? (s.poolSlotSeconds.get(DEFAULT_POOL) ?? 0) / total : 0;
    const p = s.pools.find((x) => x.name === DEFAULT_POOL);
    if (!p || share < t.minSlotSecondsShare || perDay(s, p.starvedMinutes) < t.minStarvedMinutesPerDay)
      return evaluated([]);
    const heaviest = [...p.dagWaitingMs.keys()][0];
    const team = (heaviest && s.dags.get(heaviest)?.team) || 'TEAM';
    const poolName = `${team.replace(/[^A-Za-z0-9_]/g, '_')}_pool`;
    return evaluated([
      {
        scope: { kind: 'pool', id: DEFAULT_POOL },
        severity: 'warning',
        impactHoursPerDay: perDay(s, p.waitingWhileStarvedMs / HOUR),
        observations: p.starvedObservations,
        agreement: 1,
        coverage: Math.min(s.coverage.snapshots, s.coverage.tries),
        effort: 5,
        observation:
          `${fmtPct(share)} of pool slot time ran in ${DEFAULT_POOL}, and it had no open slots while work waited ` +
          `for ${fmtMinutes(p.starvedMinutes)}.`,
        impactText: `${fmtHoursOf(p.waitingWhileStarvedMs / HOUR, 'task-hour')} waited for ${DEFAULT_POOL}; one busy workload can hold back every other one.`,
        action:
          'Introduce dedicated pools per workload class or team, sized from their peak demand, and assign their ' +
          `tasks with pool="…". Start with the team of the DAGs that waited most${heaviest ? ` (${heaviest})` : ''}.`,
        why:
          `This rule fires when at least ${fmtPct(t.minSlotSecondsShare)} of slot-seconds run in ${DEFAULT_POOL} and ` +
          `it starves for at least ${t.minStarvedMinutesPerDay} min per day. Here the share was ${fmtPct(share)} ` +
          `and it starved for ${fmtMinutes(p.starvedMinutes)}. Data used: task instance tries (HM-003) and ${SNAPSHOTS(s)}.`,
        evidence: [
          {
            label: `Share of pool slot time in ${DEFAULT_POOL}`,
            value: fmtPct(share),
            threshold: `≥ ${fmtPct(t.minSlotSecondsShare)}`,
            source: 'SRC-AF-API',
          },
          {
            label: 'Minutes with no open slots and work waiting',
            value: fmtMinutes(p.starvedMinutes),
            threshold: `≥ ${t.minStarvedMinutesPerDay} min per day`,
            source: 'SRC-AF-API',
          },
        ],
        remediation: [
          gcloudPoolSet(
            config,
            `Create a dedicated pool ${poolName} (REC-CONC-03); size it from the team's peak demand.`,
            poolName,
            'SLOTS',
          ),
          {
            kind: 'dag-diff',
            title: 'DAG change',
            language: 'diff',
            code: [
              `# In the team's DAG files: run their tasks in ${poolName} instead of ${DEFAULT_POOL}.`,
              '-    task = SomeOperator(task_id="...", ...)',
              `+    task = SomeOperator(task_id="...", ..., pool="${poolName}")`,
            ].join('\n'),
          },
        ],
        risks: [
          'Slots split across pools can sit idle in one pool while another queues; size them from observed demand.',
          'Every DAG that moves needs a code change and a deployment.',
        ],
        rollback: `Move the tasks back to ${DEFAULT_POOL} and delete the new pool.`,
        verify: `Over 7 days: starved minutes of ${DEFAULT_POOL} fall below ${t.minStarvedMinutesPerDay} per day (HM-006).`,
        affectedDags: [...p.dagWaitingMs.keys()],
        docs: [DOCS.pools, DOCS.airflowCli],
        detectedAt: p.lastStarved ?? s.to,
      },
    ]);
  },
};
