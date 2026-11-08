/**
 * DAG detail's concurrency (FR-DAGD-05, S-12 tab "concurrency") and impact (FR-DAGD-06) sections, mapped from the
 * domain to the contract. Durations leave the domain in ms and enter the contract in seconds, as the field names
 * say. HM-005 is the advisor's computation and REC-DAG-01 its condition; HM-017 is the bottlenecks page's, for one
 * DAG.
 *
 * @implements FR-DAGD-05, FR-DAGD-06, HM-003, HM-005, HM-011, HM-017, REC-DAG-01
 */
import type { DagConcurrency, DagImpact, DagNoisyNeighbour, FindingRef } from '@dcam/contracts';
import {
  HM017_DEFAULTS,
  RULE_THRESHOLDS,
  atLimitShare,
  loadShare,
  noisyNeighbourOf,
  raisesRecDag01,
  type ConcurrencyProfile,
  type DagLimitTotals,
  type DagMeta,
  type EnvironmentConfig,
  type EnvironmentLoad,
  type NeighbourScore,
  type NeighbourStatus,
  type NeighbourTry,
  type SweepWindow,
  type TaskTry,
  type WorkerCountSource,
} from '@dcam/domain';
import { neighbourNotEvaluatedReason, toNeighbourItem } from './bottlenecks-depth';

const iso = (ms: number) => new Date(ms).toISOString();
const isoOrNull = (ms: number | null) => (ms === null ? null : iso(ms));
const secondsOrNull = (ms: number | null) => (ms === null ? null : ms / 1000);

/** What DAG detail gathered from its store slices for the two sections. */
export interface DagDepthInput {
  readonly config: EnvironmentConfig;
  readonly meta: DagMeta;
  /** The DAG's tries around the range. */
  readonly dagTries: readonly TaskTry[];
  /** FR-DAGD-05 from the range's snapshots and the DAG's tries (domain `createConcurrencyProfile`). */
  readonly profile: ConcurrencyProfile;
  /** The environment's executor slot-seconds per bucket from the range start (domain `createEnvironmentLoad`). */
  readonly environment: EnvironmentLoad;
  /** Every DAG's tries of the range, the fields HM-017 reads: its evidence. */
  readonly neighbourTries: readonly NeighbourTry[];
  /** Executor slots per minute from the range start, and where their worker counts came from. */
  readonly slots: readonly (number | null)[];
  readonly slotsSource: WorkerCountSource | null;
  readonly window: SweepWindow;
  readonly bucketMs: number;
  readonly historyFrom: number | null;
  /** Findings about this DAG from the advisor (last 24 h). */
  readonly findings: readonly FindingRef[];
}

function selfThrottling(
  t: DagLimitTotals,
  findings: readonly FindingRef[],
): DagConcurrency['self_throttling'] {
  return {
    method: 'HM-005/snapshots',
    active_seconds: t.activeMs / 1000,
    at_limit_seconds: t.atLimitMs / 1000,
    at_limit_share: atLimitShare(t),
    own_waiting_task_seconds: t.ownWaitingMs / 1000,
    peak_demand: t.peakDemand,
    headroom_share:
      t.headroomObservations === null || t.atLimitObservations === 0
        ? null
        : t.headroomObservations / t.atLimitObservations,
    last_at_limit: isoOrNull(t.lastAtLimit),
    threshold: RULE_THRESHOLDS['REC-DAG-01'].minAtLimitShare,
    raises_rec_dag_01: raisesRecDag01(t),
    finding_id: findings.find((f) => f.rule_id === 'REC-DAG-01')?.id ?? null,
  };
}

/** FR-DAGD-05, and the HM-005 share the page's KPI shows. */
export function concurrencyOf(input: DagDepthInput): {
  readonly concurrency: DagConcurrency;
  readonly selfThrottledRatio: number | null;
} {
  const { meta, config, profile: p } = input;
  return {
    selfThrottledRatio: atLimitShare(p.selfThrottling),
    concurrency: {
      bucket_seconds: input.bucketMs / 1000,
      max_active_tasks: meta.maxActiveTasks,
      // As the advisor reads it: a DAG limit equal to the environment default is the default (REC-DAG-01).
      max_active_tasks_is_default: meta.maxActiveTasks === config.maxActiveTasksPerDag,
      limit_scope: 'dag',
      snapshots: p.snapshots,
      snapshot_interval_seconds: secondsOrNull(p.cadenceMs),
      peak_running: p.peakRunning,
      peak_in_flight: p.peakInFlight,
      series: p.buckets.map((b) => ({
        start: iso(b.start),
        running_avg: b.runningAvg,
        running_max: b.runningMax,
        in_flight_max: b.inFlightMax,
        ready_max: b.readyMax,
        at_limit_seconds: secondsOrNull(b.atLimitMs),
      })),
      pools: p.pools.map((x) => ({
        name: x.pool,
        slots: x.slots,
        pool_slots: x.poolSlots,
        dag_slots_max: [...x.dagSlotsMax],
        occupied_max: [...x.occupiedMax],
      })),
      self_throttling: selfThrottling(p.selfThrottling, input.findings),
    },
  };
}

const STATUS: Record<NeighbourStatus, DagNoisyNeighbour['status']> = {
  'not-evaluated': 'not_evaluated',
  inactive: 'inactive',
  'below-minimum': 'below_minimum',
  'not-associated': 'not_associated',
  associated: 'associated',
};

const pct = (x: number) => `${Math.round(x * 100)} %`;
const secs = (ms: number) => `${Math.round(ms / 1000)} s`;

/** What the HM-017 status means, in plain words, and what to do next (spec §12.12). */
function neighbourReason(s: NeighbourScore, config: EnvironmentConfig): string {
  const share = pct(HM017_DEFAULTS.activeShare);
  const n = s.neighbour;
  switch (s.status) {
    case 'not-evaluated':
      return neighbourNotEvaluatedReason(config);
    case 'inactive':
      return `This DAG never held ${share} of the executor slots in a minute of this range, so it cannot crowd out other DAGs' tasks this way. Nothing to do.`;
    case 'below-minimum':
      return (
        `This DAG held ${share} of the executor slots for ${s.activeMinutes} minutes; other DAGs queued ` +
        `${s.affectedTries} tries in those minutes and ${s.controlTries} at comparable times without it. DCAM needs ` +
        `${HM017_DEFAULTS.minActiveMinutes} minutes, ${HM017_DEFAULTS.minAffectedTries} and ` +
        `${HM017_DEFAULTS.minControlTries} tries, and tries in ${HM017_DEFAULTS.minAffectedMinutes} distinct minutes ` +
        'to score it. Widen the range to gather more evidence.'
      );
    case 'not-associated':
      return n
        ? `Other DAGs' tries did not wait longer while this DAG held ${share} or more of the executor slots: median ` +
            `queue wait ${secs(n.medianActiveMs)} against ${secs(n.medianInactiveMs)} at comparable times without it. ` +
            'Nothing to do.'
        : '';
    case 'associated':
      return n
        ? `Other DAGs' tries waited ${secs(n.effectMs)} longer (median) while this DAG held ${share} or more of the ` +
            `executor slots (95 % interval ${secs(n.ci?.lowMs ?? 0)} to ${secs(n.ci?.highMs ?? 0)}, ${n.confidence} ` +
            'confidence). The DAG is associated with longer queue waits, which is not proof that it causes them: ' +
            'check the overlap windows, then consider a pool of its own or a start time away from them.'
        : '';
  }
}

/** FR-DAGD-06: share of the environment's load per bucket, and the HM-017 score of the DAG. */
export function impactOf(input: DagDepthInput): DagImpact {
  const { window: w, config, slots, slotsSource } = input;
  const share = loadShare({
    dagTries: input.dagTries,
    environment: input.environment,
    window: w,
    bucketMs: input.bucketMs,
    historyFrom: input.historyFrom,
    slots,
  });
  const score = noisyNeighbourOf(
    { tries: input.neighbourTries, slots, from: w.from, to: w.to, now: w.now },
    input.meta.dagId,
  );
  return {
    bucket_seconds: input.bucketMs / 1000,
    slots_source: slotsSource,
    series: share.map((b) => ({
      start: iso(b.start),
      dag_slot_seconds: b.dagSlotSeconds,
      environment_slot_seconds: b.environmentSlotSeconds,
      share: b.share,
      capacity_share: b.capacityShare,
    })),
    noisy_neighbour: {
      method: 'HM-017/range',
      status: STATUS[score.status],
      reason: neighbourReason(score, config),
      minutes_with_slots: score.minutesWithSlots,
      active_minutes: score.activeMinutes,
      affected_tries: score.affectedTries,
      affected_minutes: score.affectedMinutes,
      control_tries: score.controlTries,
      active_share: HM017_DEFAULTS.activeShare,
      min_active_minutes: HM017_DEFAULTS.minActiveMinutes,
      min_affected_tries: HM017_DEFAULTS.minAffectedTries,
      min_affected_minutes: HM017_DEFAULTS.minAffectedMinutes,
      min_control_tries: HM017_DEFAULTS.minControlTries,
      resamples: score.resamples,
      slots_source: slotsSource,
      score: score.neighbour ? toNeighbourItem(score.neighbour) : null,
    },
  };
}
