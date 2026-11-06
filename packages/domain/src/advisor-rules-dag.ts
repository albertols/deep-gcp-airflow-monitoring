/**
 * DAG design and schedule rules (spec §13.6 DAG and SCHED): DAGs throttled by their own
 * `max_active_tasks`, poke-mode sensors holding worker slots, and schedules colliding in one minute.
 *
 * @implements REC-DAG-01, REC-DAG-05, REC-SCHED-01, HM-005, HM-008, HM-009, FR-BOTL-04
 */
import type { RuleMeasurement } from './advisor-rule';
import { RULE_THRESHOLDS, evaluated, perDay, type RuleDefinition } from './advisor-rule';
import type { DagLimitSignal, EnvironmentSignals, SensorSignal } from './advisor-signals';
import { DOCS, fmtCadence, fmtHours, fmtHoursOf, fmtInt, fmtMinutes, fmtPct, plural } from './advisor-text';
import { dailyStartsByMinute, withStartMinute } from './schedule';

const HOUR = 3_600_000;
/** ⚠️ Share of at-limit time with free worker slots above which DCAM calls it headroom (spec open). */
const HEADROOM_SHARE = 0.5;
/** ⚠️ Stagger suggestions cover the heaviest colliding DAGs only (spec open). */
const STAGGER_MAX_DAGS = 10;
/** Minutes either side counted as overlapping demand when choosing a stagger minute (⚠️ spec open). */
const STAGGER_SPREAD = 4;

const fileOf = (s: EnvironmentSignals, dagId: string) => s.dags.get(dagId)?.fileloc ?? `${dagId}.py`;
const pyName = (taskId: string) => {
  const name = taskId.replace(/[^A-Za-z0-9_]/g, '_');
  return /^[0-9]/.test(name) ? `task_${name}` : name;
};

function throttled(s: EnvironmentSignals, d: DagLimitSignal): RuleMeasurement {
  const t = RULE_THRESHOLDS['REC-DAG-01'];
  const share = d.activeMs > 0 ? d.atLimitMs / d.activeMs : 0;
  // `null` while worker_concurrency is unknown (HM-032): DCAM cannot tell free worker slots from full ones.
  const headroom = d.headroomObservations === null ? null : d.headroomObservations / d.atLimitObservations;
  const proposed = Math.max(d.limit + 1, d.peakDemand);
  const ownHours = d.ownWaitingMs / HOUR;
  const header = `# ${d.dagId} (${fileOf(s, d.dagId)}): in the DAG(...) arguments`;
  return {
    scope: { kind: 'dag', id: d.dagId },
    severity: 'warning',
    impactHoursPerDay: perDay(s, ownHours),
    observations: d.atLimitObservations,
    agreement: 1,
    coverage: s.coverage.snapshots,
    effort: 3,
    observation:
      `${d.dagId} was at its max_active_tasks limit of ${d.limit} in ${fmtPct(share)} of its active time ` +
      `(${fmtMinutes(d.atLimitMs / 60_000)} of ${fmtMinutes(d.activeMs / 60_000)}) ` +
      `with its own ready tasks waiting; up to ${fmtInt(d.peakDemand)} of its tasks were ready, queued or running at once.`,
    impactText: `Its tasks waited ${fmtHoursOf(ownHours, 'task-hour')} for the DAG's own limit, which stretches its runs.`,
    action:
      headroom === null
        ? `Raise max_active_tasks from ${d.limit} to ${proposed} if the environment has free worker slots while ` +
          'the DAG is at its limit. DCAM cannot tell yet: worker_concurrency is not known (no override in the ' +
          'Composer configuration), so check worker load first.'
        : headroom >= HEADROOM_SHARE
          ? `Raise max_active_tasks from ${d.limit} to ${proposed}: the environment had free worker slots in ` +
            `${fmtPct(headroom)} of those minutes.`
          : `Raise max_active_tasks from ${d.limit} to ${proposed} only once the environment has headroom: worker ` +
            `slots were free in only ${fmtPct(headroom)} of those minutes, so address worker capacity first (REC-CAP-01).`,
    why:
      `This rule fires when a DAG is at its max_active_tasks limit for at least ${fmtPct(t.minAtLimitShare)} of ` +
      `its active time with its own tasks waiting (HM-005). Here it was ${fmtPct(share)}. On Airflow ` +
      `${s.config.airflowVersion} the limit counts running and queued task instances across all active runs of the DAG. ` +
      (d.limitIsDefault
        ? `The DAG does not set max_active_tasks, so it uses core.max_active_tasks_per_dag (${s.config.maxActiveTasksPerDag}). `
        : '') +
      `Data used: live snapshots every ${fmtCadence(s.snapshotCadenceMs)} of running, queued and ready task ` +
      'instances per DAG.',
    evidence: [
      {
        label: 'Share of active time at max_active_tasks',
        value: fmtPct(share),
        threshold: `≥ ${fmtPct(t.minAtLimitShare)}`,
        source: 'SRC-AF-API',
      },
      { label: 'max_active_tasks', value: fmtInt(d.limit), threshold: null, source: 'SRC-AF-API' },
      {
        label: 'Peak ready, queued and running tasks of the DAG',
        value: fmtInt(d.peakDemand),
        threshold: null,
        source: 'SRC-AF-API',
      },
      {
        label: 'Own tasks waiting at the limit',
        value: `${fmtHours(ownHours)} task-h`,
        threshold: null,
        source: 'SRC-AF-API',
      },
      {
        label: 'At-limit time with free worker slots',
        value: headroom === null ? 'Not known' : fmtPct(headroom),
        threshold: `≥ ${fmtPct(HEADROOM_SHARE)} counts as headroom`,
        source: 'SRC-AF-API',
      },
    ],
    remediation: [
      {
        kind: 'dag-diff',
        title: 'DAG change',
        language: 'diff',
        code: (d.limitIsDefault
          ? [header, `     dag_id="${d.dagId}",`, `+    max_active_tasks=${proposed},`]
          : [header, `-    max_active_tasks=${d.limit},`, `+    max_active_tasks=${proposed},`]
        ).join('\n'),
      },
    ],
    risks: [
      "More of this DAG's tasks run at once; it takes a larger share of worker slots and pools from other DAGs.",
      'On Airflow 2 the limit spans all active runs of the DAG; several active runs share it.',
    ],
    rollback: `Restore max_active_tasks=${d.limit} and redeploy the DAG file.`,
    verify: `Over 7 days: the DAG's time at max_active_tasks (HM-005) falls below ${fmtPct(t.minAtLimitShare)} of its active time.`,
    affectedDags: [d.dagId],
    docs: [DOCS.dags, DOCS.airflowConfig, DOCS.troubleshootingScheduling],
    detectedAt: d.lastAtLimit ?? s.to,
  };
}

export const REC_DAG_01: RuleDefinition = {
  id: 'REC-DAG-01',
  title: 'DAG throttled by max_active_tasks',
  category: 'dag',
  inputs: ['snapshots'],
  wiki: 'concurrency-stack',
  evaluate(s) {
    const t = RULE_THRESHOLDS['REC-DAG-01'];
    return evaluated(
      s.dagLimits
        .filter((d) => d.activeMs > 0 && d.atLimitMs / d.activeMs >= t.minAtLimitShare)
        .map((d) => throttled(s, d)),
    );
  },
};

function sensorWaste(s: EnvironmentSignals, x: SensorSignal): RuleMeasurement {
  const t = RULE_THRESHOLDS['REC-DAG-05'];
  const hours = x.slotSeconds / 3600;
  const total = [...s.slotSecondsByDag.values()].reduce((a, b) => a + b, 0);
  const v = pyName(x.taskId);
  const header = `# ${x.dagId} (${fileOf(s, x.dagId)}), task ${x.taskId}`;
  const before = `-${v} = ${x.operator}(task_id="${x.taskId}", ...)`;
  return {
    scope: { kind: 'task', id: `${x.dagId}/${x.taskId}` },
    severity: 'warning',
    impactHoursPerDay: perDay(s, hours),
    observations: x.tries,
    agreement: 1,
    coverage: s.coverage.tries,
    effort: 3,
    observation:
      `Sensor ${x.taskId} in ${x.dagId} (${x.operator}) held a worker slot for ${fmtHoursOf(hours, 'slot-hour')} in the ` +
      `last 24 h across ${plural(x.tries, 'try', 'tries')}. DCAM saw no reschedule or deferral, so it runs in poke mode.`,
    impactText:
      `Those slot-hours were spent waiting, not working` +
      (total > 0 ? ` (${fmtPct(x.slotSeconds / total)} of all executor slot time)` : '') +
      '; other tasks could have used the slot.',
    action:
      `Switch the sensor to mode="reschedule" so that it frees its slot between checks, or use the deferrable form ` +
      `of ${x.operator} if it has one; deferrable operators need a triggerer.`,
    why:
      `This rule fires when a poke-mode sensor uses at least ${t.minSlotHoursPerDay} slot-hour per day (HM-008). ` +
      `Here it used ${fmtHours(hours)}. DCAM infers the mode from observed states: up_for_reschedule means ` +
      'reschedule mode, deferred means deferrable, otherwise poke. Sensors are recognised by an operator name ' +
      'ending in "Sensor". Data used: task instance tries of the last 24 h.',
    evidence: [
      {
        label: 'Worker slot time held',
        value: `${fmtHours(hours)} slot-h`,
        threshold: `≥ ${t.minSlotHoursPerDay} slot-h per day`,
        source: 'SRC-AF-API',
      },
      { label: 'Inferred mode', value: x.mode, threshold: 'poke', source: 'SRC-AF-API' },
      { label: 'Tries', value: fmtInt(x.tries), threshold: null, source: 'SRC-AF-API' },
    ],
    remediation: [
      {
        kind: 'dag-diff',
        title: 'Reschedule mode',
        language: 'diff',
        code: [
          header,
          '# Keep poke_interval at a minute or more: each check becomes a short task try.',
          before,
          `+${v} = ${x.operator}(task_id="${x.taskId}", ..., mode="reschedule")`,
        ].join('\n'),
      },
      {
        kind: 'dag-diff',
        title: 'Deferrable operator',
        language: 'diff',
        code: [
          header,
          `# Only if ${x.operator} accepts deferrable=True in your Airflow or provider version (⚠️ VERIFY),`,
          '# and the environment runs a triggerer.',
          before,
          `+${v} = ${x.operator}(task_id="${x.taskId}", ..., deferrable=True)`,
        ].join('\n'),
      },
    ],
    risks: [
      'In reschedule mode every check is a new short task try; very short poke intervals add scheduler and database load.',
      'Deferrable operators need a running triggerer; without one, deferred tasks never resume.',
    ],
    rollback: 'Remove mode="reschedule" (or deferrable=True) and redeploy the DAG file.',
    verify: `Over 7 days: the sensor's slot time (HM-008) falls below ${t.minSlotHoursPerDay} slot-hour per day.`,
    affectedDags: [x.dagId],
    docs: [DOCS.sensors, DOCS.deferring],
    detectedAt: x.last,
  };
}

export const REC_DAG_05: RuleDefinition = {
  id: 'REC-DAG-05',
  title: 'Sensor slot waste',
  category: 'dag',
  inputs: ['tries'],
  wiki: 'sensor-slot-waste',
  evaluate(s) {
    const t = RULE_THRESHOLDS['REC-DAG-05'];
    return evaluated(
      s.sensors
        .filter((x) => x.mode === 'poke' && perDay(s, x.slotSeconds / 3600) >= t.minSlotHoursPerDay)
        .map((x) => sensorWaste(s, x)),
    );
  },
};

interface StaggerMove {
  readonly dagId: string;
  readonly from: string;
  readonly to: string;
}

/**
 * FR-BOTL-04 (first version): moves the heaviest DAGs that start in the busiest minute up to
 * `windowMinutes` later, each to the minute with the least expected demand around it. Demand per minute
 * is the slot-seconds of the DAGs starting there, spread over their daily starts.
 */
function staggerPlan(s: EnvironmentSignals, minute: number, windowMinutes: number): StaggerMove[] {
  const demand = new Array<number>(60).fill(0);
  const profile = new Map<string, { starts: number[]; weight: number }>();
  for (const d of s.dags.values()) {
    if (d.paused) continue;
    const starts = dailyStartsByMinute(d.schedule);
    if (!starts) continue;
    const total = starts.reduce((a, b) => a + b, 0);
    const weight = Math.max(1, s.slotSecondsByDag.get(d.dagId) ?? 0) / total;
    profile.set(d.dagId, { starts, weight });
    starts.forEach((n, m) => (demand[m] = (demand[m] ?? 0) + n * weight));
  }
  const around = (m: number) => {
    let sum = 0;
    for (let k = -STAGGER_SPREAD; k <= STAGGER_SPREAD; k++) sum += demand[(m + k + 60) % 60] ?? 0;
    return sum;
  };
  const candidates = s.schedules.dagsInBusiestMinute
    .map((d) => d.dagId)
    .filter((id) => withStartMinute(s.dags.get(id)?.schedule ?? '', minute) !== null)
    .sort((a, b) => (s.slotSecondsByDag.get(b) ?? 0) - (s.slotSecondsByDag.get(a) ?? 0) || (a < b ? -1 : 1))
    .slice(0, STAGGER_MAX_DAGS);
  const moves: StaggerMove[] = [];
  for (const dagId of candidates) {
    const p = profile.get(dagId);
    const schedule = s.dags.get(dagId)?.schedule;
    if (!p || !schedule) continue;
    const load = (p.starts[minute] ?? 0) * p.weight;
    demand[minute] = (demand[minute] ?? 0) - load;
    let best = minute;
    for (let m = minute; m <= Math.min(59, minute + windowMinutes); m++)
      if (around(m) < around(best) - 1e-9) best = m;
    demand[best] = (demand[best] ?? 0) + load;
    const to = withStartMinute(schedule, best);
    if (best !== minute && to) moves.push({ dagId, from: schedule, to });
  }
  return moves;
}

export const REC_SCHED_01: RuleDefinition = {
  id: 'REC-SCHED-01',
  title: 'Schedule collisions',
  category: 'scheduling',
  inputs: ['snapshots'],
  wiki: 'schedule-collisions',
  evaluate(s) {
    const t = RULE_THRESHOLDS['REC-SCHED-01'];
    const d = s.schedules;
    const m = d.busiestMinute;
    if (m === null || d.collisionIndex < t.minCollisionIndex) return evaluated([]);
    const hour = s.waiting.byMinuteOfHour;
    const inWindow = Array.from({ length: t.windowMinutes }, (_, k) => (m + k) % 60);
    const windowMs = inWindow.reduce((sum, x) => sum + (hour.waitingMs[x] ?? 0), 0);
    const totalMs = hour.waitingMs.reduce((a, b) => a + b, 0);
    const share = totalMs > 0 ? windowMs / totalMs : 0;
    if (windowMs === 0 || share < t.minWaitingShare) return evaluated([]);

    const moves = staggerPlan(s, m, t.windowMinutes);
    const colliding = [...d.dagsInBusiestMinute]
      .map((x) => x.dagId)
      .sort(
        (a, b) => (s.slotSecondsByDag.get(b) ?? 0) - (s.slotSecondsByDag.get(a) ?? 0) || (a < b ? -1 : 1),
      );
    const seen = inWindow.map((x) => hour.last[x]).filter((at): at is number => typeof at === 'number');
    const last = seen.length ? Math.max(...seen) : null;
    const windowHours = windowMs / HOUR;
    const observations = inWindow.reduce((sum, x) => sum + (hour.minutes[x] ?? 0), 0);
    return evaluated([
      {
        scope: { kind: 'environment', id: s.config.envId },
        severity: 'warning',
        impactHoursPerDay: perDay(s, windowHours),
        observations,
        agreement: 1,
        coverage: s.coverage.snapshots,
        effort: 5,
        observation:
          `${fmtPct(d.collisionIndex)} of the ${fmtInt(d.totalDailyStarts)} daily scheduled starts fall in minute ${m} ` +
          `of the hour (${plural(colliding.length, 'DAG')}), and ${fmtPct(share)} of waiting task-time happened in the ` +
          `${t.windowMinutes} minutes from that minute.`,
        impactText:
          `${fmtHoursOf(windowHours, 'task-hour')} of waiting fell in those ${t.windowMinutes} minutes of each hour; ` +
          'spreading the starts lowers the peaks that fill worker slots and pools.',
        action:
          `Move the start minute of the heaviest colliding DAGs a few minutes later, within ${t.windowMinutes} ` +
          'minutes, as in the snippet. Start with DAGs whose consumers tolerate a later start; each change is one ' +
          'line in the DAG file.',
        why:
          `This rule fires when at least ${fmtPct(t.minCollisionIndex)} of daily scheduled starts fall in one ` +
          'minute-of-hour (HM-009) and that minute coincides with queueing (HM-006). DCAM counts it as coinciding ' +
          `when at least ${fmtPct(t.minWaitingShare)} of the waiting on platform limits falls in the ` +
          `${t.windowMinutes} minutes from that minute (⚠️ the spec does not quantify "coinciding"). Here the ` +
          `collision index was ${fmtPct(d.collisionIndex)} and the share ${fmtPct(share)}. Data used: schedules of ` +
          `unpaused DAGs (${plural(d.unscheduled.length, 'DAG')} without a fixed start minute not counted) and live ` +
          `snapshots every ${fmtCadence(s.snapshotCadenceMs)}.`,
        evidence: [
          {
            label: `Share of daily starts in minute ${m}`,
            value: fmtPct(d.collisionIndex),
            threshold: `≥ ${fmtPct(t.minCollisionIndex)}`,
            source: 'SRC-AF-API',
          },
          {
            label: `Share of waiting in minutes ${m}–${(m + t.windowMinutes - 1) % 60}`,
            value: fmtPct(share),
            threshold: `≥ ${fmtPct(t.minWaitingShare)}`,
            source: 'SRC-AF-API',
          },
          {
            label: 'Daily scheduled starts',
            value: `${fmtInt(d.totalDailyStarts)} (${fmtInt(d.perMinute[m] ?? 0)} in minute ${m})`,
            threshold: null,
            source: 'SRC-AF-API',
          },
          {
            label: 'DAGs starting in that minute',
            value: fmtInt(colliding.length),
            threshold: null,
            source: 'SRC-AF-API',
          },
        ],
        remediation: moves.length
          ? [
              {
                kind: 'dag-diff',
                title: 'Stagger schedules',
                language: 'diff',
                code: [
                  `# Stagger the heaviest DAGs that start at minute ${m} (REC-SCHED-01): each moves at most`,
                  `# ${t.windowMinutes} minutes later, to the minute with the least expected demand. DAG files that`,
                  '# still use schedule_interval= take the same change.',
                  ...moves.flatMap((x) => [
                    `# ${x.dagId} (${fileOf(s, x.dagId)})`,
                    `-    schedule="${x.from}",`,
                    `+    schedule="${x.to}",`,
                  ]),
                ].join('\n'),
              },
            ]
          : [],
        risks: [
          "A later start delays the DAG's results; check downstream consumers and deadlines.",
          'If many DAGs move to the same new minute, the collision moves with them; apply the offsets as a set.',
        ],
        rollback: 'Restore the previous schedule strings and redeploy the DAG files.',
        verify:
          `Over 7 days: the collision index (HM-009) falls below ${fmtPct(t.minCollisionIndex)} and waiting in the ` +
          `${t.windowMinutes} minutes from minute ${m} decreases (HM-006).`,
        affectedDags: colliding,
        docs: [DOCS.troubleshootingScheduling, DOCS.optimize, DOCS.dagRuns],
        detectedAt: last ?? s.to,
      },
    ]);
  },
};
