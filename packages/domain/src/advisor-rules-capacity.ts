/**
 * Capacity and autoscaling rules (spec §13.6 CAP): workers at maximum while tasks are queued,
 * under-packed workers, and scale-out suppressed by a high `worker_concurrency`.
 *
 * REC-CAP-01 follows the catalog condition "for ≥ 15 min in 24 h" as a total over the window; the
 * §13.7 worked SQL keeps only stretches of ≥ 15 consecutive minutes (⚠️ the spec disagrees with
 * itself; stretches are shown as evidence).
 *
 * @implements REC-CAP-01, REC-CAP-05, REC-CAP-08, HM-011, HM-027
 */
import { RULE_THRESHOLDS, evaluated, perDay, type RuleDefinition } from './advisor-rule';
import { BOUND_MIN_QUEUED, BOUND_QUEUED_RATIO, type EnvironmentSignals } from './advisor-signals';
import {
  DOCS,
  fmtDuration,
  fmtHours,
  fmtHoursOf,
  fmtInt,
  fmtMinutes,
  fmtPct,
  gcloudConfigOverride,
  gcloudWorkers,
  plural,
  terraformConfigOverride,
  terraformWorkers,
} from './advisor-text';

const HOUR = 3_600_000;
const windowLabel = (s: EnvironmentSignals) => `${fmtInt((s.to - s.from) / HOUR)} h`;
const workerSettings = (s: EnvironmentSignals) =>
  `min_count ${s.config.minWorkers}, max_count ${s.config.maxWorkers}, worker_concurrency ${s.config.workerConcurrency}`;
const dagsFor = (s: EnvironmentSignals, reason: 'executor-slots-exhausted' | 'unknown') => [
  ...(s.waiting.byReasonDag.get(reason) ?? new Map<string, number>()).keys(),
];
const CAP05 = RULE_THRESHOLDS['REC-CAP-05'];

export const REC_CAP_01: RuleDefinition = {
  id: 'REC-CAP-01',
  title: 'Workers at maximum while tasks are queued',
  category: 'capacity',
  inputs: ['samples'],
  wiki: 'worker-scaling',
  inhibits: ['REC-CAP-05'],
  evaluate(s) {
    const t = RULE_THRESHOLDS['REC-CAP-01'];
    const { config } = s;
    const b = s.capacity.bound;
    const minMinutes = config.tier === 'dev' ? t.devMinMinutesPerDay : t.minMinutesPerDay;
    const minutesPerDay = perDay(s, b.minutes);
    if (b.minutes === 0 || minutesPerDay < minMinutes) return evaluated([]);

    const w = windowLabel(s);
    const slots = config.maxWorkers * config.workerConcurrency;
    const minQueued = Math.ceil(Math.max(BOUND_MIN_QUEUED, BOUND_QUEUED_RATIO * slots));
    const demand = b.demandP95 ?? 0;
    const proposed = Math.max(config.maxWorkers + 1, Math.ceil(demand / config.workerConcurrency));
    const longest = b.episodes.reduce((m, e) => Math.max(m, e.minutes), 0);
    const exhaustedHours = (s.waiting.totalsMs.get('executor-slots-exhausted') ?? 0) / HOUR;
    const agreeing = (s.waiting.minutes.get('executor-slots-exhausted') ?? 0) > 0;
    const roomToPack =
      b.cpuP95 !== null &&
      b.memoryP95 !== null &&
      b.cpuP95 < CAP05.cpuP95Below &&
      b.memoryP95 < CAP05.memoryP95Below;
    const comment = `Raise the worker maximum of ${config.envId} from ${config.maxWorkers} to ${proposed} (REC-CAP-01).`;

    return evaluated([
      {
        scope: { kind: 'environment', id: config.envId },
        severity: minutesPerDay >= t.criticalMinutes ? 'critical' : 'warning',
        impactHoursPerDay: perDay(s, b.queuedTaskMinutes / 60),
        observations: b.minutes,
        agreement: agreeing ? 1 : 0.75,
        coverage: s.coverage.samples,
        effort: 2,
        observation:
          `Workers stayed at the maximum of ${config.maxWorkers} for ${fmtMinutes(b.minutes)} in the last ${w} ` +
          `while up to ${fmtInt(b.queuedPeak)} tasks were queued (${plural(b.episodes.length, 'stretch', 'stretches')}; ` +
          `the longest lasted ${fmtMinutes(longest)}).`,
        impactText:
          (b.maxQueueWaitMs === null
            ? ''
            : `Tasks queued in those minutes waited up to ${fmtDuration(b.maxQueueWaitMs)} for a worker slot; `) +
          `${fmtHoursOf(b.queuedTaskMinutes / 60, 'task-hour')} were spent queued.`,
        action:
          `Stagger colliding schedules first. If the peaks are not schedule-driven, raise max_count from ` +
          `${config.maxWorkers} to ${proposed}: ${proposed} workers cover the p95 demand of ${fmtInt(demand)} running ` +
          `and queued tasks at ${config.workerConcurrency} slots each. ` +
          (roomToPack
            ? 'Worker CPU and memory had room, so raising worker_concurrency is an alternative.'
            : `Raising worker_concurrency is not advised: worker CPU p95 was ${fmtPct(b.cpuP95)} and memory p95 ` +
              `${fmtPct(b.memoryP95)} in those minutes (it needs CPU below 30% and memory below 40%).`),
        why:
          `This rule fires when workers equal max_count (${config.maxWorkers}) and at least max(10, 20% of ` +
          `${fmtInt(slots)} worker slots) = ${minQueued} task instances are queued in the executor for at least ` +
          `${t.minMinutesPerDay} min in 24 h (${t.devMinMinutesPerDay} min on development tiers); it becomes ` +
          `critical at ${t.criticalMinutes} min. Here that held for ${fmtMinutes(b.minutes)}, and HM-006 attributed ` +
          `${fmtHoursOf(exhaustedHours, 'task-hour')} of waiting to "executor slots exhausted". Data used: one-minute ` +
          `worker samples (${fmtPct(s.coverage.samples)} of the last ${w}), live snapshots every 30 s and the ` +
          `environment's worker settings.`,
        evidence: [
          {
            label: `Capacity-bound minutes in ${w}`,
            value: fmtMinutes(b.minutes),
            threshold: `≥ ${minMinutes} min (critical at ≥ ${t.criticalMinutes} min)`,
            source: 'SRC-MON',
          },
          {
            label: 'Peak executor-queued tasks while bound',
            value: fmtInt(b.queuedPeak),
            threshold: `≥ ${minQueued} in a bound minute`,
            source: 'SRC-MON',
          },
          {
            label: 'Minutes at max_count',
            value: `${fmtMinutes(s.capacity.minutesAtMax)} at ${config.maxWorkers} workers`,
            threshold: null,
            source: 'SRC-MON',
          },
          {
            label: 'Longest capacity-bound stretch',
            value: `${fmtMinutes(longest)} (${plural(b.episodes.length, 'stretch', 'stretches')})`,
            threshold: null,
            source: 'SRC-MON',
          },
          {
            label: 'Task-hours queued while bound',
            value: `${fmtHours(b.queuedTaskMinutes / 60)} task-h`,
            threshold: null,
            source: 'SRC-MON',
          },
          {
            label: 'Waiting on "executor slots exhausted" (HM-006)',
            value: `${fmtHours(exhaustedHours)} task-h`,
            threshold: null,
            source: 'SRC-AF-API',
          },
          {
            label: 'Longest queue wait of tasks queued while bound',
            value: fmtDuration(b.maxQueueWaitMs),
            threshold: null,
            source: 'SRC-AF-API',
          },
          {
            label: 'Worker CPU p95 while bound',
            value: fmtPct(b.cpuP95),
            threshold: '< 30% to raise worker_concurrency',
            source: 'SRC-MON',
          },
          {
            label: 'Worker memory p95 while bound',
            value: fmtPct(b.memoryP95),
            threshold: '< 40% to raise worker_concurrency',
            source: 'SRC-MON',
          },
          { label: 'Worker settings', value: workerSettings(s), threshold: null, source: 'SRC-COMPOSER' },
        ],
        remediation: [
          gcloudWorkers(config, comment, '--max-workers', proposed),
          terraformWorkers(config, comment, 'max_count', proposed),
        ],
        risks: [
          'Higher maximum increases peak cost.',
          'More concurrent tasks increase load on the metadata database and external systems.',
        ],
        rollback: `Restore max_count to ${config.maxWorkers} with the same command; the change takes effect after the environment update completes.`,
        verify:
          'Compare 7 days before and after the change: the share of waiting attributed to "executor slots exhausted" ' +
          `(HM-006) should decrease, and capacity-bound minutes should stay below ${minMinutes} per day.`,
        affectedDags: dagsFor(s, 'executor-slots-exhausted'),
        docs: [DOCS.optimize, DOCS.scale, DOCS.gcloudUpdate, DOCS.terraform],
        detectedAt: b.last ?? s.to,
      },
    ]);
  },
};

export const REC_CAP_05: RuleDefinition = {
  id: 'REC-CAP-05',
  title: 'Under-packed workers',
  category: 'capacity',
  inputs: ['samples'],
  wiki: 'worker-concurrency',
  evaluate(s) {
    const t = CAP05;
    const f = s.capacity.slotsFullAtMax;
    const { config } = s;
    const conc = config.workerConcurrency;
    if (f.cpuP95 === null || f.memoryP95 === null || perDay(s, f.minutes) < t.minMinutesPerDay)
      return evaluated([]);
    if (f.cpuP95 >= t.cpuP95Below || f.memoryP95 >= t.memoryP95Below || conc >= t.maxConcurrency)
      return evaluated([]);
    // ⚠️ Step of +50 %, capped at Composer 3's maximum of 24: the spec names no step size.
    const proposed = Math.min(t.maxConcurrency, Math.max(conc + 1, Math.round(conc * 1.5)));
    const comment = `Raise worker_concurrency of ${config.envId} from ${conc} to ${proposed} (REC-CAP-05).`;
    const overrides = { 'celery-worker_concurrency': proposed };
    return evaluated([
      {
        scope: { kind: 'environment', id: config.envId },
        severity: 'warning',
        impactHoursPerDay: perDay(s, f.queuedTaskMinutes / 60),
        observations: f.minutes,
        agreement: 1,
        coverage: s.coverage.samples,
        effort: 1,
        observation:
          `Worker slots were full at the maximum of ${config.maxWorkers} workers for ${fmtMinutes(f.minutes)} while ` +
          `worker CPU p95 was ${fmtPct(f.cpuP95)} and memory p95 ${fmtPct(f.memoryP95)}.`,
        impactText: `${fmtHoursOf(f.queuedTaskMinutes / 60, 'task-hour')} were queued for a free slot while worker CPU and memory sat mostly idle.`,
        action:
          `Raise worker_concurrency from ${conc} to ${proposed} for I/O-bound workloads, then check worker CPU and ` +
          'memory; Composer 3 accepts values from 1 to 24.',
        why:
          'This rule fires when executor slots are exhausted at max_count (HM-006) while worker CPU p95 is below 30% ' +
          `and memory p95 below 40% (HM-027), for at least ${t.minMinutesPerDay} min in 24 h. Here CPU p95 was ` +
          `${fmtPct(f.cpuP95)} and memory p95 ${fmtPct(f.memoryP95)} over ${fmtMinutes(f.minutes)}. Composer's ` +
          'documented sizing guidance is at most 12 tasks per vCPU and 8 per GB of worker memory (⚠️ VERIFY, VC-19). ' +
          'Data used: one-minute worker samples (highest worker CPU and memory per minute) and the worker settings.',
        evidence: [
          {
            label: 'Minutes with slots full at max_count',
            value: fmtMinutes(f.minutes),
            threshold: `≥ ${t.minMinutesPerDay} min`,
            source: 'SRC-MON',
          },
          {
            label: 'Worker CPU p95 in those minutes',
            value: fmtPct(f.cpuP95),
            threshold: '< 30%',
            source: 'SRC-MON',
          },
          {
            label: 'Worker memory p95 in those minutes',
            value: fmtPct(f.memoryP95),
            threshold: '< 40%',
            source: 'SRC-MON',
          },
          { label: 'worker_concurrency', value: fmtInt(conc), threshold: '< 24', source: 'SRC-COMPOSER' },
        ],
        remediation: [
          gcloudConfigOverride(config, comment, overrides),
          terraformConfigOverride(config, comment, overrides),
        ],
        risks: [
          'More tasks per worker share its CPU and memory; heavy tasks slow down or fail with out-of-memory errors.',
          'A high worker_concurrency can stop the autoscaler from adding workers (REC-CAP-08).',
        ],
        rollback: `Restore celery-worker_concurrency to ${conc}, or remove the override; workers pick it up after the environment update.`,
        verify:
          'Over 7 days: waiting on "executor slots exhausted" (HM-006) falls, while worker memory p95 stays below 85% (HM-027).',
        affectedDags: dagsFor(s, 'executor-slots-exhausted'),
        docs: [DOCS.optimize, DOCS.overrides, DOCS.airflowConfig],
        detectedAt: f.last ?? s.to,
      },
    ]);
  },
};

export const REC_CAP_08: RuleDefinition = {
  id: 'REC-CAP-08',
  title: 'Scale-out suppressed by high worker_concurrency',
  category: 'capacity',
  inputs: ['samples'],
  wiki: 'worker-concurrency',
  evaluate(s) {
    const t = RULE_THRESHOLDS['REC-CAP-08'];
    const x = s.capacity.scaleOutSuppressed;
    const { config } = s;
    const conc = config.workerConcurrency;
    const load = Math.max(x.cpuP95 ?? 0, x.memoryP95 ?? 0);
    if (perDay(s, x.minutes) < t.minMinutesPerDay || load < t.loadP95AtLeast) return evaluated([]);
    const r = s.workerResources;
    if (!r)
      return {
        kind: 'insufficient',
        reason:
          'Worker CPU and memory sizes are not collected yet, so the worker_concurrency guidance cannot be checked.',
      };
    // Documented guidance (VC-19): at most 12 tasks per vCPU and 8 per GB of memory, and 24 on Composer 3.
    const ceiling = Math.max(
      1,
      Math.min(t.maxConcurrency, Math.floor(12 * r.cpu), Math.floor(8 * r.memoryGb)),
    );
    if (conc <= ceiling) return evaluated([]);
    const comment = `Lower worker_concurrency of ${config.envId} from ${conc} to ${ceiling} (REC-CAP-08).`;
    const overrides = { 'celery-worker_concurrency': ceiling };
    return evaluated([
      {
        scope: { kind: 'environment', id: config.envId },
        severity: 'warning',
        impactHoursPerDay: perDay(s, x.minutes / 60),
        observations: x.minutes,
        agreement: 1,
        coverage: s.coverage.samples,
        effort: 1,
        observation:
          `For ${fmtMinutes(x.minutes)}, workers stayed below max_count (${config.maxWorkers}) and the autoscaler did ` +
          `not ask for more, while worker slots were ${fmtPct(x.utilisationMean)} occupied and worker CPU p95 reached ` +
          `${fmtPct(x.cpuP95)} (memory p95 ${fmtPct(x.memoryP95)}).`,
        impactText:
          'Tasks ran on overloaded workers instead of new ones: expect slower tasks and out-of-memory failures.',
        action:
          `Lower worker_concurrency from ${conc} to ${ceiling}, the documented guidance for workers with ${r.cpu} vCPU ` +
          `and ${r.memoryGb} GB, so that the autoscaler adds workers; for many short tasks, raise min_count instead.`,
        why:
          'This rule fires when workers are below max_count, the scale target stays at the current worker count, ' +
          `worker CPU or memory p95 is at least 85% with slots mostly occupied (≥ 80%), and worker_concurrency is ` +
          `above the documented guidance (⚠️ VERIFY, VC-19), for at least ${t.minMinutesPerDay} min in 24 h. Here ` +
          `the load p95 was ${fmtPct(load)} over ${fmtMinutes(x.minutes)} and ${conc} > ${ceiling}. Data used: ` +
          'one-minute worker samples with the autoscaler target, and the worker size and settings.',
        evidence: [
          {
            label: 'Minutes without scale-out at high slot use',
            value: fmtMinutes(x.minutes),
            threshold: `≥ ${t.minMinutesPerDay} min`,
            source: 'SRC-MON',
          },
          { label: 'Worker CPU or memory p95', value: fmtPct(load), threshold: '≥ 85%', source: 'SRC-MON' },
          {
            label: 'worker_concurrency vs guidance',
            value: `${conc} vs ${ceiling}`,
            threshold: `≤ ${ceiling}`,
            source: 'SRC-COMPOSER',
          },
          { label: 'Worker settings', value: workerSettings(s), threshold: null, source: 'SRC-COMPOSER' },
        ],
        remediation: [
          gcloudConfigOverride(config, comment, overrides),
          terraformConfigOverride(config, comment, overrides),
        ],
        risks: [
          'Each worker runs fewer tasks; the same load needs more workers, which can raise cost.',
          'With a low max_count, lower concurrency can turn into queueing at the maximum (REC-CAP-01).',
        ],
        rollback: `Restore celery-worker_concurrency to ${conc}, or remove the override.`,
        verify:
          'Over 7 days: worker CPU and memory p95 stay below 85% and the autoscaler adds workers at peaks (HM-012, HM-027).',
        affectedDags: dagsFor(s, 'unknown'),
        docs: [DOCS.optimize, DOCS.scale, DOCS.overrides],
        detectedAt: x.last ?? s.to,
      },
    ]);
  },
};
