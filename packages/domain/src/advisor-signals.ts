/**
 * Environment signals the advisor rules read (spec §13.1 `inputs`), computed over one window from the
 * existing signal functions: HM-006 waiting attribution (one-minute buckets), HM-011 capacity,
 * HM-003 slot-seconds and HM-009 collision density, plus the per-scope details the first rules need:
 * pool starvation per DAG (REC-CONC-02), DAG self-throttling (HM-005, REC-DAG-01), worker load while
 * slots are full (HM-027, REC-CAP-05, REC-CAP-08) and sensor slot time by inferred mode (HM-008).
 *
 * @implements HM-005, HM-008, HM-011, HM-027
 */
import { attributeWaiting, capacityStats } from './attribution';
import {
  limitKnown,
  type DagMeta,
  type EnvironmentConfig,
  type LiveSnapshot,
  type WaitReasonId,
  type WorkerSample,
} from './model';
import { slotSeconds, type TaskTry } from './occupancy';
import { collisionDensity, type CollisionDensity } from './schedule';
import { quantile } from './stats';

const MINUTE = 60_000;
/** Worker samples arrive once per minute (`WorkerSample`). */
const SAMPLE_INTERVAL_MS = MINUTE;
/** HM-011: capacity-bound needs at least this many queued task instances… */
export const BOUND_MIN_QUEUED = 10;
/** …and at least this share of worker slots queued. */
export const BOUND_QUEUED_RATIO = 0.2;
/** REC-CAP-08 "slots mostly occupied" (⚠️ the spec does not quantify it): running ÷ slots. */
export const MOSTLY_OCCUPIED = 0.8;

/** A task instance try with the fields the advisor reads; `StoredTaskTry` satisfies it. */
export interface ObservedTry extends TaskTry {
  readonly queuedAt: number | null;
  readonly operator: string | null;
  readonly state: string | null;
}

export interface AdvisorInput {
  readonly config: EnvironmentConfig;
  readonly dags: readonly DagMeta[];
  /** Live snapshots, oldest first. */
  readonly snapshots: readonly LiveSnapshot[];
  /** One-minute worker samples, oldest first. */
  readonly workerSamples: readonly WorkerSample[];
  readonly tries: readonly ObservedTry[];
  readonly from: number;
  readonly to: number;
  /** Time each snapshot stands for (the `af.live` cadence). */
  readonly snapshotIntervalMs: number;
  /** Share of the window for which task-instance history is complete, 0–1. */
  readonly triesCoverage: number;
  /** Worker size, for the documented `worker_concurrency` guidance (REC-CAP-08); `null` when unknown. */
  readonly workerResources: { readonly cpu: number; readonly memoryGb: number } | null;
}

/** Worker load over the minutes in which a condition held. */
export interface WorkerMinutes {
  readonly minutes: number;
  /** Σ executor-queued task instances × minutes. */
  readonly queuedTaskMinutes: number;
  readonly queuedPeak: number;
  /** p95 of the highest worker CPU per minute, 0–1 (the max with fewer than 20 minutes, §8.9). */
  readonly cpuP95: number | null;
  readonly memoryP95: number | null;
  /** Mean running ÷ worker slots. */
  readonly utilisationMean: number | null;
  readonly last: number | null;
}

export interface Episode {
  readonly start: number;
  readonly end: number;
  readonly minutes: number;
}

export interface PoolSignal {
  readonly name: string;
  readonly slots: number;
  /** Time with zero open slots while work waited for the pool (as on the bottlenecks page). */
  readonly starvedMinutes: number;
  /** Snapshots in which the pool was starved. */
  readonly starvedObservations: number;
  /** Waiting attributed to this pool by HM-006 (the pool was the binding limit). */
  readonly bindingWaitingMs: number;
  /** Task-time waiting for the pool while it was starved, whatever limit HM-006 found first. */
  readonly waitingWhileStarvedMs: number;
  /** Per DAG: task-time waiting for the pool while it was starved, largest first. */
  readonly dagWaitingMs: ReadonlyMap<string, number>;
  /** Highest running + queued + ready demand on the pool in one snapshot, in slots. */
  readonly peakDemandSlots: number;
  readonly lastStarved: number | null;
}

export interface DagLimitSignal {
  readonly dagId: string;
  readonly limit: number;
  /** True when the DAG uses the environment default `max_active_tasks_per_dag`. */
  readonly limitIsDefault: boolean;
  /** Snapshots in which the DAG had running, queued or ready task instances. */
  readonly activeObservations: number;
  /** Snapshots at `max_active_tasks` with ready task instances of its own (HM-005). */
  readonly atLimitObservations: number;
  /** Task-time its own ready task instances waited while it was at the limit. */
  readonly ownWaitingMs: number;
  /** Highest running + queued + ready task instances of the DAG at the limit. */
  readonly peakDemand: number;
  /**
   * At-limit snapshots with free worker slots in the environment; `null` while `worker_concurrency` is
   * unknown (HM-032), because free slots cannot be told from full ones.
   */
  readonly headroomObservations: number | null;
  readonly lastAtLimit: number | null;
}

export type SensorMode = 'poke' | 'reschedule' | 'deferrable';

export interface SensorSignal {
  readonly dagId: string;
  readonly taskId: string;
  readonly operator: string;
  /** HM-008: observed `up_for_reschedule` means reschedule, `deferred` deferrable, otherwise poke. */
  readonly mode: SensorMode;
  /** Worker slot time held in the window. */
  readonly slotSeconds: number;
  readonly tries: number;
  readonly last: number;
}

export interface EnvironmentSignals {
  readonly config: EnvironmentConfig;
  readonly dags: ReadonlyMap<string, DagMeta>;
  readonly from: number;
  readonly to: number;
  readonly coverage: { readonly snapshots: number; readonly samples: number; readonly tries: number };
  readonly snapshotCount: number;
  /** Time each snapshot stands for. */
  readonly snapshotIntervalMs: number;
  readonly sampleCount: number;
  readonly waiting: {
    readonly totalsMs: ReadonlyMap<WaitReasonId, number>;
    /** Waiting attributed to platform limits (everything but normal latency). */
    readonly platformMs: number;
    readonly byReasonDag: ReadonlyMap<WaitReasonId, ReadonlyMap<string, number>>;
    /** Minutes in which each reason held at least one task instance. */
    readonly minutes: ReadonlyMap<WaitReasonId, number>;
    /** Start of the last minute in which each reason was seen. */
    readonly lastSeen: ReadonlyMap<WaitReasonId, number>;
    /** Platform waiting per UTC minute-of-hour (60 entries): task-time, minutes with waiting, last. */
    readonly byMinuteOfHour: {
      readonly waitingMs: readonly number[];
      readonly minutes: readonly number[];
      readonly last: ReadonlyArray<number | null>;
    };
  };
  readonly capacity: {
    readonly minutesAtMax: number;
    /** HM-011 capacity-bound minutes (as on the bottlenecks page); `null` while slots are unknown. */
    readonly capacityBoundMinutes: number | null;
    readonly bound: WorkerMinutes & {
      readonly episodes: readonly Episode[];
      /** p95 of running + queued task instances while bound. */
      readonly demandP95: number | null;
      /** Longest queued → running wait of tries queued in a bound minute. */
      readonly maxQueueWaitMs: number | null;
    };
    /** HM-006 reason 10 minutes: workers = `max_count`, slots full and work queued. */
    readonly slotsFullAtMax: WorkerMinutes;
    /** Workers below `max_count`, scale target not above them, slots mostly occupied (REC-CAP-08). */
    readonly scaleOutSuppressed: WorkerMinutes;
  };
  readonly workerResources: AdvisorInput['workerResources'];
  readonly pools: readonly PoolSignal[];
  /** HM-003 pool slot-seconds per pool. */
  readonly poolSlotSeconds: ReadonlyMap<string, number>;
  /** HM-003 executor slot-seconds per DAG. */
  readonly slotSecondsByDag: ReadonlyMap<string, number>;
  readonly dagLimits: readonly DagLimitSignal[];
  /** Sensors by slot time, largest first. */
  readonly sensors: readonly SensorSignal[];
  readonly schedules: CollisionDensity;
}

const add = <K>(m: Map<K, number>, k: K, d: number) => m.set(k, (m.get(k) ?? 0) + d);
const share = (part: number, whole: number) => (whole > 0 ? Math.min(1, part / whole) : 0);
const byValueDesc = (m: Map<string, number>) =>
  new Map([...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));

class WorkerMinutesBuilder {
  minutes = 0;
  queuedTaskMinutes = 0;
  queuedPeak = 0;
  last: number | null = null;
  readonly cpu: number[] = [];
  readonly memory: number[] = [];
  readonly utilisation: number[] = [];
  readonly demand: number[] = [];

  add(s: WorkerSample, span: number, slots: number) {
    this.minutes += span;
    this.queuedTaskMinutes += s.queued * span;
    this.queuedPeak = Math.max(this.queuedPeak, s.queued);
    this.cpu.push(s.cpu);
    this.memory.push(s.memory);
    this.utilisation.push(slots > 0 ? Math.min(1, s.running / slots) : 0);
    this.demand.push(s.running + s.queued);
    this.last = s.at;
  }

  build(): WorkerMinutes {
    const n = this.utilisation.length;
    return {
      minutes: this.minutes,
      queuedTaskMinutes: this.queuedTaskMinutes,
      queuedPeak: this.queuedPeak,
      cpuP95: quantile(this.cpu, 0.95).value,
      memoryP95: quantile(this.memory, 0.95).value,
      utilisationMean: n ? this.utilisation.reduce((a, b) => a + b, 0) / n : null,
      last: this.last,
    };
  }
}

function workerSignals(input: AdvisorInput, samples: readonly WorkerSample[]) {
  const { config } = input;
  // Without worker_concurrency, "slots full" and "queued ≥ 20 % of slots" cannot be checked (HM-032):
  // the minutes below stay empty and the rules that read them report insufficient data.
  const slotsKnown = limitKnown(config, 'workerConcurrency');
  const bound = new WorkerMinutesBuilder();
  const full = new WorkerMinutesBuilder();
  const suppressed = new WorkerMinutesBuilder();
  const episodes: Episode[] = [];
  const boundMinutes = new Set<number>();
  let open: { start: number; end: number; minutes: number } | null = null;

  samples.forEach((s, i) => {
    // A sample stands for at most one interval: a collection gap is unknown, never the last value.
    const span =
      Math.min((samples[i + 1]?.at ?? s.at + SAMPLE_INTERVAL_MS) - s.at, SAMPLE_INTERVAL_MS) / MINUTE;
    const slots = s.workers * config.workerConcurrency;
    const atMax = s.workers >= config.maxWorkers;
    if (!slotsKnown) return;
    const isBound = atMax && s.queued >= Math.max(BOUND_MIN_QUEUED, BOUND_QUEUED_RATIO * slots);
    if (isBound) {
      bound.add(s, span, slots);
      boundMinutes.add(Math.floor(s.at / MINUTE));
      if (open && s.at <= open.end + SAMPLE_INTERVAL_MS / 2) {
        open.end = s.at + span * MINUTE;
        open.minutes += span;
      } else {
        if (open) episodes.push(open);
        open = { start: s.at, end: s.at + span * MINUTE, minutes: span };
      }
    }
    if (atMax && slots > 0 && s.running >= slots && s.queued > 0) full.add(s, span, slots);
    if (!atMax && s.target <= s.workers && slots > 0 && s.running / slots >= MOSTLY_OCCUPIED)
      suppressed.add(s, span, slots);
  });
  if (open) episodes.push(open);

  let maxQueueWaitMs: number | null = null;
  for (const t of input.tries) {
    if (t.queuedAt === null || !boundMinutes.has(Math.floor(t.queuedAt / MINUTE))) continue;
    const wait = (t.startAt ?? input.to) - t.queuedAt;
    if (wait >= 0) maxQueueWaitMs = Math.max(maxQueueWaitMs ?? 0, wait);
  }
  const stats = capacityStats(samples, config);
  return {
    minutesAtMax: stats.minutesAtMax,
    capacityBoundMinutes: stats.capacityBoundMinutes,
    bound: {
      ...bound.build(),
      episodes,
      demandP95: quantile(bound.demand, 0.95).value,
      maxQueueWaitMs,
    },
    slotsFullAtMax: full.build(),
    scaleOutSuppressed: suppressed.build(),
  };
}

interface MutablePool {
  starvedObservations: number;
  waitingWhileStarvedMs: number;
  dagWaitingMs: Map<string, number>;
  peakDemandSlots: number;
  lastStarved: number | null;
}

interface MutableDagLimit {
  activeObservations: number;
  atLimitObservations: number;
  ownWaitingMs: number;
  peakDemand: number;
  headroomObservations: number | null;
  lastAtLimit: number | null;
}

/** Pool starvation and DAG self-throttling, read straight from the snapshots. */
function snapshotSignals(
  input: AdvisorInput,
  snapshots: readonly LiveSnapshot[],
  limits: Map<string, number>,
) {
  const { config, snapshotIntervalMs: interval } = input;
  const pools = new Map<string, MutablePool>(
    config.pools.map((p) => [
      p.name,
      {
        starvedObservations: 0,
        waitingWhileStarvedMs: 0,
        dagWaitingMs: new Map(),
        peakDemandSlots: 0,
        lastStarved: null,
      },
    ]),
  );
  const dags = new Map<string, MutableDagLimit>();
  const slotsKnown = limitKnown(config, 'workerConcurrency');

  for (const s of snapshots) {
    const readySlots = new Map<string, number>();
    const readyByDag = new Map<string, number>();
    for (const ti of s.scheduled) {
      add(readySlots, ti.pool, ti.poolSlots);
      add(readyByDag, ti.dagId, 1);
    }
    for (const p of s.pools) {
      const pool = pools.get(p.name);
      if (!pool) continue;
      const ready = readySlots.get(p.name) ?? 0;
      pool.peakDemandSlots = Math.max(pool.peakDemandSlots, p.running + p.queued + ready);
      if (p.open !== 0 || ready === 0) continue;
      pool.starvedObservations++;
      pool.lastStarved = s.at;
      for (const ti of s.scheduled) {
        if (ti.pool !== p.name) continue;
        pool.waitingWhileStarvedMs += interval;
        add(pool.dagWaitingMs, ti.dagId, interval);
      }
    }
    // Free worker slots are unknown without worker_concurrency (HM-032), never "free" by the placeholder.
    const freeSlots = slotsKnown && s.executor.running < s.workers.current * config.workerConcurrency;
    for (const dagId of new Set([...Object.keys(s.dagActive), ...readyByDag.keys()])) {
      const d = dags.get(dagId) ?? {
        activeObservations: 0,
        atLimitObservations: 0,
        ownWaitingMs: 0,
        peakDemand: 0,
        headroomObservations: slotsKnown ? 0 : null,
        lastAtLimit: null,
      };
      dags.set(dagId, d);
      d.activeObservations++;
      const active = s.dagActive[dagId] ?? 0;
      const ready = readyByDag.get(dagId) ?? 0;
      if (active < (limits.get(dagId) ?? config.maxActiveTasksPerDag) || ready === 0) continue;
      d.atLimitObservations++;
      d.ownWaitingMs += ready * interval;
      d.peakDemand = Math.max(d.peakDemand, active + ready);
      if (freeSlots && d.headroomObservations !== null) d.headroomObservations++;
      d.lastAtLimit = s.at;
    }
  }
  return { pools, dags };
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** HM-008: sensors are operators whose class name ends in `Sensor`. */
function sensorSignals(input: AdvisorInput): SensorSignal[] {
  const out = new Map<string, Mutable<SensorSignal>>();
  for (const t of input.tries) {
    if (!t.operator?.endsWith('Sensor') || t.startAt === null) continue;
    const key = `${t.dagId}\u0000${t.taskId}`;
    const s: Mutable<SensorSignal> = out.get(key) ?? {
      dagId: t.dagId,
      taskId: t.taskId,
      operator: t.operator,
      mode: 'poke',
      slotSeconds: 0,
      tries: 0,
      last: t.startAt,
    };
    out.set(key, s);
    const end = Math.min(t.endAt ?? input.to, input.to);
    const held = (end - Math.max(t.startAt, input.from)) / 1000;
    if (held > 0) s.slotSeconds += held;
    s.tries++;
    s.last = Math.max(s.last, end);
    if (t.state === 'deferred') s.mode = 'deferrable';
    else if (t.state === 'up_for_reschedule' && s.mode === 'poke') s.mode = 'reschedule';
  }
  return [...out.values()].filter((s) => s.slotSeconds > 0).sort((a, b) => b.slotSeconds - a.slotSeconds);
}

export function environmentSignals(input: AdvisorInput): EnvironmentSignals {
  const { config, from, to } = input;
  const windowMs = Math.max(1, to - from);
  const snapshots = input.snapshots.filter((s) => s.at >= from && s.at < to);
  const samples = input.workerSamples.filter((s) => s.at >= from && s.at < to);
  const limits = new Map(input.dags.map((d) => [d.dagId, d.maxActiveTasks]));

  // One-minute buckets aligned on UTC minutes, so that each bucket has one minute-of-hour.
  const a = attributeWaiting(
    snapshots,
    { config, dagMaxActiveTasks: limits },
    { from: Math.floor(from / MINUTE) * MINUTE, to, bucketMs: MINUTE, intervalMs: input.snapshotIntervalMs },
  );
  const minutes = new Map<WaitReasonId, number>();
  const lastSeen = new Map<WaitReasonId, number>();
  const hourWaiting = new Array<number>(60).fill(0);
  const hourMinutes = new Array<number>(60).fill(0);
  const hourLast = new Array<number | null>(60).fill(null);
  for (const b of a.buckets) {
    let platform = 0;
    for (const [reason, ms] of b.byReason) {
      if (ms <= 0) continue;
      add(minutes, reason, 1);
      lastSeen.set(reason, b.start);
      if (reason !== 'normal-latency') platform += ms;
    }
    if (platform === 0) continue;
    const m = Math.floor(b.start / MINUTE) % 60;
    hourWaiting[m] = (hourWaiting[m] ?? 0) + platform;
    hourMinutes[m] = (hourMinutes[m] ?? 0) + 1;
    hourLast[m] = b.start;
  }
  const platformMs = [...a.totals].reduce((s, [r, ms]) => (r === 'normal-latency' ? s : s + ms), 0);

  const raw = snapshotSignals(input, snapshots, limits);
  const occupancy = slotSeconds(input.tries, { from, to, now: to });

  return {
    config,
    dags: new Map(input.dags.map((d) => [d.dagId, d])),
    from,
    to,
    coverage: {
      snapshots: share(snapshots.length * input.snapshotIntervalMs, windowMs),
      samples: share(samples.length * SAMPLE_INTERVAL_MS, windowMs),
      tries: Math.min(1, Math.max(0, input.triesCoverage)),
    },
    snapshotCount: snapshots.length,
    snapshotIntervalMs: input.snapshotIntervalMs,
    sampleCount: samples.length,
    waiting: {
      totalsMs: a.totals,
      platformMs,
      byReasonDag: a.byReasonDag,
      minutes,
      lastSeen,
      byMinuteOfHour: { waitingMs: hourWaiting, minutes: hourMinutes, last: hourLast },
    },
    capacity: workerSignals(input, samples),
    workerResources: input.workerResources,
    pools: config.pools.map((p) => {
      const pressure = a.pools.get(p.name);
      const mine = raw.pools.get(p.name);
      return {
        name: p.name,
        slots: p.slots,
        starvedMinutes: (pressure?.starvedMs ?? 0) / MINUTE,
        starvedObservations: mine?.starvedObservations ?? 0,
        bindingWaitingMs: pressure?.waitingMs ?? 0,
        waitingWhileStarvedMs: mine?.waitingWhileStarvedMs ?? 0,
        dagWaitingMs: byValueDesc(mine?.dagWaitingMs ?? new Map<string, number>()),
        peakDemandSlots: mine?.peakDemandSlots ?? 0,
        lastStarved: mine?.lastStarved ?? null,
      };
    }),
    poolSlotSeconds: occupancy.byPool,
    slotSecondsByDag: new Map([...occupancy.byDag].map(([d, s]) => [d, s.executorSlotSeconds])),
    dagLimits: [...raw.dags]
      .filter(([, d]) => d.atLimitObservations > 0)
      .map(([dagId, d]) => ({
        dagId,
        limit: limits.get(dagId) ?? config.maxActiveTasksPerDag,
        limitIsDefault: (limits.get(dagId) ?? config.maxActiveTasksPerDag) === config.maxActiveTasksPerDag,
        ...d,
      }))
      .sort((x, y) => y.ownWaitingMs - x.ownWaitingMs),
    sensors: sensorSignals(input),
    schedules: collisionDensity(input.dags),
  };
}
