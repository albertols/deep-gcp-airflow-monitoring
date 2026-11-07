/**
 * Environment capacity over a window (S-04, FR-ENV-02): worker slots against use, queued work, workers against
 * `min_count` and `max_count`, scale events, worker CPU and memory, a UTC day × hour saturation heatmap, and the
 * capacity-bound periods FR-ENV-02 highlights.
 *
 * - **Per minute** the worker figures come from the Cloud Monitoring worker sample (HM-011 `SRC-MON`), else from
 *   the last live snapshot in the minute, whose count says where it came from (`monitoring`, `config`, or
 *   `hostnames`, a lower bound: `WorkerCountSource`). A minute with neither is a gap, never zero (NFR-DATA-03).
 * - **Capacity-bound** (HM-011): workers = `max_count` and queued ≥ max(10, 20 % of workers × `worker_concurrency`),
 *   the condition `capacityStats` and REC-CAP-01 use. With `worker_concurrency` unknown (HM-032) slots,
 *   utilisation and capacity-bound minutes are `null`: the threshold depends on the slots.
 * - **Scale events and lags** (HM-012) come from Cloud Monitoring samples only: hostname counts drop whenever a
 *   worker is idle, so their changes are not scale events.
 * - **Running tries** cross-check the executor count with task history (HM-011 "cross-checked with live running
 *   task instances"): the HM-003 sweep, one slot per running try. Before the history starts they are `null`.
 *
 * @implements FR-ENV-02, HM-011, HM-012, NFR-DATA-03
 */
import { BOUND_MIN_QUEUED, BOUND_QUEUED_RATIO } from './advisor-signals';
import { capacityStats } from './attribution';
import {
  limitKnown,
  type EnvironmentConfig,
  type LiveSnapshot,
  type WorkerCountSource,
  type WorkerSample,
} from './model';
import { TOTAL_KEY, occupancySeries, type TaskTry } from './occupancy';
import { spreadOf, type Spread } from './stats';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** The newest scale events kept; the counts cover every event. */
export const MAX_SCALE_EVENTS = 200;

export interface CapacityInput {
  readonly config: EnvironmentConfig;
  /** One-minute Cloud Monitoring worker samples, oldest first. */
  readonly samples: readonly WorkerSample[];
  /** Live snapshots, oldest first: the worker figures of minutes without a sample. */
  readonly snapshots: readonly LiveSnapshot[];
  /** Task tries that overlap the window (the running-tries cross-check). */
  readonly tries: readonly TaskTry[];
  /** Window start (epoch ms), a whole number of `bucketMs` since the epoch, so buckets align to UTC. */
  readonly from: number;
  /** Window end, "now": tries still running end here. */
  readonly to: number;
  /** A whole number of minutes. */
  readonly bucketMs: number;
  /** Where the environment's task history starts (`null`: none); absent means it covers the window. */
  readonly historyFrom?: number | null;
}

export interface CapacityBucket {
  readonly start: number;
  /** Minutes of the bucket with worker figures; every other field is `null` when 0. */
  readonly observedMinutes: number;
  readonly workersMean: number | null;
  readonly workersMax: number | null;
  /** Highest autoscaler target. */
  readonly targetMax: number | null;
  /** Mean workers × `worker_concurrency`; `null` while the concurrency is unknown. */
  readonly slotsMean: number | null;
  /** Running task instances (executor count). */
  readonly runningMean: number | null;
  readonly runningPeak: number | null;
  /** Executor-queued task instances. */
  readonly queuedMean: number | null;
  readonly queuedPeak: number | null;
  /** Mean of running ÷ slots per minute, 0–1. */
  readonly utilisationMean: number | null;
  readonly atMaxMinutes: number | null;
  readonly boundMinutes: number | null;
  /** Highest worker CPU and memory utilisation (usage ÷ limit), from samples only. */
  readonly cpuMax: number | null;
  readonly memoryMax: number | null;
  /** Mean running tries from task history (HM-003 sweep); `null` before the history starts. */
  readonly runningTriesMean: number | null;
}

export interface CapacityBoundPeriod {
  readonly start: number;
  /** Exclusive: the end of the last bound minute. */
  readonly end: number;
  readonly minutes: number;
  readonly queuedPeak: number;
  readonly workers: number;
}

export interface ScaleEvent {
  readonly at: number;
  readonly from: number;
  readonly to: number;
}

export interface SaturationCell {
  /** UTC midnight of the day (epoch ms). */
  readonly day: number;
  /** UTC hour, 0–23. */
  readonly hour: number;
  readonly observedMinutes: number;
  readonly utilisationMean: number | null;
  readonly atMaxMinutes: number | null;
  readonly boundMinutes: number | null;
}

export interface CapacityAnalysis {
  readonly slotsKnown: boolean;
  /** The weakest source over the minutes whose worker count says where it came from; `null` if none does. */
  readonly slotsSource: WorkerCountSource | null;
  readonly windowMinutes: number;
  readonly observedMinutes: number;
  /** Start of the newest minute with worker figures. */
  readonly latest: number | null;
  readonly threshold: { readonly minQueued: number; readonly queuedRatio: number };
  readonly buckets: readonly CapacityBucket[];
  /** Running ÷ slots per observed minute. */
  readonly utilisation: Spread;
  readonly minutesAtMax: number | null;
  readonly boundMinutes: number | null;
  readonly runningPeak: number | null;
  readonly queuedPeak: number | null;
  readonly periods: readonly CapacityBoundPeriod[];
  readonly scaleEvents: {
    readonly evaluated: boolean;
    readonly up: number;
    readonly down: number;
    /** The newest {@link MAX_SCALE_EVENTS}, oldest first. */
    readonly items: readonly ScaleEvent[];
  };
  /** HM-012: seconds from the autoscaler target rising above the workers to the workers reaching it. */
  readonly scaleUpLag: Spread;
  readonly heatmap: readonly SaturationCell[];
  /** The Celery worker workload: CPU and memory utilisation (usage ÷ limit) per sampled minute. */
  readonly worker: { readonly cpu: Spread; readonly memory: Spread; readonly samples: number };
}

interface Minute {
  readonly workers: number;
  readonly target: number;
  readonly running: number;
  readonly queued: number;
  readonly cpu: number | null;
  readonly memory: number | null;
  readonly source: WorkerCountSource | null;
}

/** From the most to the least reliable worker count. */
const SOURCE_ORDER: readonly WorkerCountSource[] = ['monitoring', 'config', 'hostnames'];

class Acc {
  n = 0;
  workers = 0;
  workersMax = 0;
  targetMax = 0;
  running = 0;
  runningPeak = 0;
  queued = 0;
  queuedPeak = 0;
  utilisation = 0;
  atMax = 0;
  bound = 0;
  cpuMax: number | null = null;
  memoryMax: number | null = null;

  add(m: Minute, utilisation: number | null, atMax: boolean, bound: boolean) {
    this.n++;
    this.workers += m.workers;
    this.workersMax = Math.max(this.workersMax, m.workers);
    this.targetMax = Math.max(this.targetMax, m.target);
    this.running += m.running;
    this.runningPeak = Math.max(this.runningPeak, m.running);
    this.queued += m.queued;
    this.queuedPeak = Math.max(this.queuedPeak, m.queued);
    this.utilisation += utilisation ?? 0;
    if (atMax) this.atMax++;
    if (bound) this.bound++;
    if (m.cpu !== null) this.cpuMax = Math.max(this.cpuMax ?? 0, m.cpu);
    if (m.memory !== null) this.memoryMax = Math.max(this.memoryMax ?? 0, m.memory);
  }
}

/** The worker figures of each minute of the window: the sample, else the last snapshot in it, else `null`. */
function minutesOf(input: CapacityInput): (Minute | null)[] {
  const count = Math.max(0, Math.ceil((input.to - input.from) / MIN));
  const out = new Array<Minute | null>(count).fill(null);
  const index = (at: number) => {
    if (at < input.from || at >= input.to) return -1;
    return Math.floor((at - input.from) / MIN);
  };
  for (const s of input.snapshots) {
    const k = index(s.at);
    if (k < 0) continue;
    const source = s.workers.source;
    out[k] = {
      workers: s.workers.current,
      target: s.workers.target,
      running: s.executor.running,
      queued: s.executor.queued,
      cpu: null,
      memory: null,
      source: source !== undefined && SOURCE_ORDER.includes(source) ? source : null,
    };
  }
  for (const s of input.samples) {
    const k = index(s.at);
    if (k < 0) continue;
    out[k] = {
      workers: s.workers,
      target: s.target,
      running: s.running,
      queued: s.queued,
      cpu: s.cpu,
      memory: s.memory,
      source: 'monitoring',
    };
  }
  return out;
}

/** Mean running tries per bucket from task history; `null` for buckets the history does not reach. */
function runningTries(input: CapacityInput): (number | null)[] {
  const { from, to, bucketMs } = input;
  const covered = input.historyFrom === undefined ? from : input.historyFrom;
  const series = occupancySeries(input.tries, { from, to, now: to }, { bucketMs }).get(TOTAL_KEY) ?? [];
  return series.map((b) => {
    if (covered === null) return null;
    const end = Math.min(b.start + bucketMs, to);
    const coveredFrom = Math.max(b.start, covered);
    if (coveredFrom >= end) return null;
    // The sweep averages over the whole bucket; the part before the history is unknown, not idle.
    return (b.avg * (end - b.start)) / (end - coveredFrom);
  });
}

export function capacityAnalysis(input: CapacityInput): CapacityAnalysis {
  const { config, from, to, bucketMs } = input;
  if (!Number.isInteger(bucketMs / MIN) || bucketMs <= 0)
    throw new RangeError(`bucketMs must be a whole number of minutes, not ${bucketMs}`);
  const slotsKnown = limitKnown(config, 'workerConcurrency');
  const minutes = minutesOf(input);
  const bucketCount = Math.max(0, Math.ceil((to - from) / bucketMs));
  const buckets = Array.from({ length: bucketCount }, () => new Acc());
  const hourFrom = Math.floor(from / HOUR) * HOUR;
  const cells = Array.from({ length: Math.max(0, Math.ceil((to - hourFrom) / HOUR)) }, () => new Acc());
  const utilisation: number[] = [];
  const cpu: number[] = [];
  const memory: number[] = [];
  const periods: CapacityBoundPeriod[] = [];
  let open: { start: number; end: number; minutes: number; queuedPeak: number; workers: number } | null =
    null;
  let observed = 0;
  let atMaxTotal = 0;
  let boundTotal = 0;
  let runningPeak: number | null = null;
  let queuedPeak: number | null = null;
  let latest: number | null = null;
  let weakest = -1;

  minutes.forEach((m, k) => {
    if (!m) return;
    const at = from + k * MIN;
    const slots = m.workers * config.workerConcurrency;
    const u = slotsKnown ? (slots > 0 ? Math.min(1, m.running / slots) : 0) : null;
    const atMax = m.workers >= config.maxWorkers;
    const bound = slotsKnown && atMax && m.queued >= Math.max(BOUND_MIN_QUEUED, BOUND_QUEUED_RATIO * slots);
    buckets[Math.floor((at - from) / bucketMs)]?.add(m, u, atMax, bound);
    cells[Math.floor((at - hourFrom) / HOUR)]?.add(m, u, atMax, bound);
    observed++;
    latest = at;
    if (u !== null) utilisation.push(u);
    if (m.cpu !== null) cpu.push(m.cpu);
    if (m.memory !== null) memory.push(m.memory);
    if (atMax) atMaxTotal++;
    runningPeak = Math.max(runningPeak ?? 0, m.running);
    queuedPeak = Math.max(queuedPeak ?? 0, m.queued);
    if (m.source !== null) weakest = Math.max(weakest, SOURCE_ORDER.indexOf(m.source));
    if (!bound) {
      if (open) periods.push(open);
      open = null;
      return;
    }
    boundTotal++;
    if (open && open.end === at) {
      open.end = at + MIN;
      open.minutes++;
      open.queuedPeak = Math.max(open.queuedPeak, m.queued);
      open.workers = Math.max(open.workers, m.workers);
    } else {
      if (open) periods.push(open);
      open = { start: at, end: at + MIN, minutes: 1, queuedPeak: m.queued, workers: m.workers };
    }
  });
  if (open) periods.push(open);

  const inWindow = input.samples.filter((s) => s.at >= from && s.at < to);
  const events: ScaleEvent[] = [];
  let up = 0;
  let down = 0;
  inWindow.forEach((s, i) => {
    const previous = inWindow[i - 1];
    if (!previous || previous.workers === s.workers) return;
    if (s.workers > previous.workers) up++;
    else down++;
    events.push({ at: s.at, from: previous.workers, to: s.workers });
  });

  const tries = runningTries(input);
  const mean = (sum: number, n: number) => (n > 0 ? sum / n : null);
  const ifSlots = (x: number | null) => (slotsKnown ? x : null);
  return {
    slotsKnown,
    slotsSource: weakest < 0 ? null : (SOURCE_ORDER[weakest] as WorkerCountSource),
    windowMinutes: minutes.length,
    observedMinutes: observed,
    latest,
    threshold: { minQueued: BOUND_MIN_QUEUED, queuedRatio: BOUND_QUEUED_RATIO },
    buckets: buckets.map((b, i): CapacityBucket => {
      const has = b.n > 0;
      const workersMean = mean(b.workers, b.n);
      return {
        start: from + i * bucketMs,
        observedMinutes: b.n,
        workersMean,
        workersMax: has ? b.workersMax : null,
        targetMax: has ? b.targetMax : null,
        slotsMean: ifSlots(workersMean === null ? null : workersMean * config.workerConcurrency),
        runningMean: mean(b.running, b.n),
        runningPeak: has ? b.runningPeak : null,
        queuedMean: mean(b.queued, b.n),
        queuedPeak: has ? b.queuedPeak : null,
        utilisationMean: ifSlots(mean(b.utilisation, b.n)),
        atMaxMinutes: has ? b.atMax : null,
        boundMinutes: has ? ifSlots(b.bound) : null,
        cpuMax: b.cpuMax,
        memoryMax: b.memoryMax,
        runningTriesMean: tries[i] ?? null,
      };
    }),
    utilisation: spreadOf(utilisation),
    minutesAtMax: observed > 0 ? atMaxTotal : null,
    boundMinutes: observed > 0 ? ifSlots(boundTotal) : null,
    runningPeak,
    queuedPeak,
    periods,
    scaleEvents: {
      evaluated: inWindow.length > 0,
      up,
      down,
      items: events.slice(-MAX_SCALE_EVENTS),
    },
    scaleUpLag: spreadOf(capacityStats(inWindow, config).scaleUpLagsSeconds),
    heatmap: cells.map((c, i): SaturationCell => {
      const start = hourFrom + i * HOUR;
      const day = Math.floor(start / DAY) * DAY;
      const has = c.n > 0;
      return {
        day,
        hour: Math.round((start - day) / HOUR),
        observedMinutes: c.n,
        utilisationMean: ifSlots(mean(c.utilisation, c.n)),
        atMaxMinutes: has ? c.atMax : null,
        boundMinutes: has ? ifSlots(c.bound) : null,
      };
    }),
    worker: { cpu: spreadOf(cpu), memory: spreadOf(memory), samples: cpu.length },
  };
}
