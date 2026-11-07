/**
 * The evidence behind the bottleneck answer (S-16, M3 demo steps 2–3), mapped from the domain to the
 * contract: top pools per reason (HM-006), pool activity (FR-ENV-08), noisy neighbours (HM-017) and
 * priority bands (HM-023). Durations leave the domain in ms and enter the contract in seconds or minutes,
 * as the field names say.
 *
 * @implements FR-BOTL-01, FR-BOTL-06, FR-ENV-08, HM-006, HM-017, HM-023
 */
import type { Bottlenecks, NoisyNeighbours, PriorityFairness } from '@dcam/contracts';
import {
  HM017_DEFAULTS,
  limitKnown,
  noisyNeighbours,
  slotsPerMinute,
  type EnvironmentConfig,
  type LiveSnapshot,
  type NeighbourTry,
  type PoolActivity,
  type PoolPriority,
  type WorkerSample,
} from '@dcam/domain';

type Pool = Bottlenecks['pools'][number];

const iso = (ms: number) => new Date(ms).toISOString();
const share = (part: number, whole: number) => (whole > 0 ? Math.min(1, part / whole) : 0);

/** HM-006 top contributors: the pools of the waiting task instances for one reason. */
export function topPools(byPool: ReadonlyMap<string, number> | undefined, totalMs: number) {
  return [...(byPool ?? new Map<string, number>())]
    .slice(0, 10)
    .map(([pool, ms]) => ({ pool, waiting_task_seconds: ms / 1000, share: share(ms, totalMs) }));
}

/** FR-ENV-08 fields of one pool. */
export function poolDetail(p: PoolActivity | undefined): Partial<Pool> {
  if (!p) return {};
  const waiting = p.readyTaskMs + p.queuedTaskMs;
  return {
    running_slots_avg: p.runningSlotsAvg,
    running_slots_peak: p.runningSlotsPeak,
    queued_slots_avg: p.queuedSlotsAvg,
    ready_task_seconds: p.readyTaskMs / 1000,
    queued_task_seconds: p.queuedTaskMs / 1000,
    top_dags: p.topDags.slice(0, 5).map((d) => ({
      dag_id: d.dagId,
      waiting_task_seconds: d.waitingMs / 1000,
      share: share(d.waitingMs, waiting),
    })),
    starved_series: p.starvedByBucket.map((ms) => (ms === null ? null : ms / 60_000)),
  };
}

export interface NeighbourInput {
  readonly config: EnvironmentConfig;
  readonly tries: readonly NeighbourTry[];
  readonly samples: readonly WorkerSample[];
  readonly snapshots: readonly LiveSnapshot[];
  readonly from: number;
  readonly to: number;
  readonly now: number;
}

/** HM-017 over the window, with the reason when it cannot be evaluated. */
export function noisyNeighboursIn(input: NeighbourInput): NoisyNeighbours {
  const slots = slotsPerMinute({ ...input, config: input.config });
  const r = noisyNeighbours({ tries: input.tries, slots, from: input.from, to: input.to, now: input.now });
  let notEvaluated: string | null = null;
  if (!r.evaluated)
    notEvaluated = !limitKnown(input.config, 'workerConcurrency')
      ? 'worker_concurrency is not known (no override in the Composer configuration), so DCAM cannot tell which DAGs hold 10 % of the executor slots. Set the override, or wait for HM-032 to infer it.'
      : 'No worker counts arrived in this range (Cloud Monitoring worker samples or live snapshots), so the executor slots are not known. Check the collectors on the DCAM health page.';
  return {
    method: 'HM-017/range',
    evaluated: r.evaluated,
    not_evaluated_reason: notEvaluated,
    minutes_with_slots: r.minutesWithSlots,
    candidates: r.candidates,
    qualified: r.qualified,
    active_share: HM017_DEFAULTS.activeShare,
    min_active_minutes: HM017_DEFAULTS.minActiveMinutes,
    min_affected_tries: HM017_DEFAULTS.minAffectedTries,
    min_control_tries: HM017_DEFAULTS.minControlTries,
    min_affected_minutes: HM017_DEFAULTS.minAffectedMinutes,
    resamples: r.resamples,
    items: r.items.map((x) => ({
      dag_id: x.dagId,
      active_minutes: x.activeMinutes,
      affected_tries: x.affectedTries,
      affected_minutes: x.affectedMinutes,
      control_tries: x.controlTries,
      matched_share: x.matchedShare,
      median_wait_active_seconds: x.medianActiveMs / 1000,
      median_wait_inactive_seconds: x.medianInactiveMs / 1000,
      effect_seconds: x.effectMs / 1000,
      ci_low_seconds: x.ci ? x.ci.lowMs / 1000 : null,
      ci_high_seconds: x.ci ? x.ci.highMs / 1000 : null,
      confidence: x.confidence,
      associated_wait_task_minutes: x.scoreTaskMs / 60_000,
      overlap_windows: x.overlapWindows.map((w) => ({ from: iso(w.from), to: iso(w.to) })),
    })),
  };
}

const STARVATION_BLOCKED =
  "The starvation ratio compares each band's p95 with its own 28-day median while higher bands ran. DCAM's snapshots list only waiting work, so when higher bands ran is not observed, and there is no 28-day baseline yet; it is not computed.";

/** HM-023, the observable part: observed waits per priority band within each pool. */
export function priorityFairnessOf(pools: readonly PoolPriority[]): PriorityFairness {
  const seconds = (ms: number | null) => (ms === null ? null : ms / 1000);
  return {
    method: 'HM-023/observed-wait',
    starvation_ratio_evaluated: false,
    not_evaluated_reason: STARVATION_BLOCKED,
    pools: pools.map((p) => ({
      pool: p.pool,
      tries: p.tries,
      distinct_weights: p.distinctWeights,
      bands: p.bands.map((b) => ({
        band: b.band,
        min_weight: b.minWeight,
        max_weight: b.maxWeight,
        tries: b.tries,
        wait_p50_seconds: seconds(b.waitP50.value),
        wait_p95_seconds: seconds(b.waitP95.value),
        p95_low_sample: b.waitP95.lowSample,
      })),
    })),
  };
}
